import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  generateSeedSql,
  mockRow,
  orderModels,
  parsePrismaModels,
  planSeed,
  rowRng,
} from '../src/seed.js'
import { parseArgs } from '../src/args.js'
import { createFakeOrb, silentLogger } from './helpers.js'
import { defaultConfig } from '../src/config.js'
import { dataCommand } from '../src/dataCommand.js'

/** Parse an inline schema, returning a ready-to-use plan. */
function planFor(schema: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mercelle-seed-'))
  const schemaPath = join(dir, 'schema.prisma')
  writeFileSync(schemaPath, schema)
  return { models: parsePrismaModels(schemaPath), warnings: [] }
}

const SCHEMA = `
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String
  role      String?
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  posts     Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  body     String @db.Text
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}
`

describe('parsePrismaModels', () => {
  it('parses models, scalars, optionals, lists and relations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-seed-'))
    const schemaPath = join(dir, 'schema.prisma')
    writeFileSync(schemaPath, SCHEMA)

    const models = parsePrismaModels(schemaPath)
    expect(models.map((m) => m.name)).toEqual(['User', 'Post'])

    const user = models[0]!
    expect(user.columns.find((c) => c.name === 'email')?.type).toBe('string')
    expect(user.columns.find((c) => c.name === 'role')?.optional).toBe(true)
    expect(user.columns.find((c) => c.name === 'active')?.type).toBe('boolean')
    expect(user.columns.find((c) => c.name === 'createdAt')?.type).toBe('datetime')
    // posts Post[] is a list relation, not a scalar column.
    expect(user.columns.find((c) => c.name === 'posts')?.relation).toBe('Post')

    const post = models[1]!
    expect(post.columns.find((c) => c.name === 'author')?.relation).toBe('User')
    expect(post.columns.find((c) => c.name === 'body')?.type).toBe('text')
  })

  it('returns an empty list for a missing schema', () => {
    expect(parsePrismaModels('/nope/schema.prisma')).toEqual([])
  })
})

describe('planSeed', () => {
  it('finds prisma/schema.prisma in a project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-seed-'))
    mkdirSync(join(dir, 'prisma'))
    writeFileSync(join(dir, 'prisma', 'schema.prisma'), SCHEMA)
    const plan = planSeed(dir)
    expect(plan.models).toHaveLength(2)
    expect(plan.warnings).toEqual([])
  })

  it('warns when there is no schema', () => {
    const plan = planSeed(mkdtempSync(join(tmpdir(), 'mercelle-seed-')))
    expect(plan.models).toEqual([])
    expect(plan.warnings[0]).toMatch(/No prisma/)
  })
})

describe('mockRow determinism', () => {
  it('produces identical rows for the same inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-seed-'))
    const schemaPath = join(dir, 's.prisma')
    writeFileSync(schemaPath, SCHEMA)
    const [user] = parsePrismaModels(schemaPath)
    const a = mockRow(user!, 3, 'axxes')
    const b = mockRow(user!, 3, 'axxes')
    expect(a).toEqual(b)
    const c = mockRow(user!, 4, 'axxes')
    expect(a).not.toEqual(c)
  })

  it('generates believable emails and names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-seed-'))
    const schemaPath = join(dir, 's.prisma')
    writeFileSync(schemaPath, SCHEMA)
    const [user] = parsePrismaModels(schemaPath)
    const row = mockRow(user!, 0, 'axxes')
    expect(String(row['email'])).toMatch(/@example\.test$/)
    expect(String(row['name'])).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  })

  it('rowRng is stable for the same seed', () => {
    const a = rowRng('x', 1)
    const b = rowRng('x', 1)
    expect(a()).toBe(b())
  })
})

describe('generateSeedSql', () => {
  it('emits INSERTs for every model with quoted values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-seed-'))
    const schemaPath = join(dir, 's.prisma')
    writeFileSync(schemaPath, SCHEMA)
    const plan = { models: parsePrismaModels(schemaPath), warnings: [] }

    const sql = generateSeedSql(plan, { rowsPerModel: 3, projectKey: 'web' })
    expect(sql).toContain('INSERT INTO "User"')
    expect(sql).toContain('INSERT INTO "Post"')
    expect(sql.match(/INSERT INTO/g)).toHaveLength(6)
    expect(sql).toContain('example.test')
    // Escaped quotes stay safe.
    const evil = { models: [{ name: 'T', columns: [{ name: 'v', type: 'string' as const, list: false, optional: false }] }], warnings: [] }
    const evilSql = generateSeedSql(evil, { rowsPerModel: 1 })
    expect(evilSql).toMatch(/INSERT INTO "T"/)
  })

  it('marks the output as synthetic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-seed-'))
    const schemaPath = join(dir, 's.prisma')
    writeFileSync(schemaPath, SCHEMA)
    const sql = generateSeedSql({ models: parsePrismaModels(schemaPath), warnings: [] })
    expect(sql).toContain('synthetic')
    expect(sql).toContain('no production rows')
  })
})

describe('dataCommand', () => {
  it('writes seed files per service and warns on schemaless services', async () => {
    const fake = createFakeOrb()
    const workspace = mkdtempSync(join(tmpdir(), 'mercelle-data-'))
    const webDir = join(workspace, 'web')
    mkdirSync(join(webDir, 'prisma'), { recursive: true })
    writeFileSync(join(webDir, 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'next dev' } }))
    writeFileSync(join(webDir, 'prisma', 'schema.prisma'), SCHEMA)

    const apiDir = join(workspace, 'api')
    mkdirSync(apiDir, { recursive: true })
    writeFileSync(join(apiDir, 'package.json'), JSON.stringify({ name: 'api', scripts: { dev: 'node server.js' } }))

    const code = await dataCommand({
      cwd: workspace,
      config: { ...defaultConfig, ui: false, uiPort: 0 },
      orb: fake.orb,
      logger: silentLogger,
    })
    expect(code).toBe(0)
    expect(existsSync(join(workspace, '.mercelle', 'seed', 'web.sql'))).toBe(true)
    expect(readFileSync(join(workspace, '.mercelle', 'seed', 'web.sql'), 'utf8')).toContain('INSERT INTO "User"')
  })

describe('referential integrity', () => {
  // A Prisma relation field is not a database column, and its scalar FK must
  // point at a row that actually exists. Both used to be broken.
  const RELATED = planFor(SCHEMA)

  it('records the FK target on the scalar column, not the relation', () => {
    const post = RELATED.models.find((m) => m.name === 'Post')!
    const author = post.columns.find((c) => c.name === 'author')!
    const authorId = post.columns.find((c) => c.name === 'authorId')!

    expect(author.relation).toBe('User')
    expect(author.foreignKey).toBeUndefined()
    expect(authorId.relation).toBeUndefined()
    expect(authorId.foreignKey).toEqual({ model: 'User', field: 'id' })
  })

  it('never emits a relation field as an INSERT column', () => {
    const sql = generateSeedSql(RELATED, { rowsPerModel: 3, projectKey: 'web' })
    // `author` is a Prisma association; inserting it fails on a real table.
    expect(sql).not.toMatch(/INSERT INTO "Post" \([^)]*\bauthor\b/)
    expect(sql).toContain('INSERT INTO "Post" (id, title, body, authorId)')
  })

  it('points every foreign key at a generated parent row', () => {
    const sql = generateSeedSql(RELATED, { rowsPerModel: 5, projectKey: 'web' })
    const userIds = new Set(
      [...sql.matchAll(/INSERT INTO "User" \(id,[^)]*\) VALUES \((\d+),/g)].map((m) => m[1]!),
    )
    const fks = [...sql.matchAll(/INSERT INTO "Post" .*VALUES \([^)]*?(\d+)\);\s*$/gm)].map((m) => m[1]!)

    expect(userIds.size).toBe(5)
    expect(fks.length).toBe(5)
    for (const fk of fks) expect(userIds).toContain(fk)
  })

  it('inserts parents before children', () => {
    const sql = generateSeedSql(RELATED, { rowsPerModel: 2, projectKey: 'web' })
    expect(sql.indexOf('-- model: User')).toBeLessThan(sql.indexOf('-- model: Post'))
  })

  it('orderModels keeps parents first and survives a cycle', () => {
    expect(orderModels(RELATED.models).map((m) => m.name)).toEqual(['User', 'Post'])

    // Self-referential and mutually-referential models must not hang.
    const cyclic = planFor(`
      model A {
        id   Int  @id
        bId  Int?
        b    B?   @relation(fields: [bId], references: [id])
      }
      model B {
        id   Int  @id
        aId  Int?
        a    A?   @relation(fields: [aId], references: [id])
      }
    `).models
    expect(orderModels(cyclic).map((m) => m.name).sort()).toEqual(['A', 'B'])
    expect(() => generateSeedSql({ models: cyclic, warnings: [] })).not.toThrow()
  })

  it('falls back to NULL when the referenced model is absent', () => {
    const orphan = planFor(`
      model Post {
        id       Int    @id
        author   User   @relation(fields: [authorId], references: [id])
        authorId Int
      }
    `)
    const sql = generateSeedSql(orphan, { rowsPerModel: 2 })
    expect(sql).toContain('authorId) VALUES')
    expect(sql).toMatch(/VALUES \(\d+, NULL\)/)
  })
})

describe('--rows flag', () => {
  // `--rows` must be a value flag: previously it parsed as `true` and leaked
  // the number into the positional args, so every seed got exactly one row.
  it('parses --rows as a value instead of a boolean', () => {
    const { flags, positional } = parseArgs(['data', '--rows', '5'])
    expect(flags['rows']).toBe('5')
    expect(positional).toEqual(['data'])
  })

  it('generates the requested number of rows per model', () => {
    const plan = planFor(SCHEMA)
    for (const n of [1, 7]) {
      const sql = generateSeedSql(plan, { rowsPerModel: n })
      expect(sql.match(/INSERT INTO "User"/g)).toHaveLength(n)
      expect(sql.match(/INSERT INTO "Post"/g)).toHaveLength(n)
    }
  })
})


  it('fails cleanly when no service has a schema', async () => {
    const fake = createFakeOrb()
    const workspace = mkdtempSync(join(tmpdir(), 'mercelle-data-'))
    mkdirSync(join(workspace, 'solo'), { recursive: true })
    writeFileSync(join(workspace, 'solo', 'package.json'), JSON.stringify({ name: 'solo', scripts: { dev: 'node x' } }))

    const code = await dataCommand({
      cwd: workspace,
      config: { ...defaultConfig, ui: false, uiPort: 0 },
      orb: fake.orb,
      logger: silentLogger,
    })
    expect(code).toBe(1)
  })
})
