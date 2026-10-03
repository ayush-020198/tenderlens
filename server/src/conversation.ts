import type { Chunk, Evidence, Message } from './types.js'

// A bounded continuity heuristic, not an intent classifier. Fresh source text,
// not the earlier model answer, remains the authority for each follow-up.
export function isFollowUp(question: string): boolean {
  return /\b(that|those|them|it|earlier|previous|above)\b|^(and\b|also\b|why\b|continue\b|what about\b|how about\b|explain (?:that|this|it|more|further)\b|simplify\b|elaborate\b|rephrase\b|translate\b)|\b(in simpler words|break (?:this|that) down|in hindi)\b/i.test(question.replace(/\bIT\b/g, ''))
}

export function retrievalQuestion(question: string, history: Message[]): string {
  if (!isFollowUp(question) || !history.length) return question
  const recent = history.slice(-4)
  const topic = [...recent].reverse().find(message => !isFollowUp(message.question)) ?? recent[0]
  return `${topic.question.slice(0, 800)} ${question}`
}

export function followUpEvidence(
  question: string, current: Evidence[], chunks: Chunk[], history: Message[], mode: string,
): Evidence[] {
  if (!isFollowUp(question) || !history.length) return current
  const prior = [...history].reverse().find(message => message.result.sources.length)
  if (!prior) return current
  const citedIds = new Set(prior.result.citations.map(citation => citation.source_id))
  const candidates = (citedIds.size
    ? prior.result.sources.filter(source => citedIds.has(source.source_id))
    : prior.result.sources.slice(0, 2)).slice(0, 4)
  const live = new Map(chunks.map(chunk => [chunk.id, chunk]))
  const combined = new Map<string, Chunk>()
  for (const previous of candidates) {
    const source = live.get(previous.id)
    if (source) combined.set(source.id, source)
  }
  for (const source of current) combined.set(source.id, source)
  return [...combined.values()].slice(0, 10).map((source, index) => ({
    ...source, source_id: `E${index + 1}`, score_kind: mode,
  }))
}
