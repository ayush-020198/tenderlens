import { readFileSync } from 'node:fs'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import { z } from 'zod'
import type { Store } from './store.js'
import type { Config } from './config.js'
import { extract } from './documents.js'
import { kindSchema, type Package, type TenderDocument } from './types.js'

const demoSchema = z.object({
  name: z.string(), reference: z.string(),
  documents: z.array(z.object({
    name: z.string(), kind: kindSchema, issued_on: z.string(),
    amends_index: z.number().optional(),
    pages: z.array(z.object({
      title: z.string(), text: z.string(),
      table: z.array(z.array(z.string())).optional(), footnote: z.string().optional(),
    })),
  })),
})
type DemoPage = z.infer<typeof demoSchema>['documents'][number]['pages'][number]

export function makePdf(pages: DemoPage[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: false })
    const chunks: Buffer[] = []
    doc.on('data', chunk => chunks.push(Buffer.from(chunk)))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    for (const page of pages) {
      doc.addPage()
      doc.font('Helvetica-Bold').fontSize(20).text(page.title)
      doc.moveDown(0.8)
      doc.font('Helvetica').fontSize(10).text(page.text, { lineGap: 4 })
      doc.moveDown()
      if (page.table) {
        const widths = [35, 205, 55, 70, 130]
        let y = doc.y
        for (const [rowIndex, row] of page.table.entries()) {
          doc.font(rowIndex === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
          const height = Math.max(28, ...row.map((cell, index) => doc.heightOfString(cell, { width: (widths[index] ?? 70) - 12 }) + 14))
          let x = 50
          for (const [index, cell] of row.entries()) {
            const width = widths[index] ?? 70
            doc.lineWidth(0.5).rect(x, y, width, height).stroke()
            doc.text(cell, x + 6, y + 7, { width: width - 12, height: height - 10 })
            x += width
          }
          y += height
        }
        doc.font('Helvetica').fontSize(9).text(page.footnote ?? '', 50, y + 18, { width: 495 })
      }
    }
    doc.end()
  })
}

const pending = new WeakMap<Store, Promise<Package>>()
export async function seedDemo(store: Store, config: Config): Promise<Package> {
  const existing = store.packages().find(item => item.demo_key === 'india-node-v1')
  if (existing) return existing
  const inFlight = pending.get(store)
  if (inFlight) return inFlight
  const work = (async () => {
    const demo = demoSchema.parse(JSON.parse(readFileSync(path.resolve('fixtures/demo.json'), 'utf8')))
    const prepared = []
    for (const item of demo.documents) {
      const bytes = await makePdf(item.pages)
      prepared.push({ item, bytes, extracted: await extract(bytes, '.pdf', config) })
    }
    const item = store.createPackage(demo.name, demo.reference, 'india-node-v1')
    const saved: TenderDocument[] = []
    try {
      for (const document of prepared) {
        saved.push(store.saveDocument(
          item.id, document.item.name, document.bytes, 'application/pdf', document.item.kind,
          document.item.issued_on,
          document.item.amends_index !== undefined ? saved[document.item.amends_index].id : null,
          document.extracted.pages, document.extracted.warnings, config.maxDocuments,
        ))
      }
      return item
    } catch (error) {
      store.db.prepare('UPDATE packages SET demo_key=NULL,name=? WHERE id=?').run(`${demo.name} (incomplete seed)`, item.id)
      throw error
    }
  })()
  pending.set(store, work)
  try { return await work } finally { pending.delete(store) }
}
