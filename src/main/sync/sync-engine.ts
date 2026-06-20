import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDataDir, getDb } from '../db/database'
import { flushSettingsSync, replaceSettingsForSync } from '../ipc/settings-handlers'
import { writeConfig } from '../ipc/secure-key-store'
import { safeSendToAllWindows } from '../window-ipc'
import {
  getActiveSyncProvider,
  patchSyncConfig,
  readSyncConfig,
  writeSyncConfig
} from './sync-config'
import { RemoteStateChangedError, WebDavProvider, type RemoteBundleState } from './webdav-provider'
import type {
  SyncBundle,
  SyncBundleManifest,
  SyncConflict,
  SyncConflictResolution,
  SyncProviderConfig,
  SyncProviderDescriptor,
  SyncRecord,
  SyncRunMode,
  SyncRunStatus,
  SyncRunSummary,
  SyncStatus,
  SyncTombstone
} from '../../shared/sync-types'

const SYNC_SCHEMA_VERSION = 1
const KEY_SEPARATOR = '\u0000'
const FILE_DOMAIN = 'file'
const DATA_FILE_INCLUDES = [
  'settings.json',
  'config.json',
  'plugins.json',
  'SOUL.md',
  'USER.md',
  'MEMORY.md'
]
const DATA_DIR_INCLUDES = ['agents', 'commands', 'prompts', 'memory']

interface DbTableSchema {
  name: string
  columns: string[]
  pkColumns: string[]
  dependencies: string[]
}

interface BaselineRecordState {
  domain: string
  recordId: string
  contentHash: string
}

interface LocalSnapshot {
  records: Map<string, SyncRecord>
  tombstones: Map<string, SyncTombstone>
  baseline: Map<string, BaselineRecordState>
  tableSchemas: Map<string, DbTableSchema>
  upsertTableOrder: string[]
}

interface MergeResult {
  finalRecords: Map<string, SyncRecord>
  finalTombstones: Map<string, SyncTombstone>
  recordsToApply: Map<string, SyncRecord>
  recordsToDelete: Map<string, SyncTombstone>
  conflicts: SyncConflict[]
  uploadedRecords: number
  downloadedRecords: number
  deletedRecords: number
}

interface PendingConflictState {
  runId: string
  provider: SyncProviderConfig
  mode: SyncRunMode
  local: LocalSnapshot
  remote: RemoteBundleState
  merge: MergeResult
  startedAt: number
}

function recordKey(domain: string, recordId: string): string {
  return `${domain}${KEY_SEPARATOR}${recordId}`
}

function splitRecordKey(key: string): { domain: string; recordId: string } {
  const index = key.indexOf(KEY_SEPARATOR)
  return {
    domain: key.slice(0, index),
    recordId: key.slice(index + KEY_SEPARATOR.length)
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeRecordId(pkValues: unknown[]): string {
  return JSON.stringify(pkValues)
}

function parseRecordId(recordId: string): unknown[] {
  const parsed = JSON.parse(recordId) as unknown
  return Array.isArray(parsed) ? parsed : [parsed]
}

function dbDomain(tableName: string): string {
  return `db:${tableName}`
}

function tableFromDomain(domain: string): string | null {
  return domain.startsWith('db:') ? domain.slice(3) : null
}

function getRecordUpdatedAt(row: Record<string, unknown>): number | null {
  const updatedAt = row.updated_at
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) return updatedAt
  const createdAt = row.created_at
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt
  return null
}

function getDataRelativePath(filePath: string): string | null {
  const relativePath = path.relative(getDataDir(), filePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  return relativePath.replace(/\\/g, '/')
}

function resolveDataRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null
  return path.join(getDataDir(), ...normalized.split('/'))
}

function shouldIncludeDataRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  if (DATA_FILE_INCLUDES.includes(normalized)) return true
  return DATA_DIR_INCLUDES.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))
}

function walkFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return []
  const stat = fs.statSync(rootPath)
  if (stat.isFile()) return [rootPath]
  if (!stat.isDirectory()) return []

  const files: string[] = []
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const childPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(childPath))
    } else if (entry.isFile()) {
      files.push(childPath)
    }
  }
  return files
}

function listSyncTableSchemas(db: Database.Database): Map<string, DbTableSchema> {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'sync_%'
       ORDER BY name ASC`
    )
    .all() as Array<{ name: string }>

  const schemas = new Map<string, DbTableSchema>()
  for (const row of rows) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(row.name)})`).all() as Array<{
      name: string
      pk: number
    }>
    const pkColumns = columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name)
    if (pkColumns.length === 0) continue

    const dependencies = db
      .prepare(`PRAGMA foreign_key_list(${quoteIdent(row.name)})`)
      .all() as Array<{
      table: string
    }>
    schemas.set(row.name, {
      name: row.name,
      columns: columns.map((column) => column.name),
      pkColumns,
      dependencies: Array.from(new Set(dependencies.map((dependency) => dependency.table)))
    })
  }
  return schemas
}

function sortTablesForUpsert(schemas: Map<string, DbTableSchema>): string[] {
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const ordered: string[] = []

  const visit = (tableName: string): void => {
    if (visited.has(tableName)) return
    if (visiting.has(tableName)) return
    visiting.add(tableName)
    const schema = schemas.get(tableName)
    for (const dependency of schema?.dependencies ?? []) {
      if (schemas.has(dependency)) visit(dependency)
    }
    visiting.delete(tableName)
    visited.add(tableName)
    ordered.push(tableName)
  }

  for (const tableName of schemas.keys()) {
    visit(tableName)
  }
  return ordered
}

function loadBaseline(providerId: string): Map<string, BaselineRecordState> {
  const rows = getDb()
    .prepare(
      `SELECT domain, record_id, content_hash
       FROM sync_record_state
       WHERE provider_id = ?`
    )
    .all(providerId) as Array<{
    domain: string
    record_id: string
    content_hash: string
  }>

  return new Map(
    rows.map((row) => [
      recordKey(row.domain, row.record_id),
      {
        domain: row.domain,
        recordId: row.record_id,
        contentHash: row.content_hash
      }
    ])
  )
}

function loadLocalTombstones(providerId: string): Map<string, SyncTombstone> {
  const rows = getDb()
    .prepare(
      `SELECT domain, record_id, deleted_at, origin_device_id
       FROM sync_tombstones
       WHERE provider_id = ?`
    )
    .all(providerId) as Array<{
    domain: string
    record_id: string
    deleted_at: number
    origin_device_id: string
  }>

  return new Map(
    rows.map((row) => [
      recordKey(row.domain, row.record_id),
      {
        domain: row.domain,
        recordId: row.record_id,
        deletedAt: row.deleted_at,
        originDeviceId: row.origin_device_id
      }
    ])
  )
}

function captureDbRecords(schemas: Map<string, DbTableSchema>): SyncRecord[] {
  const db = getDb()
  const records: SyncRecord[] = []
  for (const schema of schemas.values()) {
    const orderBy = schema.pkColumns.map(quoteIdent).join(', ')
    const rows = db
      .prepare(`SELECT * FROM ${quoteIdent(schema.name)} ORDER BY ${orderBy}`)
      .all() as Record<string, unknown>[]
    for (const row of rows) {
      const recordId = normalizeRecordId(schema.pkColumns.map((column) => row[column]))
      const value = {
        table: schema.name,
        row
      }
      records.push({
        domain: dbDomain(schema.name),
        recordId,
        hash: hashValue(value),
        value,
        updatedAt: getRecordUpdatedAt(row)
      })
    }
  }
  return records
}

function captureFileRecords(): SyncRecord[] {
  const dataDir = getDataDir()
  const candidates = [
    ...DATA_FILE_INCLUDES.map((fileName) => path.join(dataDir, fileName)),
    ...DATA_DIR_INCLUDES.map((dirName) => path.join(dataDir, dirName))
  ]
  const filePaths = Array.from(new Set(candidates.flatMap(walkFiles)))
  const records: SyncRecord[] = []

  for (const filePath of filePaths) {
    const relativePath = getDataRelativePath(filePath)
    if (!relativePath || !shouldIncludeDataRelativePath(relativePath)) continue
    const stat = fs.statSync(filePath)
    const value = {
      path: relativePath,
      data: fs.readFileSync(filePath).toString('base64')
    }
    records.push({
      domain: FILE_DOMAIN,
      recordId: relativePath,
      hash: hashValue(value),
      value,
      updatedAt: Math.floor(stat.mtimeMs)
    })
  }
  return records
}

function captureLocalSnapshot(providerId: string, deviceId: string): LocalSnapshot {
  flushSettingsSync()
  const tableSchemas = listSyncTableSchemas(getDb())
  const records = new Map<string, SyncRecord>()
  for (const record of [...captureDbRecords(tableSchemas), ...captureFileRecords()]) {
    records.set(recordKey(record.domain, record.recordId), record)
  }

  const baseline = loadBaseline(providerId)
  const tombstones = loadLocalTombstones(providerId)
  const now = Date.now()
  for (const [key, state] of baseline) {
    if (records.has(key) || tombstones.has(key)) continue
    tombstones.set(key, {
      domain: state.domain,
      recordId: state.recordId,
      deletedAt: now,
      originDeviceId: deviceId
    })
  }

  return {
    records,
    tombstones,
    baseline,
    tableSchemas,
    upsertTableOrder: sortTablesForUpsert(tableSchemas)
  }
}

function bundleToRecordMap(bundle: SyncBundle | null): Map<string, SyncRecord> {
  const map = new Map<string, SyncRecord>()
  for (const record of bundle?.records ?? []) {
    map.set(recordKey(record.domain, record.recordId), record)
  }
  return map
}

function bundleToTombstoneMap(bundle: SyncBundle | null): Map<string, SyncTombstone> {
  const map = new Map<string, SyncTombstone>()
  for (const tombstone of bundle?.tombstones ?? []) {
    map.set(recordKey(tombstone.domain, tombstone.recordId), tombstone)
  }
  return map
}

function chooseNewestTombstone(
  left: SyncTombstone | undefined,
  right: SyncTombstone | undefined
): SyncTombstone | undefined {
  if (!left) return right
  if (!right) return left
  return right.deletedAt > left.deletedAt ? right : left
}

function buildConflict(
  kind: SyncConflict['kind'],
  key: string,
  local: SyncRecord | undefined,
  remote: SyncRecord | undefined,
  baselineHash: string | undefined,
  localDeleted: boolean,
  remoteDeleted: boolean
): SyncConflict {
  const { domain, recordId } = splitRecordKey(key)
  return {
    id: createHash('sha256').update(`${kind}:${key}`).digest('hex'),
    kind,
    domain,
    recordId,
    localHash: local?.hash ?? null,
    remoteHash: remote?.hash ?? null,
    baselineHash: baselineHash ?? null,
    localValue: local?.value,
    remoteValue: remote?.value,
    localDeleted,
    remoteDeleted
  }
}

function mergeThreeWay(local: LocalSnapshot, remoteBundle: SyncBundle | null): MergeResult {
  const remoteRecords = bundleToRecordMap(remoteBundle)
  const remoteTombstones = bundleToTombstoneMap(remoteBundle)
  const finalRecords = new Map(local.records)
  const finalTombstones = new Map(local.tombstones)
  const recordsToApply = new Map<string, SyncRecord>()
  const recordsToDelete = new Map<string, SyncTombstone>()
  const conflicts: SyncConflict[] = []
  let downloadedRecords = 0
  let deletedRecords = 0

  for (const [key, remoteTombstone] of remoteTombstones) {
    finalTombstones.set(key, chooseNewestTombstone(finalTombstones.get(key), remoteTombstone)!)
  }

  const keys = new Set([
    ...local.baseline.keys(),
    ...local.records.keys(),
    ...remoteRecords.keys(),
    ...local.tombstones.keys(),
    ...remoteTombstones.keys()
  ])

  for (const key of keys) {
    const localRecord = local.records.get(key)
    const remoteRecord = remoteRecords.get(key)
    const baselineHash = local.baseline.get(key)?.contentHash
    const localTombstone = local.tombstones.get(key)
    const remoteTombstone = remoteTombstones.get(key)
    const localDeleted = Boolean(localTombstone || (baselineHash && !localRecord))
    const remoteDeleted = Boolean(remoteTombstone && !remoteRecord)

    if (localRecord && remoteRecord) {
      if (localRecord.hash === remoteRecord.hash) {
        finalRecords.set(key, localRecord)
        finalTombstones.delete(key)
      } else if (baselineHash === localRecord.hash) {
        finalRecords.set(key, remoteRecord)
        finalTombstones.delete(key)
        recordsToApply.set(key, remoteRecord)
        downloadedRecords += 1
      } else if (baselineHash === remoteRecord.hash) {
        finalRecords.set(key, localRecord)
        finalTombstones.delete(key)
      } else {
        conflicts.push(
          buildConflict('modify-modify', key, localRecord, remoteRecord, baselineHash, false, false)
        )
      }
      continue
    }

    if (localRecord && !remoteRecord) {
      if (remoteDeleted) {
        if (baselineHash && localRecord.hash !== baselineHash) {
          conflicts.push(
            buildConflict('delete-modify', key, localRecord, undefined, baselineHash, false, true)
          )
        } else {
          finalRecords.delete(key)
          finalTombstones.set(key, remoteTombstone!)
          recordsToDelete.set(key, remoteTombstone!)
          deletedRecords += 1
        }
      } else {
        finalRecords.set(key, localRecord)
        finalTombstones.delete(key)
      }
      continue
    }

    if (!localRecord && remoteRecord) {
      if (localDeleted) {
        if (baselineHash && remoteRecord.hash !== baselineHash) {
          conflicts.push(
            buildConflict('delete-modify', key, undefined, remoteRecord, baselineHash, true, false)
          )
        } else {
          finalRecords.delete(key)
          finalTombstones.set(key, localTombstone!)
        }
      } else {
        finalRecords.set(key, remoteRecord)
        finalTombstones.delete(key)
        recordsToApply.set(key, remoteRecord)
        downloadedRecords += 1
      }
      continue
    }

    if (!localRecord && !remoteRecord) {
      const tombstone = chooseNewestTombstone(localTombstone, remoteTombstone)
      if (tombstone) {
        finalRecords.delete(key)
        finalTombstones.set(key, tombstone)
      }
    }
  }

  for (const key of finalRecords.keys()) {
    finalTombstones.delete(key)
  }

  return {
    finalRecords,
    finalTombstones,
    recordsToApply,
    recordsToDelete,
    conflicts,
    uploadedRecords: 0,
    downloadedRecords,
    deletedRecords
  }
}

function mergePush(local: LocalSnapshot): MergeResult {
  const finalRecords = new Map(local.records)
  const finalTombstones = new Map(local.tombstones)
  for (const key of finalRecords.keys()) {
    finalTombstones.delete(key)
  }
  return {
    finalRecords,
    finalTombstones,
    recordsToApply: new Map(),
    recordsToDelete: new Map(),
    conflicts: [],
    uploadedRecords: finalRecords.size,
    downloadedRecords: 0,
    deletedRecords: 0
  }
}

function mergePull(local: LocalSnapshot, remoteBundle: SyncBundle | null): MergeResult {
  const remoteRecords = bundleToRecordMap(remoteBundle)
  const remoteTombstones = bundleToTombstoneMap(remoteBundle)
  const recordsToApply = new Map<string, SyncRecord>()
  const recordsToDelete = new Map<string, SyncTombstone>()
  const now = Date.now()

  for (const [key, record] of remoteRecords) {
    if (local.records.get(key)?.hash !== record.hash) {
      recordsToApply.set(key, record)
    }
  }

  for (const key of local.records.keys()) {
    if (remoteRecords.has(key)) continue
    const tombstone =
      remoteTombstones.get(key) ??
      ({
        ...splitRecordKey(key),
        deletedAt: now,
        originDeviceId: remoteBundle?.manifest.deviceId ?? 'remote'
      } satisfies SyncTombstone)
    recordsToDelete.set(key, tombstone)
    remoteTombstones.set(key, tombstone)
  }

  return {
    finalRecords: remoteRecords,
    finalTombstones: remoteTombstones,
    recordsToApply,
    recordsToDelete,
    conflicts: [],
    uploadedRecords: 0,
    downloadedRecords: recordsToApply.size,
    deletedRecords: recordsToDelete.size
  }
}

function orderRecordKeysByTables(
  keys: Iterable<string>,
  tableOrder: string[],
  reverse = false
): string[] {
  const order = reverse ? [...tableOrder].reverse() : tableOrder
  const orderIndex = new Map(order.map((table, index) => [table, index]))
  return [...keys].sort((left, right) => {
    const leftTable = tableFromDomain(splitRecordKey(left).domain)
    const rightTable = tableFromDomain(splitRecordKey(right).domain)
    const leftOrder = leftTable ? (orderIndex.get(leftTable) ?? 10_000) : 20_000
    const rightOrder = rightTable ? (orderIndex.get(rightTable) ?? 10_000) : 20_000
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return left.localeCompare(right)
  })
}

function upsertDbRecord(db: Database.Database, schema: DbTableSchema, record: SyncRecord): void {
  if (!isPlainRecord(record.value) || !isPlainRecord(record.value.row)) {
    throw new Error(`Invalid DB sync record for ${record.domain}`)
  }
  const row = record.value.row
  const columns = schema.columns
  const conflictColumns = schema.pkColumns.map(quoteIdent).join(', ')
  const updateColumns = columns.filter((column) => !schema.pkColumns.includes(column))
  const sql =
    `INSERT INTO ${quoteIdent(schema.name)} (${columns.map(quoteIdent).join(', ')}) ` +
    `VALUES (${columns.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(${conflictColumns}) DO ${
      updateColumns.length > 0
        ? `UPDATE SET ${updateColumns
            .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
            .join(', ')}`
        : 'NOTHING'
    }`
  db.prepare(sql).run(...columns.map((column) => row[column] ?? null))
}

function deleteDbRecord(db: Database.Database, schema: DbTableSchema, recordId: string): void {
  const pkValues = parseRecordId(recordId)
  if (pkValues.length !== schema.pkColumns.length) {
    throw new Error(`Invalid record id for ${schema.name}`)
  }
  const where = schema.pkColumns.map((column) => `${quoteIdent(column)} = ?`).join(' AND ')
  db.prepare(`DELETE FROM ${quoteIdent(schema.name)} WHERE ${where}`).run(...pkValues)
}

function applyFileRecord(record: SyncRecord): void {
  if (!isPlainRecord(record.value)) throw new Error(`Invalid file sync record: ${record.recordId}`)
  const relativePath = typeof record.value.path === 'string' ? record.value.path : record.recordId
  if (!shouldIncludeDataRelativePath(relativePath)) {
    throw new Error(`Refusing to write unsupported sync file: ${relativePath}`)
  }
  const targetPath = resolveDataRelativePath(relativePath)
  if (!targetPath) throw new Error(`Invalid sync file path: ${relativePath}`)
  const data = typeof record.value.data === 'string' ? record.value.data : ''
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const buffer = Buffer.from(data, 'base64')

  if (relativePath === 'settings.json') {
    replaceSettingsForSync(JSON.parse(buffer.toString('utf-8')) as Record<string, unknown>)
    return
  }

  if (relativePath === 'config.json') {
    const localSyncConfig = readSyncConfig()
    const nextConfig = JSON.parse(buffer.toString('utf-8')) as Record<string, unknown>
    const nextSync = isPlainRecord(nextConfig.sync)
      ? {
          ...nextConfig.sync,
          deviceId: localSyncConfig.deviceId
        }
      : nextConfig.sync
    writeConfig({
      ...nextConfig,
      sync: nextSync
    })
    return
  }

  fs.writeFileSync(targetPath, buffer)
}

function deleteFileRecord(recordId: string): void {
  if (!shouldIncludeDataRelativePath(recordId)) return
  const targetPath = resolveDataRelativePath(recordId)
  if (!targetPath || !fs.existsSync(targetPath)) return
  const stat = fs.statSync(targetPath)
  if (stat.isFile()) fs.unlinkSync(targetPath)
}

function applyMergeToLocal(local: LocalSnapshot, merge: MergeResult): void {
  const db = getDb()
  const dbApplyKeys = orderRecordKeysByTables(
    [...merge.recordsToApply.keys()].filter((key) => splitRecordKey(key).domain.startsWith('db:')),
    local.upsertTableOrder
  )
  const dbDeleteKeys = orderRecordKeysByTables(
    [...merge.recordsToDelete.keys()].filter((key) => splitRecordKey(key).domain.startsWith('db:')),
    local.upsertTableOrder,
    true
  )

  const tx = db.transaction(() => {
    for (const key of dbDeleteKeys) {
      const { domain, recordId } = splitRecordKey(key)
      const tableName = tableFromDomain(domain)
      const schema = tableName ? local.tableSchemas.get(tableName) : undefined
      if (schema) deleteDbRecord(db, schema, recordId)
    }
    for (const key of dbApplyKeys) {
      const record = merge.recordsToApply.get(key)
      if (!record) continue
      const tableName = tableFromDomain(record.domain)
      const schema = tableName ? local.tableSchemas.get(tableName) : undefined
      if (schema) upsertDbRecord(db, schema, record)
    }
  })
  tx()

  for (const [, tombstone] of merge.recordsToDelete) {
    if (tombstone.domain === FILE_DOMAIN) deleteFileRecord(tombstone.recordId)
  }
  for (const [, record] of merge.recordsToApply) {
    if (record.domain === FILE_DOMAIN) applyFileRecord(record)
  }
}

function buildBundle(
  deviceId: string,
  records: Map<string, SyncRecord>,
  tombstones: Map<string, SyncTombstone>
): SyncBundle {
  const sortedRecords = [...records.values()].sort((left, right) =>
    recordKey(left.domain, left.recordId).localeCompare(recordKey(right.domain, right.recordId))
  )
  const sortedTombstones = [...tombstones.values()].sort((left, right) =>
    recordKey(left.domain, left.recordId).localeCompare(recordKey(right.domain, right.recordId))
  )
  const domains: Record<string, number> = {}
  for (const record of sortedRecords) {
    domains[record.domain] = (domains[record.domain] ?? 0) + 1
  }
  const manifestBase: Omit<SyncBundleManifest, 'contentHash'> = {
    schemaVersion: SYNC_SCHEMA_VERSION,
    appVersion: app.getVersion(),
    deviceId,
    createdAt: Date.now(),
    domains,
    tombstones: sortedTombstones.length
  }
  const contentHash = hashValue({
    manifest: manifestBase,
    records: sortedRecords,
    tombstones: sortedTombstones
  })
  return {
    manifest: {
      ...manifestBase,
      contentHash
    },
    records: sortedRecords,
    tombstones: sortedTombstones
  }
}

function saveSyncMetadata(providerId: string, bundle: SyncBundle): void {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM sync_record_state WHERE provider_id = ?').run(providerId)
    db.prepare('DELETE FROM sync_tombstones WHERE provider_id = ?').run(providerId)

    const insertState = db.prepare(
      `INSERT INTO sync_record_state (provider_id, domain, record_id, content_hash, synced_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (const record of bundle.records) {
      insertState.run(providerId, record.domain, record.recordId, record.hash, now)
    }

    const insertTombstone = db.prepare(
      `INSERT INTO sync_tombstones (provider_id, domain, record_id, deleted_at, origin_device_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (const tombstone of bundle.tombstones) {
      insertTombstone.run(
        providerId,
        tombstone.domain,
        tombstone.recordId,
        tombstone.deletedAt,
        tombstone.originDeviceId
      )
    }
  })
  tx()
}

function resolveConflicts(merge: MergeResult, resolutions: SyncConflictResolution[]): void {
  const resolutionsById = new Map(
    resolutions.map((resolution) => [resolution.conflictId, resolution.choice])
  )
  for (const conflict of merge.conflicts) {
    const choice = resolutionsById.get(conflict.id)
    if (!choice) throw new Error(`Missing resolution for conflict ${conflict.id}`)
    const key = recordKey(conflict.domain, conflict.recordId)

    if (choice === 'local') {
      if (conflict.localDeleted) {
        merge.finalRecords.delete(key)
        merge.finalTombstones.set(key, {
          domain: conflict.domain,
          recordId: conflict.recordId,
          deletedAt: Date.now(),
          originDeviceId: readSyncConfig().deviceId
        })
      }
      continue
    }

    if (conflict.remoteDeleted) {
      merge.finalRecords.delete(key)
      merge.finalTombstones.set(key, {
        domain: conflict.domain,
        recordId: conflict.recordId,
        deletedAt: Date.now(),
        originDeviceId: 'remote'
      })
      merge.recordsToDelete.set(key, merge.finalTombstones.get(key)!)
      merge.deletedRecords += 1
      continue
    }

    const remoteRecord = isPlainRecord(conflict.remoteValue)
      ? ({
          domain: conflict.domain,
          recordId: conflict.recordId,
          hash: conflict.remoteHash ?? hashValue(conflict.remoteValue),
          value: conflict.remoteValue
        } satisfies SyncRecord)
      : undefined
    if (!remoteRecord) throw new Error(`Remote conflict value is missing for ${conflict.id}`)
    merge.finalRecords.set(key, remoteRecord)
    merge.finalTombstones.delete(key)
    merge.recordsToApply.set(key, remoteRecord)
    merge.downloadedRecords += 1
  }
  merge.conflicts = []
}

export class SyncEngine {
  private readonly webdavProvider = new WebDavProvider()
  private pendingConflict: PendingConflictState | null = null
  private running = false
  private status: SyncRunStatus = 'idle'

  getProviderDescriptors(): SyncProviderDescriptor[] {
    return [
      {
        type: 'webdav',
        displayName: 'WebDAV',
        description: 'Sync OpenCowork data through any WebDAV-compatible storage.'
      }
    ]
  }

  getStatus(): SyncStatus {
    const config = readSyncConfig()
    return {
      status: this.status,
      running: this.running,
      deviceId: config.deviceId,
      activeProviderId: config.activeProviderId,
      lastRun: config.lastRun ?? null,
      pendingConflicts: this.pendingConflict?.merge.conflicts ?? []
    }
  }

  async testConnection(
    provider?: SyncProviderConfig
  ): Promise<{ success: boolean; error?: string }> {
    const target = provider ?? getActiveSyncProvider()
    if (target.type !== 'webdav') return { success: false, error: 'Unsupported sync provider' }
    return this.webdavProvider.testConnection(target.webdav)
  }

  async run(mode: SyncRunMode): Promise<SyncRunSummary> {
    if (this.running) throw new Error('A sync run is already in progress')
    this.running = true
    this.status = 'running'
    this.pendingConflict = null
    const startedAt = Date.now()
    const runId = randomUUID()
    const provider = getActiveSyncProvider()
    safeSendToAllWindows('sync:status-changed', this.getStatus())
    safeSendToAllWindows('sync:run-progress', { runId, phase: 'started', mode })

    try {
      if (!provider.enabled) throw new Error('Sync provider is disabled')
      if (provider.type !== 'webdav') throw new Error('Unsupported sync provider')

      const config = readSyncConfig()
      const local = captureLocalSnapshot(provider.id, config.deviceId)
      safeSendToAllWindows('sync:run-progress', { runId, phase: 'download' })
      const remote = await this.webdavProvider.download(provider.webdav)
      const merge =
        mode === 'push'
          ? mergePush(local)
          : mode === 'pull'
            ? mergePull(local, remote.bundle)
            : mergeThreeWay(local, remote.bundle)

      if (merge.conflicts.length > 0) {
        return this.recordConflictRun({
          runId,
          provider,
          mode,
          local,
          remote,
          merge,
          startedAt
        })
      }

      try {
        return await this.finishMergedRun({
          runId,
          provider,
          mode,
          local,
          remote,
          merge,
          startedAt
        })
      } catch (error) {
        if (error instanceof RemoteStateChangedError && mode !== 'pull') {
          return await this.retryAfterRemoteChange({
            runId,
            provider,
            mode,
            startedAt
          })
        }
        throw error
      }
    } catch (error) {
      const summary: SyncRunSummary = {
        id: runId,
        providerId: provider.id,
        mode,
        status: 'error',
        startedAt,
        finishedAt: Date.now(),
        uploadedRecords: 0,
        downloadedRecords: 0,
        deletedRecords: 0,
        conflicts: 0,
        error: error instanceof Error ? error.message : String(error)
      }
      this.status = 'error'
      patchSyncConfig({ lastRun: summary })
      safeSendToAllWindows('sync:run-finished', summary)
      return summary
    } finally {
      this.running = false
      safeSendToAllWindows('sync:status-changed', this.getStatus())
    }
  }

  async resolveConflicts(resolutions: SyncConflictResolution[]): Promise<SyncRunSummary> {
    if (!this.pendingConflict) throw new Error('No pending sync conflicts')
    if (this.running) throw new Error('A sync run is already in progress')

    this.running = true
    this.status = 'running'
    safeSendToAllWindows('sync:status-changed', this.getStatus())

    try {
      resolveConflicts(this.pendingConflict.merge, resolutions)
      const summary = await this.finishMergedRun(this.pendingConflict)
      this.pendingConflict = null
      return summary
    } catch (error) {
      const pending = this.pendingConflict
      if (!pending) {
        throw error
      }
      const summary: SyncRunSummary = {
        id: pending.runId,
        providerId: pending.provider.id,
        mode: pending.mode,
        status: 'error',
        startedAt: pending.startedAt,
        finishedAt: Date.now(),
        uploadedRecords: 0,
        downloadedRecords: 0,
        deletedRecords: 0,
        conflicts: pending.merge.conflicts.length,
        error: error instanceof Error ? error.message : String(error)
      }
      this.status = 'error'
      patchSyncConfig({ lastRun: summary })
      safeSendToAllWindows('sync:run-finished', summary)
      return summary
    } finally {
      this.running = false
      safeSendToAllWindows('sync:status-changed', this.getStatus())
    }
  }

  private recordConflictRun(args: {
    runId: string
    provider: SyncProviderConfig
    mode: SyncRunMode
    local: LocalSnapshot
    remote: RemoteBundleState
    merge: MergeResult
    startedAt: number
  }): SyncRunSummary {
    const summary = this.buildSummary({
      runId: args.runId,
      providerId: args.provider.id,
      mode: args.mode,
      status: 'conflict',
      startedAt: args.startedAt,
      merge: args.merge,
      remote: args.remote
    })
    this.pendingConflict = {
      runId: args.runId,
      provider: args.provider,
      mode: args.mode,
      local: args.local,
      remote: args.remote,
      merge: args.merge,
      startedAt: args.startedAt
    }
    this.status = 'conflict'
    patchSyncConfig({ lastRun: summary })
    safeSendToAllWindows('sync:conflict-found', args.merge.conflicts)
    safeSendToAllWindows('sync:run-finished', summary)
    return summary
  }

  private async retryAfterRemoteChange(args: {
    runId: string
    provider: SyncProviderConfig
    mode: SyncRunMode
    startedAt: number
  }): Promise<SyncRunSummary> {
    const config = readSyncConfig()
    safeSendToAllWindows('sync:run-progress', {
      runId: args.runId,
      phase: 'remote-changed'
    })
    const local = captureLocalSnapshot(args.provider.id, config.deviceId)
    const remote = await this.webdavProvider.download(args.provider.webdav)
    const merge = args.mode === 'push' ? mergePush(local) : mergeThreeWay(local, remote.bundle)

    if (merge.conflicts.length > 0) {
      return this.recordConflictRun({
        runId: args.runId,
        provider: args.provider,
        mode: args.mode,
        local,
        remote,
        merge,
        startedAt: args.startedAt
      })
    }

    return await this.finishMergedRun({
      runId: args.runId,
      provider: args.provider,
      mode: args.mode,
      local,
      remote,
      merge,
      startedAt: args.startedAt
    })
  }

  private async finishMergedRun(args: {
    runId: string
    provider: SyncProviderConfig
    mode: SyncRunMode
    local: LocalSnapshot
    remote: RemoteBundleState
    merge: MergeResult
    startedAt: number
  }): Promise<SyncRunSummary> {
    safeSendToAllWindows('sync:run-progress', { runId: args.runId, phase: 'apply-local' })
    applyMergeToLocal(args.local, args.merge)

    const config = readSyncConfig()
    const bundle = buildBundle(config.deviceId, args.merge.finalRecords, args.merge.finalTombstones)
    let uploadedRemote = args.remote
    if (args.mode !== 'pull') {
      safeSendToAllWindows('sync:run-progress', { runId: args.runId, phase: 'upload' })
      uploadedRemote = await this.webdavProvider.upload(args.provider.webdav, bundle, {
        previousExists: Boolean(args.remote.bundle),
        previousEtag: args.remote.etag,
        previousLastModified: args.remote.lastModified
      })
      args.merge.uploadedRecords =
        bundle.records.length + bundle.tombstones.length - (args.remote.bundle?.records.length ?? 0)
    }

    saveSyncMetadata(
      args.provider.id,
      args.mode === 'pull' && args.remote.bundle ? args.remote.bundle : bundle
    )

    const summary = this.buildSummary({
      runId: args.runId,
      providerId: args.provider.id,
      mode: args.mode,
      status: 'success',
      startedAt: args.startedAt,
      merge: args.merge,
      remote: uploadedRemote
    })
    this.status = 'success'
    patchSyncConfig({ lastRun: summary })
    safeSendToAllWindows('sync:run-finished', summary)
    return summary
  }

  private buildSummary(args: {
    runId: string
    providerId: string
    mode: SyncRunMode
    status: SyncRunStatus
    startedAt: number
    merge: MergeResult
    remote: RemoteBundleState
  }): SyncRunSummary {
    return {
      id: args.runId,
      providerId: args.providerId,
      mode: args.mode,
      status: args.status,
      startedAt: args.startedAt,
      finishedAt: Date.now(),
      uploadedRecords: Math.max(0, args.merge.uploadedRecords),
      downloadedRecords: args.merge.downloadedRecords,
      deletedRecords: args.merge.deletedRecords,
      conflicts: args.merge.conflicts.length,
      remoteUpdatedAt: args.remote.updatedAt,
      error: null
    }
  }
}

export const syncEngine = new SyncEngine()

export function updateSyncConfig(
  config: Parameters<typeof writeSyncConfig>[0]
): ReturnType<typeof writeSyncConfig> {
  return writeSyncConfig(config)
}
