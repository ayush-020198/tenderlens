import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export interface Config {
  dataDir: string; frontendDir: string; geminiKey: string; gemmaModel: string
  freeTierConfirmed: boolean; retrievalMode: 'bm25' | 'hybrid'; embeddingModel: string
  ollamaUrl: string; ollamaModel: string; ocrEnabled: boolean; ocrLanguages: string
  maxUploadBytes: number; maxPages: number; maxDocuments: number; port: number
  listenHost: '127.0.0.1' | '0.0.0.0'
}

export const FREE_GEMMA_MODELS = new Set(['gemma-4-26b-a4b-it', 'gemma-4-31b-it'])
const flag = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || value === '') return fallback
  if (['true', '1'].includes(value.toLowerCase())) return true
  if (['false', '0'].includes(value.toLowerCase())) return false
  throw new Error('Boolean configuration values must be true or false.')
}

export function loadConfig(overrides: Partial<Config> = {}, readEnvironment = true): Config {
  if (readEnvironment && existsSync('.env')) process.loadEnvFile('.env')
  const env = readEnvironment ? process.env : {}
  if (flag(env.RERANK_ENABLED, false)) {
    throw new Error('This Node baseline does not yet implement a cross-encoder reranker. Set RERANK_ENABLED=false.')
  }
  const config: Config = {
    dataDir: path.resolve(env.TENDERLENS_DATA_DIR || 'data'),
    frontendDir: path.resolve('frontend/dist'),
    geminiKey: env.GEMINI_API_KEY?.trim() || '',
    gemmaModel: env.GEMMA_MODEL || 'gemma-4-26b-a4b-it',
    freeTierConfirmed: flag(env.GEMINI_FREE_TIER_CONFIRMED, false),
    retrievalMode: z.enum(['bm25', 'hybrid']).parse(env.RETRIEVAL_MODE || 'bm25'),
    embeddingModel: env.EMBEDDING_MODEL || 'embeddinggemma',
    ollamaUrl: env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    ollamaModel: env.OLLAMA_MODEL || 'qwen3.5:4b',
    ocrEnabled: flag(env.OCR_ENABLED, true),
    ocrLanguages: env.OCR_LANGUAGES || 'eng',
    maxUploadBytes: 15 * 1024 * 1024, maxPages: 80, maxDocuments: 20,
    port: z.coerce.number().int().min(1024).max(65535).parse(env.PORT || 8000),
    listenHost: z.enum(['127.0.0.1', '0.0.0.0']).parse(env.TENDERLENS_LISTEN_HOST || '127.0.0.1'),
    ...overrides,
  }
  if (!FREE_GEMMA_MODELS.has(config.gemmaModel)) {
    throw new Error('This free-only build allows only the two documented Gemma 4 API model IDs.')
  }
  if (!['http://127.0.0.1:11434', 'http://localhost:11434'].includes(config.ollamaUrl)) {
    throw new Error('OLLAMA_BASE_URL must be a loopback endpoint without a trailing slash.')
  }
  return config
}
