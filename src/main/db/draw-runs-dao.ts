import { getDb } from './database'

export interface DrawRunRow {
  id: string
  prompt: string
  provider_name: string
  model_name: string
  mode: string
  meta_json: string | null
  created_at: number
  is_generating: number
  images_json: string
  error_json: string | null
  updated_at: number
}

export function listDrawRuns(): DrawRunRow[] {
  const db = getDb()
  return db.prepare('SELECT * FROM draw_runs ORDER BY created_at DESC').all() as DrawRunRow[]
}

export function saveDrawRun(run: {
  id: string
  prompt: string
  providerName: string
  modelName: string
  mode?: string
  metaJson?: string | null
  createdAt: number
  isGenerating: boolean
  imagesJson: string
  errorJson?: string | null
  updatedAt: number
}): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO draw_runs (
      id,
      prompt,
      provider_name,
      model_name,
      mode,
      meta_json,
      created_at,
      is_generating,
      images_json,
      error_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    run.id,
    run.prompt,
    run.providerName,
    run.modelName,
    run.mode ?? 'image',
    run.metaJson ?? null,
    run.createdAt,
    run.isGenerating ? 1 : 0,
    run.imagesJson,
    run.errorJson ?? null,
    run.updatedAt
  )
}

export function deleteDrawRun(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM draw_runs WHERE id = ?').run(id)
}

export function clearDrawRuns(): void {
  const db = getDb()
  db.prepare('DELETE FROM draw_runs').run()
}
