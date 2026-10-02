import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Config } from './config.js'
import type { Chunk, Evidence } from './types.js'
import { AppError } from './types.js'

const stop = new Set('the a an of to is are in for and or what which how does do with this it by be can i'.split(' '))
const expansions: Record<string, string> = {
  emd: 'earnest money deposit bid security', deadline: 'submission closing due date',
  turnover: 'annual financial eligibility revenue', msme: 'mse exemption exempt udyam',
  gst: 'goods services tax inclusive exclusive', boq: 'bill quantities quantity specification schedule',
  corrigendum: 'amendment revised extension', अंतिम: 'deadline submission closing',
  जमानत: 'emd earnest money security',
}
export const tokens = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(token => !stop.has(token))
export const expand = (question: string) => question + ' ' + tokens(question).map(word => expansions[word] ?? '').join(' ')

export function lexicalRanking(chunks: Chunk[], question: string): number[] {
  if (!chunks.length) return []
  const documents = chunks.map(chunk => tokens(chunk.text))
  const average = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1
  const scores = chunks.map(() => 0)
  for (const term of new Set(tokens(expand(question)))) {
    const frequency = documents.reduce((count, document) => count + Number(document.includes(term)), 0)
    const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))
    documents.forEach((document, index) => {
      const tf = document.filter(token => token === term).length
      scores[index] += idf * tf * 2.5 / (tf + 1.5 * (0.25 + 0.75 * document.length / average))
    })
  }
  return scores.map((score, index) => ({ score, index })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score).map(item => item.index)
}

export class Retriever {
  private matrixCache = new Map<string, number[][]>()
  constructor(private config: Config, private fetcher: typeof fetch = fetch) {}

  private async embed(inputs: string[]): Promise<number[][]> {
    if (this.config.embeddingModel.includes(':cloud')) throw new AppError(503, 'Cloud embedding models are not allowed.')
    try {
      const show = await this.fetcher(this.config.ollamaUrl + '/api/show', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.embeddingModel }), signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      })
      if (!show.ok) throw new AppError(503, `Install the local embedding model first: ollama pull ${this.config.embeddingModel}`)
      const metadata = z.object({ remote_host: z.string().nullish(), remote_model: z.string().nullish() }).passthrough().parse(await show.json())
      if (metadata.remote_host || metadata.remote_model) throw new AppError(503, 'The embedding model must be local.')
      const response = await this.fetcher(this.config.ollamaUrl + '/api/embed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.embeddingModel, input: inputs }),
        signal: AbortSignal.timeout(180_000), redirect: 'error',
      })
      if (!response.ok) throw new AppError(503, 'Local embedding failed. No silent BM25 fallback was used.')
      return z.object({ embeddings: z.array(z.array(z.number())) }).parse(await response.json()).embeddings
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(503, 'Cannot use local embeddings. Check Ollama and the configured model.')
    }
  }

  async search(chunks: Chunk[], question: string, limit = 6): Promise<{ evidence: Evidence[]; warnings: string[] }> {
    if (!chunks.length) return { evidence: [], warnings: [] }
    let candidates = lexicalRanking(chunks, question)
    const warnings: string[] = []
    if (this.config.retrievalMode === 'hybrid') {
      const key = createHash('sha256').update(JSON.stringify([
        this.config.embeddingModel, chunks.map(chunk => [chunk.document_name, chunk.text]),
      ])).digest('hex')
      const directory = path.join(this.config.dataDir, 'embeddings')
      mkdirSync(directory, { recursive: true })
      const filename = path.join(directory, `${key}.json`)
      let matrix = this.matrixCache.get(key)
      if (!matrix) {
        if (existsSync(filename)) {
          try { matrix = z.array(z.array(z.number())).parse(JSON.parse(readFileSync(filename, 'utf8'))) }
          catch { throw new AppError(503, 'The embedding cache is unreadable. Re-index this package.') }
        }
        else {
          matrix = []
          for (let index = 0; index < chunks.length; index += 16) {
            matrix.push(...await this.embed(chunks.slice(index, index + 16).map(chunk => `title: ${chunk.document_name} | text: ${chunk.text}`)))
          }
          const temporary = `${filename}.${randomUUID()}.tmp`
          try {
            writeFileSync(temporary, JSON.stringify(matrix), { mode: 0o600 }); renameSync(temporary, filename)
          } finally { if (existsSync(temporary)) unlinkSync(temporary) }
        }
        if (matrix.length !== chunks.length) throw new AppError(503, 'Embedding cache has an invalid shape; re-index this package.')
        this.matrixCache.set(key, matrix)
        if (this.matrixCache.size > 4) this.matrixCache.delete(this.matrixCache.keys().next().value!)
      }
      const [query] = await this.embed([`task: search result | query: ${question}`])
      const norm = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
      const dense = matrix.map((vector, index) => {
        if (vector.length !== query.length) throw new AppError(503, 'Embedding dimensions changed. Re-index the package.')
        return { index, score: vector.reduce((sum, value, i) => sum + value * query[i], 0) / (norm(vector) * norm(query) + 1e-10) }
      }).sort((a, b) => b.score - a.score).slice(0, 18).map(item => item.index)
      const fused = new Map<number, number>()
      for (const ranking of [candidates.slice(0, 18), dense]) {
        ranking.forEach((index, rank) => fused.set(index, (fused.get(index) ?? 0) + 1 / (61 + rank)))
      }
      candidates = [...fused].sort((a, b) => b[1] - a[1]).map(item => item[0])
    }
    const chosen: Chunk[] = []
    const seen = new Map<string, number>()
    for (const index of candidates) {
      const chunk = chunks[index]
      const key = `${chunk.document_id}:${chunk.page}`
      if ((seen.get(key) ?? 0) >= 2) continue
      chosen.push(chunk); seen.set(key, (seen.get(key) ?? 0) + 1)
      if (chosen.length === limit) break
    }
    const relevantDocuments = new Set(chosen.map(chunk => chunk.document_id))
    for (const chunk of chunks) {
      if (chunk.kind === 'corrigendum' && relevantDocuments.has(chunk.amends_document_id ?? '') &&
          !chosen.some(item => item.document_id === chunk.document_id) && chosen.length < limit + 2) {
        chosen.push(chunk)
        warnings.push('An explicitly linked corrigendum was included; verify its actual scope.')
      }
    }
    return {
      evidence: chosen.map((chunk, index) => ({ ...chunk, source_id: `E${index + 1}`, score_kind: this.config.retrievalMode })),
      warnings,
    }
  }
}
