export type DocumentKind = 'tender' | 'corrigendum' | 'annexure' | 'boq' | 'form'
export type Provider = 'evidence' | 'gemma' | 'ollama'
export interface TenderPackage {
  id: string; name: string; reference: string; created_at: string
  demo_key: string | null; document_count?: number; page_count?: number
}
export interface TenderDocument {
  id: string; name: string; kind: DocumentKind; issued_on: string | null
  amends_document_id: string | null; page_count: number; media_type: string
  warnings: string[]; sha256: string
}
export interface Evidence {
  id: string; source_id: string; document_id: string; document_name: string
  page: number; text: string; kind: DocumentKind; issued_on: string | null
  amends_document_id: string | null; extraction: string
}
export interface Answer {
  status: 'answered' | 'insufficient' | 'conflicting' | 'evidence'
  answer: string; citations: { source_id: string; quote: string }[]
  missing: string[]; sources: Evidence[]; warnings: string[]
  provider: Provider; model: string | null; answer_kind: 'generated' | 'evidence_only'
  elapsed_seconds: number; retrieval_mode: string; image_count?: number
}
export interface Message { id: string; question: string; result: Answer; created_at: string }
export interface PackageDetail extends TenderPackage { documents: TenderDocument[]; messages: Message[] }
export interface Config {
  country: 'IN'; google_configured: boolean; gemma_model: string; ollama_model: string
  retrieval_mode: string; rerank_enabled: boolean; ocr_enabled: boolean
  ocr_languages: string; max_upload_mb: number; max_pages: number; single_user: boolean
}
export interface Page {
  id: string; number: number; text: string; extraction: string
  width: number | null; height: number | null
  tables: { rows: string[][]; bbox: number[] }[]
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('X-TenderLens-Client', 'browser')
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(`/api${path}`, { ...init, headers })
  } catch {
    throw new Error('Cannot reach TenderLens. Start the local API server and try again.')
  }
  if (!response.ok) {
    let detail = `Request failed (HTTP ${response.status}).`
    try {
      const data: { detail?: unknown } = await response.json()
      if (typeof data.detail === 'string') detail = data.detail
      else if (Array.isArray(data.detail)) detail = 'Some inputs were invalid. Check your file and form fields.'
    } catch { /* Preserve the visible HTTP error when the response is not JSON. */ }
    throw new Error(detail)
  }
  return response.json() as Promise<T>
}

export const pageImageUrl = (packageId: string, documentId: string, page: number) =>
  `/api/packages/${packageId}/documents/${documentId}/pages/${page}/image`
