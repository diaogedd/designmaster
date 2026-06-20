import { ipcMain, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readConfig, writeConfig } from './secure-key-store'
import type {
  ExtensionFetchRequest,
  ExtensionFetchResponse,
  ExtensionInstance,
  ExtensionManifest,
  ExtensionToolDefinition
} from '../../shared/extension-types'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')
const EXTENSIONS_DIR = path.join(DATA_DIR, 'extensions')
const EXTENSIONS_STATE_FILE = path.join(DATA_DIR, 'extensions.json')
const EXTENSIONS_STORAGE_FILE = path.join(DATA_DIR, 'extensions-storage.json')
const EXTENSION_MANIFEST_FILE = 'extension.json'
const MAX_EXTENSION_FETCH_REDIRECTS = 5

interface ExtensionState {
  enabled: boolean
  installedAt: number
  updatedAt: number
  config: Record<string, string>
}

type ExtensionStateFile = Record<string, ExtensionState>
type ExtensionStorageFile = Record<string, Record<string, unknown>>

function ensureDataDirs(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(EXTENSIONS_DIR)) fs.mkdirSync(EXTENSIONS_DIR, { recursive: true })
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    }
  } catch {
    // Return fallback on invalid or unreadable data.
  }
  return fallback
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDataDirs()
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function readState(): ExtensionStateFile {
  return readJsonFile<ExtensionStateFile>(EXTENSIONS_STATE_FILE, {})
}

function writeState(state: ExtensionStateFile): void {
  writeJsonFile(EXTENSIONS_STATE_FILE, state)
}

function readStorage(): ExtensionStorageFile {
  return readJsonFile<ExtensionStorageFile>(EXTENSIONS_STORAGE_FILE, {})
}

function writeStorage(storage: ExtensionStorageFile): void {
  writeJsonFile(EXTENSIONS_STORAGE_FILE, storage)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

function isValidExtensionId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value)
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item
  }
  return result
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function normalizeManifest(raw: unknown): ExtensionManifest {
  if (!isRecord(raw)) {
    throw new Error('extension.json must contain an object')
  }

  const id = normalizeId(raw.id)
  if (!isValidExtensionId(id)) {
    throw new Error('extension id must be 2-64 chars using lowercase letters, numbers, _ or -')
  }

  const name = String(raw.name ?? '').trim()
  const version = String(raw.version ?? '').trim()
  if (!name) throw new Error('extension name is required')
  if (!version) throw new Error('extension version is required')

  if (raw.schemaVersion !== 1) {
    throw new Error('extension schemaVersion must be 1')
  }

  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    throw new Error('extension must define at least one tool')
  }

  const configSchema = Array.isArray(raw.configSchema)
    ? raw.configSchema
        .filter((field): field is Record<string, unknown> => isRecord(field))
        .map((field) => ({
          key: String(field.key ?? '').trim(),
          label: String(field.label ?? field.key ?? '').trim(),
          type: field.type === 'secret' ? ('secret' as const) : ('text' as const),
          ...(field.required === true ? { required: true } : {})
        }))
        .filter((field) => field.key && field.label)
    : undefined
  if (configSchema)
    assertUnique(
      configSchema.map((field) => field.key),
      'config key'
    )

  const tools: ExtensionToolDefinition[] = raw.tools.map((tool, index) => {
    if (!isRecord(tool)) throw new Error(`tool at index ${index} must be an object`)
    const toolName = String(tool.name ?? '').trim()
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(toolName)) {
      throw new Error(`invalid tool name at index ${index}`)
    }
    const kind = tool.kind === 'http' || tool.kind === 'js' ? tool.kind : null
    if (!kind) throw new Error(`tool "${toolName}" kind must be "http" or "js"`)
    const inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' }
    const http = isRecord(tool.http)
      ? {
          method: String(tool.http.method ?? 'GET')
            .trim()
            .toUpperCase(),
          url: String(tool.http.url ?? '').trim(),
          ...(isRecord(tool.http.headers)
            ? { headers: normalizeStringMap(tool.http.headers) }
            : {}),
          ...('body' in tool.http ? { body: tool.http.body } : {})
        }
      : undefined
    if (kind === 'http' && (!http?.url || !http.method)) {
      throw new Error(`http tool "${toolName}" requires http.method and http.url`)
    }
    const handler = typeof tool.handler === 'string' ? tool.handler.trim() : undefined
    if (kind === 'js' && !handler) {
      throw new Error(`js tool "${toolName}" requires handler`)
    }
    return {
      name: toolName,
      description: String(tool.description ?? toolName).trim(),
      inputSchema,
      kind,
      ...(http ? { http } : {}),
      ...(handler ? { handler } : {}),
      ...(typeof tool.readOnly === 'boolean' ? { readOnly: tool.readOnly } : {})
    }
  })
  assertUnique(
    tools.map((tool) => tool.name),
    'tool name'
  )

  const renderers = Array.isArray(raw.renderers)
    ? raw.renderers
        .filter((renderer): renderer is Record<string, unknown> => isRecord(renderer))
        .map((renderer) => ({
          name: String(renderer.name ?? '').trim(),
          type: 'html' as const,
          entry: String(renderer.entry ?? '').trim()
        }))
        .filter((renderer) => renderer.name && renderer.entry)
    : undefined
  if (renderers)
    assertUnique(
      renderers.map((renderer) => renderer.name),
      'renderer name'
    )

  const network =
    isRecord(raw.permissions) && Array.isArray(raw.permissions.network)
      ? raw.permissions.network.filter((item): item is string => typeof item === 'string')
      : undefined

  return {
    schemaVersion: 1,
    id,
    name,
    version,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.entry === 'string' && raw.entry.trim() ? { entry: raw.entry.trim() } : {}),
    ...(configSchema && configSchema.length > 0 ? { configSchema } : {}),
    ...(network ? { permissions: { network } } : {}),
    tools,
    ...(renderers && renderers.length > 0 ? { renderers } : {})
  }
}

function readManifest(extensionId: string): ExtensionManifest {
  const manifestPath = path.join(EXTENSIONS_DIR, extensionId, EXTENSION_MANIFEST_FILE)
  return normalizeManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')))
}

function listManifestIds(): string[] {
  ensureDataDirs()
  return fs
    .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(EXTENSIONS_DIR, name, EXTENSION_MANIFEST_FILE)))
}

function secretConfigKey(extensionId: string, key: string): string {
  return `extension:${extensionId}:secret:${key}`
}

function getSecretConfig(extensionId: string, key: string): string {
  const value = readConfig()[secretConfigKey(extensionId, key)]
  return typeof value === 'string' ? value : ''
}

function setSecretConfig(extensionId: string, key: string, value: string): void {
  const config = readConfig()
  config[secretConfigKey(extensionId, key)] = value
  writeConfig(config)
}

function deleteSecretConfig(extensionId: string, key: string): void {
  const config = readConfig()
  delete config[secretConfigKey(extensionId, key)]
  writeConfig(config)
}

function defaultConfigForManifest(manifest: ExtensionManifest): Record<string, string> {
  const result: Record<string, string> = {}
  for (const field of manifest.configSchema ?? []) {
    result[field.key] = ''
  }
  return result
}

function mergeRuntimeConfig(
  extensionId: string,
  manifest: ExtensionManifest,
  stateConfig?: Record<string, string>
): Record<string, string> {
  const result = defaultConfigForManifest(manifest)
  const secretKeys = new Set(
    (manifest.configSchema ?? [])
      .filter((field) => field.type === 'secret')
      .map((field) => field.key)
  )

  for (const [key, value] of Object.entries(stateConfig ?? {})) {
    if (!secretKeys.has(key)) result[key] = value
  }
  for (const key of secretKeys) {
    result[key] = getSecretConfig(extensionId, key)
  }
  return result
}

function splitAndPersistConfig(
  extensionId: string,
  manifest: ExtensionManifest,
  nextConfig: Record<string, string>
): Record<string, string> {
  const secretKeys = new Set(
    (manifest.configSchema ?? [])
      .filter((field) => field.type === 'secret')
      .map((field) => field.key)
  )
  const stateConfig: Record<string, string> = {}

  for (const [key, value] of Object.entries(nextConfig)) {
    if (secretKeys.has(key)) {
      setSecretConfig(extensionId, key, value)
    } else {
      stateConfig[key] = value
    }
  }
  return stateConfig
}

function listExtensions(): ExtensionInstance[] {
  const state = readState()
  let changed = false
  const instances: ExtensionInstance[] = []
  const seen = new Set<string>()

  for (const id of listManifestIds()) {
    try {
      const manifest = readManifest(id)
      if (manifest.id !== id) {
        console.warn(`[Extensions] Skipping ${id}: manifest id does not match directory name`)
        continue
      }
      seen.add(id)
      if (!state[id]) {
        state[id] = {
          enabled: false,
          installedAt: Date.now(),
          updatedAt: Date.now(),
          config: defaultConfigForManifest(manifest)
        }
        changed = true
      }
      instances.push({
        id,
        enabled: state[id].enabled,
        installedAt: state[id].installedAt,
        updatedAt: state[id].updatedAt,
        config: mergeRuntimeConfig(id, manifest, state[id].config),
        manifest
      })
    } catch (err) {
      console.error(`[Extensions] Failed to load ${id}:`, err)
    }
  }

  for (const id of Object.keys(state)) {
    if (!seen.has(id)) {
      delete state[id]
      changed = true
    }
  }

  if (changed) writeState(state)
  return instances
}

function resolveExtensionPath(extensionId: string, relativePath = ''): string {
  if (!isValidExtensionId(extensionId)) throw new Error('Invalid extension id')
  const root = path.resolve(EXTENSIONS_DIR, extensionId)
  const target = path.resolve(root, relativePath || '.')
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Path escapes extension directory')
  }
  return target
}

function assertExistingPathInsideExtension(extensionId: string, targetPath: string): void {
  const root = fs.realpathSync(resolveExtensionPath(extensionId))
  const target = fs.realpathSync(targetPath)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Path escapes extension directory')
  }
}

function normalizeStorageKey(value: unknown): string {
  const key = String(value ?? '').trim()
  if (!key || key.length > 256) {
    throw new Error('Extension storage key must be 1-256 characters')
  }
  return key
}

function getNestedValue(source: Record<string, unknown>, dottedPath: string): unknown {
  const parts = dottedPath.split('.').filter(Boolean)
  let current: unknown = source
  for (const part of parts) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

function interpolateString(
  value: string,
  input: Record<string, unknown>,
  config: Record<string, string>
): string {
  return value.replace(/\{\{\s*(input|config)\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, scope, key) => {
    const source = scope === 'input' ? input : config
    const resolved = getNestedValue(source, key)
    if (resolved === undefined || resolved === null) return ''
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
  })
}

function interpolateValue(
  value: unknown,
  input: Record<string, unknown>,
  config: Record<string, string>
): unknown {
  if (typeof value === 'string') return interpolateString(value, input, config)
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, input, config))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateValue(item, input, config)])
    )
  }
  return value
}

function isNetworkAllowed(manifest: ExtensionManifest, targetUrl: string): boolean {
  const allowlist = manifest.permissions?.network ?? []
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
  if (allowlist.includes('*')) return true
  if (allowlist.length === 0) return false

  return allowlist.some((allowed) => {
    const value = allowed.trim()
    if (!value) return false
    if (value.endsWith('*')) return target.href.startsWith(value.slice(0, -1))
    try {
      const allowedUrl = new URL(value)
      return target.origin === allowedUrl.origin && target.href.startsWith(allowedUrl.href)
    } catch {
      return target.origin === value
    }
  })
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function findExtensionOrThrow(extensionId: string): ExtensionInstance {
  const extension = listExtensions().find((item) => item.id === extensionId)
  if (!extension) throw new Error(`Extension "${extensionId}" not found`)
  return extension
}

function findToolOrThrow(extension: ExtensionInstance, toolName: string): ExtensionToolDefinition {
  const tool = extension.manifest.tools.find((item) => item.name === toolName)
  if (!tool) throw new Error(`Tool "${toolName}" not found in extension "${extension.id}"`)
  return tool
}

function buildToolFetchRequest(
  extension: ExtensionInstance,
  tool: ExtensionToolDefinition,
  input: Record<string, unknown>
): ExtensionFetchRequest {
  if (tool.kind !== 'http' || !tool.http) {
    throw new Error(`Tool "${tool.name}" is not an HTTP tool`)
  }
  return {
    method: tool.http.method,
    url: interpolateString(tool.http.url, input, extension.config),
    headers: interpolateValue(tool.http.headers ?? {}, input, extension.config) as Record<
      string,
      string
    >,
    ...('body' in tool.http
      ? { body: interpolateValue(tool.http.body, input, extension.config) }
      : {})
  }
}

async function performFetch(
  extension: ExtensionInstance,
  request: ExtensionFetchRequest
): Promise<ExtensionFetchResponse> {
  let url = request.url
  let method = (request.method || 'GET').toUpperCase()
  const headers = { ...(request.headers ?? {}) }
  let body: BodyInit | undefined
  if (request.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (typeof request.body === 'string') {
      body = request.body
    } else {
      body = JSON.stringify(request.body)
      const hasContentType = Object.keys(headers).some(
        (key) => key.toLowerCase() === 'content-type'
      )
      if (!hasContentType) headers['Content-Type'] = 'application/json'
    }
  }

  let response: Response | null = null
  for (let redirectCount = 0; redirectCount <= MAX_EXTENSION_FETCH_REDIRECTS; redirectCount += 1) {
    if (!url || !isNetworkAllowed(extension.manifest, url)) {
      throw new Error(`Network access denied for ${url || '(empty url)'}`)
    }

    response = await fetch(url, { method, headers, body, redirect: 'manual' })
    const location = response.headers.get('location')
    if (!isRedirectStatus(response.status) || !location) break
    if (redirectCount === MAX_EXTENSION_FETCH_REDIRECTS) {
      throw new Error('Extension fetch exceeded redirect limit')
    }

    const nextUrl = new URL(location, url).href
    if (!isNetworkAllowed(extension.manifest, nextUrl)) {
      throw new Error(`Network access denied for redirect to ${nextUrl}`)
    }
    url = nextUrl

    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      method = 'GET'
      body = undefined
      delete headers['Content-Type']
      delete headers['content-type']
    }
  }
  if (!response) throw new Error('Extension fetch failed')

  const text = await response.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    ...(json !== undefined ? { json } : {})
  }
}

export function registerExtensionHandlers(): void {
  ipcMain.handle('extension:list', () => listExtensions())

  ipcMain.handle(
    'extension:install-from-folder',
    async (_event, args: { sourcePath: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        const sourcePath = path.resolve(args.sourcePath)
        const manifestPath = path.join(sourcePath, EXTENSION_MANIFEST_FILE)
        if (!fs.existsSync(manifestPath)) {
          return { success: false, error: `No ${EXTENSION_MANIFEST_FILE} found in folder` }
        }
        const manifest = normalizeManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')))
        const targetPath = resolveExtensionPath(manifest.id)
        if (fs.existsSync(targetPath)) {
          return { success: false, error: `Extension "${manifest.id}" already exists` }
        }
        ensureDataDirs()
        fs.cpSync(sourcePath, targetPath, { recursive: true })

        const state = readState()
        state[manifest.id] = {
          enabled: false,
          installedAt: Date.now(),
          updatedAt: Date.now(),
          config: defaultConfigForManifest(manifest)
        }
        writeState(state)
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'extension:update',
    async (
      _event,
      args: { id: string; patch: { enabled?: boolean; config?: Record<string, string> } }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const extension = findExtensionOrThrow(args.id)
        const state = readState()
        const current = state[args.id] ?? {
          enabled: false,
          installedAt: Date.now(),
          updatedAt: Date.now(),
          config: defaultConfigForManifest(extension.manifest)
        }
        state[args.id] = {
          ...current,
          ...(typeof args.patch.enabled === 'boolean' ? { enabled: args.patch.enabled } : {}),
          ...(args.patch.config
            ? {
                config: splitAndPersistConfig(args.id, extension.manifest, {
                  ...mergeRuntimeConfig(args.id, extension.manifest, current.config),
                  ...args.patch.config
                })
              }
            : {}),
          updatedAt: Date.now()
        }
        writeState(state)
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'extension:remove',
    async (_event, id: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const extension = findExtensionOrThrow(id)
        fs.rmSync(resolveExtensionPath(id), { recursive: true, force: true })
        const state = readState()
        delete state[id]
        writeState(state)
        for (const field of extension.manifest.configSchema ?? []) {
          if (field.type === 'secret') deleteSecretConfig(id, field.key)
        }
        const storage = readStorage()
        delete storage[id]
        writeStorage(storage)
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'extension:open-folder',
    async (_event, id: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const error = await shell.openPath(resolveExtensionPath(id))
        if (error) return { success: false, error }
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'extension:read-asset',
    async (
      _event,
      args: { id: string; path: string }
    ): Promise<{ content: string } | { error: string }> => {
      try {
        findExtensionOrThrow(args.id)
        const assetPath = resolveExtensionPath(args.id, args.path)
        if (!fs.existsSync(assetPath) || fs.statSync(assetPath).isDirectory()) {
          return { error: `Asset not found: ${args.path}` }
        }
        assertExistingPathInsideExtension(args.id, assetPath)
        return { content: fs.readFileSync(assetPath, 'utf-8') }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'extension:fetch',
    async (
      _event,
      args: {
        extensionId: string
        toolName?: string
        input?: Record<string, unknown>
        request?: ExtensionFetchRequest
      }
    ): Promise<
      { success: true; response: ExtensionFetchResponse } | { success: false; error: string }
    > => {
      try {
        const extension = findExtensionOrThrow(args.extensionId)
        if (!extension.enabled) throw new Error(`Extension "${args.extensionId}" is disabled`)
        const request = args.toolName
          ? buildToolFetchRequest(
              extension,
              findToolOrThrow(extension, args.toolName),
              isRecord(args.input) ? args.input : {}
            )
          : args.request
        if (!request) throw new Error('Missing fetch request')
        return { success: true, response: await performFetch(extension, request) }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('extension:storage-get', (_event, args: { extensionId: string; key: string }) => {
    findExtensionOrThrow(args.extensionId)
    const key = normalizeStorageKey(args.key)
    const storage = readStorage()
    return storage[args.extensionId]?.[key] ?? null
  })

  ipcMain.handle(
    'extension:storage-set',
    (_event, args: { extensionId: string; key: string; value: unknown }) => {
      findExtensionOrThrow(args.extensionId)
      const key = normalizeStorageKey(args.key)
      const storage = readStorage()
      storage[args.extensionId] = storage[args.extensionId] ?? {}
      storage[args.extensionId][key] = args.value
      writeStorage(storage)
      return { success: true }
    }
  )

  ipcMain.handle(
    'extension:storage-delete',
    (_event, args: { extensionId: string; key: string }) => {
      findExtensionOrThrow(args.extensionId)
      const key = normalizeStorageKey(args.key)
      const storage = readStorage()
      if (storage[args.extensionId]) {
        delete storage[args.extensionId][key]
        writeStorage(storage)
      }
      return { success: true }
    }
  )
}
