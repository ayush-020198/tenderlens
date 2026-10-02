import { z } from 'zod'

export const kindSchema = z.enum(['tender', 'corrigendum', 'annexure', 'boq', 'form'])
export type DocumentKind = z.infer<typeof kindSchema>
export type Provider = 'evidence' | 'gemma' | 'ollama'

export interface Package {
  id: string; name: string; reference: string; created_at: string
  demo_key: string | null; document_count?: number; page_count?: number
}
export interface TenderDocument {
  id: string; package_id: string; name: string; kind: DocumentKind; issued_on: string | null
  amends_document_id: string | null; sha256: string; media_type: string
  page_count: number; warnings: string[]; created_at: string
}
export interface ExtractedPage {
  number: number; text: string; extraction: 'native_text' | 'ocr' | 'unreadable'
  tables: { rows: string[][]; bbox: number[] }[]
  width: number | null; height: number | null
}
export interface Page extends ExtractedPage { id: string; document_id: string }
export interface Chunk {
  id: string; text: string; ordinal: number; page: number; extraction: string
  document_id: string; document_name: string; kind: DocumentKind; issued_on: string | null
  amends_document_id: string | null
}
export interface Evidence extends Chunk { source_id: string; score_kind: string }
export const modelAnswerSchema = z.strictObject({
  status: z.enum(['answered', 'insufficient', 'conflicting']),
  answer: z.string().min(1).max(4500),
  citations: z.array(z.strictObject({
    source_id: z.string().max(10), quote: z.string().min(8).max(1400),
  })).max(8).default([]),
  missing: z.array(z.string().max(500)).max(5).default([]),
})
export type ModelAnswer = z.infer<typeof modelAnswerSchema>
export interface Answer extends Omit<ModelAnswer, 'status'> {
  status: ModelAnswer['status'] | 'evidence'
  sources: Evidence[]; warnings: string[]; answer_kind: 'evidence_only' | 'generated'
  provider: Provider; model: string | null; elapsed_seconds: number
  retrieval_mode: string; image_count: number
}
export interface Message {
  id: string; package_id: string; question: string; result: Answer; created_at: string
}

export class AppError extends Error {
  constructor(public statusCode: number, message: string) { super(message); this.name = 'AppError' }
}
