import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { loadConfig } from '../src/config.js'
import { Store } from '../src/store.js'
import { seedDemo } from '../src/demo.js'
import { Retriever } from '../src/retrieval.js'
import { normalized } from '../src/answering.js'

const config = loadConfig()
const store = new Store(config.dataDir)
try {
  const data = z.object({
    dataset_id: z.string(),
    questions: z.array(z.object({ id: z.string(), question: z.string(), required_documents: z.array(z.string()) })),
    evidence_anchors: z.record(z.string(), z.object({ document: z.string(), page: z.number().int().min(1), quote: z.string() })),
  }).passthrough().parse(JSON.parse(readFileSync('datasets/synthetic-development.json', 'utf8')))
  const demo = await seedDemo(store, config)
  const retriever = new Retriever(config)
  const results = []
  for (const question of data.questions) {
    const result = await retriever.search(store.evidence(demo.id), question.question)
    const found = new Set(result.evidence.map(item => item.document_name))
    const anchor = data.evidence_anchors[question.id]
    if (!anchor) throw new Error(`Missing evidence annotation for ${question.id}.`)
    results.push({
      question_id: question.id,
      required_source_documents_found: question.required_documents.every(name => found.has(name)),
      required_evidence_span_found: result.evidence.some(item =>
        item.document_name === anchor.document && item.page === anchor.page &&
        normalized(item.text).includes(normalized(anchor.quote))),
      retrieved: [...found], warnings: result.warnings,
    })
  }
  const report = {
    dataset: data.dataset_id, retrieval_mode: config.retrievalMode,
    notice: 'Synthetic development document and evidence-span coverage only. No LLM answers were evaluated.',
    results,
  }
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(path.join(config.dataDir, 'retrieval-development-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { store.close() }
