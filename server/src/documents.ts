import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { PDFParse } from 'pdf-parse'
import sharp from 'sharp'
import { createWorker, OEM } from 'tesseract.js'
import type { Config } from './config.js'
import type { DocumentKind, ExtractedPage } from './types.js'
import { AppError } from './types.js'
import type { Store } from './store.js'

const require = createRequire(import.meta.url)
const MAX_PIXELS = 20_000_000
export const mediaTypes: Record<string, string> = {
  '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
}

async function recognize(image: Buffer, config: Config): Promise<string> {
  if (!config.ocrEnabled) throw new AppError(422, 'This file needs local OCR. Enable OCR_ENABLED; no data was sent externally.')
  const languages = config.ocrLanguages.split(/[+,]/).map(value => value.trim())
  if (!languages.length || languages.some(language => !['eng', 'hin'].includes(language))) {
    throw new AppError(422, 'This build supports packaged eng and hin OCR only.')
  }
  const assets = path.join(config.dataDir, 'ocr-languages')
  mkdirSync(assets, { recursive: true })
  for (const language of languages) {
    const metadata: { langPath: string } = require(`@tesseract.js-data/${language}`)
    copyFileSync(path.join(metadata.langPath, `${language}.traineddata.gz`), path.join(assets, `${language}.traineddata.gz`))
  }
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined
  let timer: NodeJS.Timeout | undefined
  try {
    worker = await createWorker(languages, OEM.LSTM_ONLY, {
      langPath: assets, cachePath: assets, cacheMethod: 'none',
      logger: () => {},
    })
    const result = await Promise.race([
      worker.recognize(image),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError(422, 'Local OCR timed out on this page.')), 45_000)
      }),
    ])
    return result.data.text.trim()
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(422, 'Local OCR failed. Check the bundled language assets and file quality.')
  } finally {
    clearTimeout(timer)
    if (worker) await worker.terminate()
  }
}

function parserFor(data: Buffer) {
  return new PDFParse({ data: new Uint8Array(data), verbosity: 0, isEvalSupported: false })
}

function validateGeometry(width: number, height: number) {
  if (!Number.isFinite(width * height) || width <= 0 || height <= 0 ||
      height / width > 40 || width / height > 40) {
    throw new AppError(422, 'Unsupported page dimensions; render this document safely before upload.')
  }
}

export async function extract(data: Buffer, suffix: string, config: Config): Promise<{
  pages: ExtractedPage[]; warnings: string[]
}> {
  const warnings: string[] = []
  let pages: ExtractedPage[]
  if (suffix === '.txt') {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data).trim() }
    catch { throw new AppError(422, 'Text files must use UTF-8 encoding.') }
    if (text.includes('\0')) throw new AppError(422, 'This is not a supported text document.')
    pages = [{ number: 1, text, extraction: 'native_text', tables: [], width: null, height: null }]
  } else if (['.png', '.jpg', '.jpeg'].includes(suffix)) {
    let image: Buffer
    let width: number | undefined
    let height: number | undefined
    try {
      const decoder = sharp(data, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
      const metadata = await decoder.metadata()
      width = metadata.width; height = metadata.height
      if (!width || !height) throw new Error('Missing image geometry.')
      image = await decoder.rotate().resize({ width: 1800, height: 2400, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    } catch { throw new AppError(422, 'Invalid or oversized image file.') }
    const text = await recognize(image, config)
    pages = [{ number: 1, text, extraction: 'ocr', tables: [], width, height }]
    warnings.push('OCR text may lose table alignment or footnotes. Inspect the original image.')
  } else if (suffix === '.pdf') {
    if (!data.subarray(0, 1024).toString('latin1').trimStart().startsWith('%PDF-')) {
      throw new AppError(422, 'This file does not have a PDF signature.')
    }
    const parser = parserFor(data)
    try {
      const info = await parser.getInfo({ parsePageInfo: true })
      if (info.total < 1 || info.total > config.maxPages) throw new AppError(422, `Use a PDF with 1-${config.maxPages} pages.`)
      info.pages.forEach(page => validateGeometry(page.width, page.height))
      const textResult = await parser.getText()
      let tablePages: Awaited<ReturnType<typeof parser.getTable>>['pages'] = []
      try { tablePages = (await parser.getTable()).pages }
      catch { warnings.push('Table-structure extraction failed; plain text is retained. Verify the original tables manually.') }
      pages = []
      for (const page of textResult.pages) {
        let text = page.text.trim()
        let extraction: ExtractedPage['extraction'] = 'native_text'
        const metadata = info.pages.find(item => item.pageNumber === page.num)
        if ((text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 20) {
          if (config.ocrEnabled) {
            const image = await parser.getScreenshot({ partial: [page.num], desiredWidth: 1600, imageDataUrl: false })
            text = await recognize(Buffer.from(image.pages[0].data), config)
            extraction = 'ocr'
            warnings.push(`Page ${page.num} used local OCR; inspect any tables and critical numbers.`)
          } else {
            extraction = 'unreadable'
            warnings.push(`Page ${page.num} has little or no text. Enable OCR before relying on completeness.`)
          }
        }
        const tables = (tablePages.find(item => item.num === page.num)?.tables ?? []).map(rows => ({
          rows: rows.map(row => row.map(cell => cell.replace(/\s+/g, ' ').trim())), bbox: [],
        }))
        for (const [index, table] of tables.entries()) {
          text += `\n\nTABLE ${index + 1}\n${table.rows.map(row => row.join(' | ')).join('\n')}`
        }
        pages.push({
          number: page.num, text, extraction, tables,
          width: metadata?.width ?? null, height: metadata?.height ?? null,
        })
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(422, 'PDF extraction failed. The document may be encrypted, damaged or unsupported.')
    } finally { await parser.destroy() }
  } else throw new AppError(422, 'Supported files are PDF, PNG, JPG and UTF-8 TXT. Excel BOQs are not yet supported.')
  if (!pages.some(page => page.text.trim().length >= 20)) {
    throw new AppError(422, 'No usable text was extracted. Check the file or enable OCR.')
  }
  return { pages, warnings: [...new Set(warnings)] }
}

export async function ingest(
  store: Store, config: Config, packageId: string, name: string, data: Buffer,
  kind: DocumentKind, issuedOn: string | null = null, amends: string | null = null,
) {
  store.getPackage(packageId)
  const suffix = path.extname(name).toLowerCase()
  if (!mediaTypes[suffix]) throw new AppError(422, 'Supported files are PDF, PNG, JPG and UTF-8 TXT. Excel BOQs are not yet supported.')
  if (data.length > config.maxUploadBytes) throw new AppError(413, 'File exceeds the 15 MB upload limit.')
  if (amends) {
    store.document(packageId, amends)
    if (kind !== 'corrigendum') throw new AppError(422, 'Only a corrigendum can declare an amended document.')
  }
  const result = await extract(data, suffix, config)
  return store.saveDocument(
    packageId, name, data, mediaTypes[suffix], kind, issuedOn, amends,
    result.pages, result.warnings, config.maxDocuments,
  )
}

export async function pagePng(store: Store, packageId: string, documentId: string, pageNumber: number): Promise<Buffer> {
  const document = store.document(packageId, documentId)
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.page_count) throw new AppError(422, 'Page does not exist.')
  const data = readFileSync(path.join(store.uploads, documentId))
  if (document.media_type === 'application/pdf') {
    const parser = parserFor(data)
    try {
      const info = store.pages(packageId, documentId).find(page => page.number === pageNumber)!
      if (info.width && info.height) validateGeometry(info.width, info.height)
      const image = await parser.getScreenshot({ partial: [pageNumber], desiredWidth: 1300, imageDataUrl: false })
      return Buffer.from(image.pages[0].data)
    } finally { await parser.destroy() }
  }
  if (document.media_type.startsWith('image/')) {
    return sharp(data, { limitInputPixels: MAX_PIXELS }).rotate()
      .resize({ width: 1500, height: 2000, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
  }
  throw new AppError(422, 'Text documents have no original page image.')
}
