import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import type { Answer, Chunk, ExtractedPage, Message, Package, Page, TenderDocument, DocumentKind } from './types.js'
import { AppError, kindSchema } from './types.js'

const id = () => randomUUID().replaceAll('-', '')
const now = () => new Date().toISOString()
const packageSchema = z.object({
  id: z.string(), name: z.string(), reference: z.string(), created_at: z.string(),
  demo_key: z.string().nullable(), document_count: z.number().optional(), page_count: z.number().optional(),
})
const documentSchema = z.object({
  id: z.string(), package_id: z.string(), name: z.string(), kind: kindSchema,
  issued_on: z.string().nullable(), amends_document_id: z.string().nullable(),
  sha256: z.string(), media_type: z.string(), page_count: z.number(),
  warnings: z.string().transform(value => z.array(z.string()).parse(JSON.parse(value))),
  created_at: z.string(),
})
const chunkSchema = z.object({
  id: z.string(), text: z.string(), ordinal: z.number(), page: z.number(), extraction: z.string(),
  document_id: z.string(), document_name: z.string(), kind: kindSchema,
  issued_on: z.string().nullable(), amends_document_id: z.string().nullable(),
})

export function chunkText(input: string, size = 1400, overlap = 180): string[] {
  const text = input.replace(/[ \t]+/g, ' ').trim()
  const result: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + size, text.length)
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end)
      if (boundary > start + size / 2) end = boundary
    }
    result.push(text.slice(start, end))
    if (end === text.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return result
}

export class Store {
  readonly db: DatabaseSync
  readonly uploads: string
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
    this.uploads = path.join(root, 'uploads')
    mkdirSync(this.uploads, { recursive: true })
    this.db = new DatabaseSync(path.join(root, 'tenderlens.sqlite3'))
    this.db.exec(`
      PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;
      CREATE TABLE IF NOT EXISTS packages(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, reference TEXT NOT NULL,
        created_at TEXT NOT NULL, demo_key TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS documents(
        id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES packages(id),
        name TEXT NOT NULL, kind TEXT NOT NULL, issued_on TEXT,
        amends_document_id TEXT REFERENCES documents(id), sha256 TEXT NOT NULL,
        media_type TEXT NOT NULL, page_count INTEGER NOT NULL,
        warnings TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(package_id,sha256));
      CREATE TABLE IF NOT EXISTS pages(
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
        number INTEGER NOT NULL, text TEXT NOT NULL, tables_json TEXT NOT NULL,
        extraction TEXT NOT NULL, width REAL, height REAL, UNIQUE(document_id,number));
      CREATE TABLE IF NOT EXISTS chunks(
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id), ordinal INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES packages(id),
        question TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_package ON documents(package_id);
    `)
  }
  close() { this.db.close() }
  createPackage(name: string, reference = '', demoKey: string | null = null): Package {
    const identifier = id()
    this.db.prepare('INSERT INTO packages VALUES (?,?,?,?,?)').run(identifier, name.trim(), reference.trim(), now(), demoKey)
    return this.getPackage(identifier)
  }
  getPackage(identifier: string): Package {
    const row = this.db.prepare('SELECT * FROM packages WHERE id=?').get(identifier)
    if (!row) throw new AppError(404, 'Tender package not found.')
    return packageSchema.parse(row)
  }
  packages(): Package[] {
    return this.db.prepare(`SELECT p.*,COUNT(d.id) AS document_count,COALESCE(SUM(d.page_count),0) AS page_count
      FROM packages p LEFT JOIN documents d ON d.package_id=p.id GROUP BY p.id ORDER BY p.created_at DESC`)
      .all().map(row => packageSchema.parse(row))
  }
  documents(packageId: string): TenderDocument[] {
    this.getPackage(packageId)
    return this.db.prepare('SELECT * FROM documents WHERE package_id=? ORDER BY created_at').all(packageId)
      .map(row => documentSchema.parse(row))
  }
  document(packageId: string, documentId: string): TenderDocument {
    const row = this.documents(packageId).find(document => document.id === documentId)
    if (!row) throw new AppError(404, 'Document not found in this package.')
    return row
  }
  pages(packageId: string, documentId: string): Page[] {
    this.document(packageId, documentId)
    const schema = z.object({
      id: z.string(), document_id: z.string(), number: z.number(), text: z.string(),
      extraction: z.enum(['native_text', 'ocr', 'unreadable']), width: z.number().nullable(),
      height: z.number().nullable(), tables_json: z.string(),
    })
    const tableSchema = z.array(z.object({ rows: z.array(z.array(z.string())), bbox: z.array(z.number()) }))
    return this.db.prepare('SELECT * FROM pages WHERE document_id=? ORDER BY number').all(documentId).map(row => {
      const page = schema.parse(row)
      return { ...page, tables: tableSchema.parse(JSON.parse(page.tables_json)) }
    })
  }
  evidence(packageId: string): Chunk[] {
    this.getPackage(packageId)
    return this.db.prepare(`SELECT c.id,c.text,c.ordinal,p.number AS page,p.extraction,
      d.id AS document_id,d.name AS document_name,d.kind,d.issued_on,d.amends_document_id
      FROM chunks c JOIN pages p ON p.id=c.page_id JOIN documents d ON d.id=p.document_id
      WHERE d.package_id=? ORDER BY d.created_at,p.number,c.ordinal`).all(packageId).map(row => chunkSchema.parse(row))
  }
  history(packageId: string, limit = 60): Message[] {
    this.getPackage(packageId)
    const schema = z.object({ id: z.string(), package_id: z.string(), question: z.string(), result: z.string(), created_at: z.string() })
    return this.db.prepare('SELECT * FROM messages WHERE package_id=? ORDER BY created_at DESC LIMIT ?').all(packageId, limit)
      .reverse().map(row => {
        const entry = schema.parse(row)
        // Results are written only by the validated answer/evidence pipeline.
        return { ...entry, result: JSON.parse(entry.result) as Answer }
      })
  }
  saveMessage(packageId: string, question: string, result: Answer): Message {
    const record = { id: id(), package_id: packageId, question, result, created_at: now() }
    this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(
      record.id, packageId, question, JSON.stringify(result), record.created_at,
    )
    return record
  }
  saveDocument(
    packageId: string, name: string, data: Buffer, mediaType: string, kind: DocumentKind,
    issuedOn: string | null, amends: string | null, pages: ExtractedPage[], warnings: string[],
    maxDocuments: number,
  ): TenderDocument {
    this.getPackage(packageId)
    if (amends) {
      this.document(packageId, amends)
      if (kind !== 'corrigendum') throw new AppError(422, 'Only a corrigendum can declare an amended document.')
    }
    const digest = createHash('sha256').update(data).digest('hex')
    const documentId = id()
    const file = path.join(this.uploads, documentId)
    let written = false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const documents = this.documents(packageId)
      if (documents.some(document => document.sha256 === digest)) throw new AppError(422, 'This exact file is already in the package.')
      if (documents.length >= maxDocuments) throw new AppError(422, 'The package document limit was reached.')
      writeFileSync(file, data, { flag: 'wx', mode: 0o600 }); written = true
      this.db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        documentId, packageId, name.replaceAll('\\', '/').split('/').at(-1)!.slice(0, 180),
        kind, issuedOn, amends, digest, mediaType, pages.length, JSON.stringify(warnings), now(),
      )
      for (const page of pages) {
        const pageId = id()
        this.db.prepare('INSERT INTO pages VALUES (?,?,?,?,?,?,?,?)').run(
          pageId, documentId, page.number, page.text, JSON.stringify(page.tables),
          page.extraction, page.width, page.height,
        )
        for (const [ordinal, text] of chunkText(page.text).entries()) {
          this.db.prepare('INSERT INTO chunks VALUES (?,?,?,?)').run(id(), pageId, ordinal, text)
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      if (written) unlinkSync(file)
      throw error
    }
    return this.document(packageId, documentId)
  }
}
