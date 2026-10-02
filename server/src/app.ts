import express, { type ErrorRequestHandler, type Request } from 'express'
import multer from 'multer'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { Store } from './store.js'
import { Retriever } from './retrieval.js'
import { ingest, pagePng } from './documents.js'
import { seedDemo } from './demo.js'
import { buildPrompt, collectImages, generate } from './answering.js'
import { AppError, kindSchema, type Answer, type ModelAnswer } from './types.js'

const askSchema = z.object({
  question: z.string().trim().min(3).max(1600),
  provider: z.enum(['evidence', 'gemma', 'ollama']).default('evidence'),
  consent_external: z.boolean().default(false),
  include_images: z.boolean().default(false),
})
const parameter = (request: Request, key: string) => z.string().parse(request.params[key])
const origins = new Set([
  'http://localhost:8000', 'http://127.0.0.1:8000',
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:8765', 'http://127.0.0.1:8765',
])

export function createApp(config: Config = loadConfig()) {
  const app = express()
  const store = new Store(config.dataDir)
  const retriever = new Retriever(config)
  const allowedOrigins = new Set([...origins, `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`])
  app.disable('x-powered-by')
  app.use((request, response, next) => {
    const host = request.hostname
    if (!['127.0.0.1', 'localhost'].includes(host)) {
      response.status(400).json({ detail: 'Host not allowed.' }); return
    }
    response.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
    })
    const origin = request.get('origin')
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({ detail: 'Origin not allowed.' }); return
    }
    if (origin) {
      response.set('Access-Control-Allow-Origin', origin)
      response.vary('Origin')
      response.set('Access-Control-Allow-Headers', 'Content-Type, X-TenderLens-Client')
      response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    }
    if (request.method === 'OPTIONS') { response.status(204).end(); return }
    if (request.path.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method) &&
        request.get('x-tenderlens-client') !== 'browser') {
      response.status(403).json({ detail: 'Missing application request header.' }); return
    }
    next()
  })
  app.use(express.json({ limit: '32kb', strict: true }))
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4, fieldSize: 1000, parts: 6 },
  })

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', country: 'IN', version: '0.2.0', runtime: 'node' })
  })
  app.get('/api/config', (_request, response) => {
    response.json({
      country: 'IN', gemma_model: config.gemmaModel, google_configured: Boolean(config.geminiKey),
      google_free_tier_confirmed: config.freeTierConfirmed,
      ollama_model: config.ollamaModel, retrieval_mode: config.retrievalMode, rerank_enabled: false,
      ocr_enabled: config.ocrEnabled, ocr_languages: config.ocrLanguages,
      max_upload_mb: config.maxUploadBytes / 1024 / 1024, max_pages: config.maxPages,
      single_user: true, free_only: true,
    })
  })
  app.get('/api/packages', (_request, response) => { response.json(store.packages()) })
  app.post('/api/packages', (request, response) => {
    const body = z.object({
      name: z.string().trim().min(3).max(120), reference: z.string().max(100).default(''),
    }).parse(request.body)
    response.status(201).json(store.createPackage(body.name, body.reference))
  })
  app.post('/api/demo', async (_request, response) => {
    response.status(201).json(await seedDemo(store, config))
  })
  app.get('/api/packages/:packageId', (request, response) => {
    const id = parameter(request, 'packageId')
    response.json({ ...store.getPackage(id), documents: store.documents(id), messages: store.history(id) })
  })
  app.post('/api/packages/:packageId/documents', upload.single('file'), async (request, response) => {
    const id = parameter(request, 'packageId')
    store.getPackage(id)
    if (!request.file) throw new AppError(422, 'Choose a document to upload.')
    const input = z.object({
      kind: kindSchema.default('tender'), issued_on: z.string().optional(),
      amends_document_id: z.string().optional(),
    }).parse(request.body)
    if (input.issued_on && (!/^\d{4}-\d{2}-\d{2}$/.test(input.issued_on) ||
        Number.isNaN(Date.parse(input.issued_on)) || new Date(input.issued_on).toISOString().slice(0, 10) !== input.issued_on)) {
      throw new AppError(422, 'Issue date must be a valid YYYY-MM-DD date.')
    }
    response.status(201).json(await ingest(
      store, config, id, request.file.originalname, request.file.buffer,
      input.kind, input.issued_on || null, input.amends_document_id || null,
    ))
  })
  app.get('/api/packages/:packageId/documents/:documentId/pages', (request, response) => {
    response.json(store.pages(parameter(request, 'packageId'), parameter(request, 'documentId')))
  })
  app.get('/api/packages/:packageId/documents/:documentId/file', (request, response) => {
    const document = store.document(parameter(request, 'packageId'), parameter(request, 'documentId'))
    response.download(path.join(store.uploads, document.id), document.name)
  })
  app.get('/api/packages/:packageId/documents/:documentId/pages/:number/image', async (request, response) => {
    const number = z.coerce.number().int().min(1).parse(parameter(request, 'number'))
    const image = await pagePng(store, parameter(request, 'packageId'), parameter(request, 'documentId'), number)
    response.type('png').send(image)
  })
  app.post('/api/packages/:packageId/ask', async (request, response) => {
    const id = parameter(request, 'packageId')
    store.getPackage(id)
    const input = askSchema.parse(request.body)
    if (input.provider === 'gemma') {
      if (!input.consent_external) throw new AppError(403, 'Confirm permission to share selected excerpts, recent questions and optional images with Google.')
      if (!config.geminiKey) throw new AppError(503, 'Set GEMINI_API_KEY in the server .env, then restart.')
      if (!config.freeTierConfirmed) throw new AppError(403, 'Free-tier project confirmation is required. Do not enable billing.')
    }
    const started = performance.now()
    const history = store.history(id, 3)
    const query = input.question.split(/\s+/).length < 7 && history.length
      ? `${history.at(-1)!.question} ${input.question}` : input.question
    const { evidence, warnings } = await retriever.search(store.evidence(id), query)
    warnings.push(...store.documents(id).flatMap(document => document.warnings))
    let base: ModelAnswer | Pick<Answer, 'status' | 'answer' | 'citations' | 'missing'>
    let imageCount = 0
    let generated = false
    if (!evidence.length) {
      base = {
        status: 'insufficient',
        answer: 'No matching passages were retrieved. Try the exact clause or item wording. This is not proof that the information is absent from the tender.',
        citations: [], missing: ['Relevant readable source passages'],
      }
    } else if (input.provider === 'evidence') {
      base = {
        status: 'evidence',
        answer: 'Here are the closest matching passages. Open the sources to check wording, dates and conditions. This is local evidence search, not an AI-generated conclusion.',
        citations: [], missing: [],
      }
    } else {
      const images = input.include_images ? await collectImages(store, id, evidence) : []
      base = await generate(config, input.provider, buildPrompt(input.question, evidence, history, warnings), images, evidence)
      imageCount = images.length
      generated = true
      warnings.push('Source IDs and quoted text were checked. This does not verify every claim; inspect the originals before acting.')
    }
    const result: Answer = {
      ...base, sources: evidence, warnings: [...new Set(warnings)],
      answer_kind: generated ? 'generated' : 'evidence_only',
      provider: generated ? input.provider : 'evidence',
      model: generated ? (input.provider === 'gemma' ? config.gemmaModel : config.ollamaModel) : null,
      elapsed_seconds: Math.round((performance.now() - started) / 10) / 100,
      retrieval_mode: config.retrievalMode, image_count: imageCount,
    }
    response.json(store.saveMessage(id, input.question, result))
  })
  app.use('/api', (_request, response) => { response.status(404).json({ detail: 'API route not found.' }) })
  if (existsSync(path.join(config.frontendDir, 'index.html'))) {
    app.use(express.static(config.frontendDir, { dotfiles: 'deny' }))
  }
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({ detail: error.message }); return
    }
    if (error instanceof z.ZodError) {
      response.status(422).json({ detail: 'Some inputs are invalid. Check required fields, lengths and dates.' }); return
    }
    if (error instanceof multer.MulterError) {
      response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 422).json({ detail: 'Upload limit exceeded or invalid multipart upload.' }); return
    }
    const incident = randomUUID().slice(0, 8)
    console.error(`Request failed ${incident}: ${error instanceof Error ? error.name : 'UnknownError'}`)
    response.status(500).json({ detail: `An internal error interrupted this action. Reference ${incident}. No success was recorded.` })
  }
  app.use(errors)
  return { app, store, config, retriever }
}
