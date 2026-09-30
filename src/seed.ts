import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Mock data for QA.
 *
 * mercelle deliberately does NOT clone production data — the env guard already
 * keeps prod DSNs out of the VM. Instead it generates *synthetic* data with
 * production-like shape: same models, same columns, believable values, stable
 * across runs (deterministic RNG). QA sees a database that behaves like the
 * real one without a single real customer row leaving prod.
 */

export interface SeedModel {
  name: string
  columns: SeedColumn[]
}

export interface SeedColumn {
  name: string
  type: 'string' | 'text' | 'int' | 'float' | 'boolean' | 'datetime' | 'json' | 'uuid'
  list: boolean
  optional: boolean
  /** Scalar only when it is a plain value column, not a relation. */
  relation?: string
  /**
   * Set on the *scalar* column that backs a relation
   * (`authorId Int` for `author User @relation(fields: [authorId], ...)`).
   * Used to point the value at a real generated parent row so the seed has
   * referential integrity instead of a dangling foreign key.
   */
  foreignKey?: { model: string; field: string }
}

export interface SeedPlan {
  models: SeedModel[]
  warnings: string[]
}

const COLUMN_TYPE_MAP: Record<string, SeedColumn['type']> = {
  String: 'string',
  Int: 'int',
  Float: 'float',
  Boolean: 'boolean',
  DateTime: 'datetime',
  Json: 'json',
  'String[]': 'string',
  'Int[]': 'int',
}

/** Parse the models of a Prisma schema file. Never throws. */
export function parsePrismaModels(schemaPath: string): SeedModel[] {
  if (!existsSync(schemaPath)) return []
  let text = ''
  try {
    text = readFileSync(schemaPath, 'utf8')
  } catch {
    return []
  }

  const models: SeedModel[] = []
  // The closing brace may be preceded by a newline (normal `prisma format`
  // output) or sit on the same line as a single-column model.
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n?\s*\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const name = match[1] ?? ''
    const body = match[2] ?? ''
    const columns: SeedColumn[] = []
    // Relations declared in this model, applied after the column loop because
    // the scalar FK column is often declared *after* the relation itself.
    const pendingRelations: { fields?: string; references?: string; model: string }[] = []

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue
      const m = /^(\w+)\s+([\w\[\]]+)(\?)?\s*(?:@|$)/.exec(line)
      if (!m) continue
      const [, colName, rawType, optional] = m
      if (!colName || !rawType) continue

      // Relation shorthand: `author User @relation(...)` — type is a model name.
      const isRelation = /^[A-Z]/.test(rawType) && !(rawType in COLUMN_TYPE_MAP)
      const baseType = rawType.replace(/\[\]$/, '')
      const list = rawType.endsWith('[]')
      // Native type attributes like `@db.Text` carry real column intent.
      const nativeText = /@db\.(Text|Text\(.*\))/i.test(line)

      if (isRelation) {
        // A back-relation (`posts Post[]`) has no `fields:` and owns no column.
        const fields = /fields:\s*\[([^\]]+)\]/.exec(line)?.[1]?.trim()
        const references = /references:\s*\[([^\]]+)\]/.exec(line)?.[1]?.trim()
        pendingRelations.push({ fields, references, model: baseType })
      }

      columns.push({
        name: colName,
        type: isRelation ? 'string' : nativeText ? 'text' : (COLUMN_TYPE_MAP[rawType] ?? COLUMN_TYPE_MAP[baseType] ?? 'string'),
        list,
        optional: optional === '?',
        // Store the base relation name: `posts Post[]` relates to Post.
        relation: isRelation ? baseType : undefined,
      })
    }

    // Attach the FK metadata to the scalar columns. Only single-field relations
    // are supported; composite keys keep the plain value rather than a guess.
    for (const rel of pendingRelations) {
      if (!rel.fields || !rel.references) continue
      if (rel.fields.includes(',') || rel.references.includes(',')) continue
      const target = columns.find((c) => c.name === rel.fields)
      if (target && !target.relation) {
        target.foreignKey = { model: rel.model, field: rel.references }
      }
    }

    if (name) models.push({ name, columns })
  }
  return models
}

/** Build the seed plan for a project: prisma schema when present. */
export function planSeed(projectRoot: string): SeedPlan {
  const warnings: string[] = []
  const candidates = [
    join(projectRoot, 'prisma', 'schema.prisma'),
    join(projectRoot, 'schema.prisma'),
    join(projectRoot, 'prisma', 'schema', 'schema.prisma'),
  ]
  const schemaPath = candidates.find((p) => existsSync(p))

  if (!schemaPath) {
    warnings.push('No prisma/schema.prisma found — mercelle cannot infer the data model.')
    return { models: [], warnings }
  }

  const models = parsePrismaModels(schemaPath)
  if (models.length === 0) warnings.push('The prisma schema exposes no models to seed.')
  return { models, warnings }
}

/**
 * Deterministic PRNG (mulberry32) seeded per row, so the same project always
 * seeds the same believable data — snapshots stay reviewable in diffs.
 */
export function rowRng(...parts: (string | number)[]): () => number {
  const seed = createHash('sha256').update(parts.join('|')).digest()
  let a = seed.readUInt32LE(0)
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIRST = ['Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Ethan', 'Ivy', 'Owen']
const LAST = ['Baker', 'Chen', 'Diaz', 'Evans', 'Frost', 'Gray', 'Hale', 'Ito']
const WORDS = ['aurora', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'granite', 'harbor']

/** One synthetic row for a model. `n` is the row index (for determinism). */
export function mockRow(
  model: SeedModel,
  n: number,
  projectKey = 'axxes',
  /** Supplies values for scalar foreign-key columns; see `generateSeedSql`. */
  resolveFk?: (col: SeedColumn, n: number) => unknown,
): Record<string, unknown> {
  const rng = rowRng(projectKey, model.name, n)
  const pick = <T>(arr: T[]): T => {
    const at = arr[Math.floor(rng() * arr.length)]
    return (at ?? arr[0]) as T
  }
  const row: Record<string, unknown> = {}

  for (const col of model.columns) {
    if (col.relation) {
      // A relation field is a Prisma-level association, not a database column.
      // It must never be INSERTed; only its scalar FK column is.
      row[col.name] = null
      continue
    }
    if (col.foreignKey && resolveFk) {
      row[col.name] = resolveFk(col, n)
      continue
    }
    switch (col.type) {
      case 'uuid':
        row[col.name] = createHash('sha1').update(`${projectKey}:${model.name}:${n}:${col.name}`).digest('hex').slice(0, 8)
          .replace(/^(.{8})(.{4})/, '$1-$2')
        break
      case 'int':
        row[col.name] = col.name === 'id' ? n + 1 : Math.floor(rng() * 1000)
        break
      case 'float':
        row[col.name] = Math.round(rng() * 10_000) / 100
        break
      case 'boolean':
        row[col.name] = rng() > 0.5
        break
      case 'datetime':
        row[col.name] = new Date(Date.UTC(2026, 0, 1) + Math.floor(rng() * 240) * 86_400_000).toISOString()
        break
      case 'json':
        row[col.name] = JSON.stringify({ source: 'mercelle-mock', i: n })
        break
      case 'text':
        row[col.name] = `Synthetic ${model.name} row ${n + 1} generated by mercelle for local QA.`
        break
      default:
        if (/email/i.test(col.name)) row[col.name] = `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${n}@example.test`
        else if (/name/i.test(col.name)) row[col.name] = `${pick(FIRST)} ${pick(LAST)}`
        else if (/slug|key|token/i.test(col.name)) row[col.name] = `${pick(WORDS)}-${n + 1}`
        else row[col.name] = `${pick(WORDS)}-${model.name.toLowerCase()}-${n + 1}`
    }
  }
  return row
}

/** Quote a JS value for embedding in a SQL literal. */
function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return `'${String(v).replace(/'/g, "''")}'`
}

/**
 * Order models so that a model is inserted after everything it points at.
 *
 * A stable topological sort: relation-free models keep their schema order, and
 * a cycle degrades gracefully instead of looping forever.
 */
export function orderModels(models: SeedModel[]): SeedModel[] {
  const byName = new Map(models.map((m) => [m.name, m]))
  const out: SeedModel[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (model: SeedModel): void => {
    const seen = state.get(model.name)
    if (seen === 'done' || seen === 'visiting') return
    state.set(model.name, 'visiting')
    for (const col of model.columns) {
      const fk = col.foreignKey
      if (!fk) continue
      const parent = byName.get(fk.model)
      if (parent && parent !== model) visit(parent)
    }
    state.set(model.name, 'done')
    out.push(model)
  }

  for (const model of models) visit(model)
  return out
}

/** The columns that map to real database columns on `model`. */
function insertableColumns(model: SeedModel): SeedColumn[] {
  return model.columns.filter((c) => !c.list && !c.relation)
}

/** Generate INSERT statements for every model. `rowsPerModel` defaults to 10. */
export function generateSeedSql(plan: SeedPlan, opts: { rowsPerModel?: number; projectKey?: string } = {}): string {
  const rows = Math.max(0, Math.floor(opts.rowsPerModel ?? 10))
  const key = opts.projectKey ?? 'axxes'
  const out: string[] = ['-- mercelle synthetic seed data (no production rows — ever)']

  // Parents first, so every foreign key points at a row inserted above it.
  const ordered = orderModels(plan.models)

  // Rows are generated for every model up front so a child can borrow a real id
  // from its parent instead of inventing a value that violates the constraint.
  const generated = new Map<string, Record<string, unknown>[]>()
  for (const model of ordered) {
    const modelRows: Record<string, unknown>[] = []
    for (let i = 0; i < rows; i++) {
      modelRows.push(mockRow(model, i, key))
    }
    generated.set(model.name, modelRows)
  }

  for (const model of ordered) {
    const cols = insertableColumns(model)
    if (cols.length === 0) continue
    const colList = cols.map((c) => c.name).join(', ')
    out.push(`\n-- model: ${model.name}`)

    for (let i = 0; i < rows; i++) {
      const values = cols.map((c) => {
        const fk = c.foreignKey
        if (!fk) return sqlValue(generated.get(model.name)?.[i]?.[c.name])

        // Point at an actual generated parent row; fall back to NULL when the
        // referenced model is missing from this schema.
        const parents = generated.get(fk.model) ?? []
        if (parents.length === 0) return 'NULL'
        // Deterministic spread: every child lands on a real parent, cycling
        // through them so a small parent table still gets varied children.
        const pickIdx = rowRng(key, model.name, i, c.name)() * parents.length
        const parent = parents[Math.min(parents.length - 1, Math.floor(pickIdx))]
        return sqlValue(parent?.[fk.field])
      })
      out.push(`INSERT INTO "${model.name}" (${colList}) VALUES (${values.join(', ')});`)
    }
  }

  return out.join('\n') + '\n'
}
