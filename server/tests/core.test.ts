import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'
import { chunkText } from '../src/store.js'
import { lexicalRanking, Retriever } from '../src/retrieval.js'
import { validateAnswer, normalized, generate } from '../src/answering.js'
import type { Chunk, Evidence } from '../src/types.js'

function chunk(id: string, text: string, kind: Chunk['kind'] = 'tender', parent: string | null = null): Chunk {
  return {
    id, document_id: id, document_name: `${id}.pdf`, text, page: 1,
    kind, issued_on: null, amends_document_id: parent, extraction: 'native_text', ordinal: 0,
  }
}
const evidence: Evidence[] = [{
  ...chunk('a', 'Clause 3. The Earnest Money Deposit is INR 50,000. No exemption is specified.'),
  source_id: 'E1', score_kind: 'bm25',
}]
const answer = () => ({
  status: 'answered', answer: 'The EMD is INR 50,000.',
  citations: [{ source_id: 'E1', quote: 'The Earnest Money Deposit is INR 50,000.' }], missing: [],
})

test('chunks preserve the final footnote and respect the limit', () => {
  const text = 'Paragraph about Indian tender requirements.\n'.repeat(120) + 'FINAL FOOTNOTE'
  const chunks = chunkText(text)
  assert.ok(chunks.at(-1)!.endsWith('FINAL FOOTNOTE'))
  assert.ok(chunks.every(item => item.length <= 1400))
})

test('BM25 retrieves common terms in a tiny corpus', () => {
  const data = [chunk('a', 'EMD earnest money deposit INR 50000.'), chunk('b', 'EMD exemption must not be assumed.')]
  assert.equal(lexicalRanking(data, 'What is the EMD?').length, 2)
})

test('unrelated lexical query is not presented as evidence', () => {
  assert.deepEqual(lexicalRanking([chunk('a', 'Supply of network cables.')], 'arbitration jurisdiction'), [])
})

test('two relevant clauses on the same page are not collapsed into one', async () => {
  const retrieval = new Retriever(loadConfig({}, false))
  const result = await retrieval.search([
    { ...chunk('same', 'Turnover eligibility requires audited statements.'), id: 'c1' },
    { ...chunk('same', 'Turnover eligibility also requires a certificate.'), id: 'c2', ordinal: 1 },
  ], 'turnover eligibility')
  assert.equal(result.evidence.length, 2)
})

test('linked amendments remain available without automatic precedence', async () => {
  const retrieval = new Retriever(loadConfig({}, false))
  const result = await retrieval.search([
    chunk('old', 'Submission deadline 20 October 2026.'),
    chunk('new', 'Clause 2 now reads 27 October 2026.', 'corrigendum', 'old'),
  ], 'submission deadline')
  assert.deepEqual(new Set(result.evidence.map(item => item.document_id)), new Set(['old', 'new']))
})

test('exact quote validation accepts source-backed JSON', () => {
  assert.equal(validateAnswer(JSON.stringify(answer()), evidence).status, 'answered')
})

test('invented citations, altered numbers and missing citations are rejected', () => {
  for (const candidate of [
    'not JSON', JSON.stringify({ ...answer(), citations: [] }),
    JSON.stringify({ ...answer(), citations: [{ source_id: 'E99', quote: 'The Earnest Money Deposit is INR 50,000.' }] }),
    JSON.stringify({ ...answer(), citations: [{ source_id: 'E1', quote: 'The Earnest Money Deposit is INR 5,000.' }] }),
  ]) assert.throws(() => validateAnswer(candidate, evidence))
  assert.notEqual(normalized('INR 50,000'), normalized('INR 5,000'))
})

test('insufficient evidence may abstain without a citation', () => {
  const result = validateAnswer(JSON.stringify({
    status: 'insufficient', answer: 'No GST rate is established.', citations: [], missing: ['GST rate clause'],
  }), evidence)
  assert.equal(result.status, 'insufficient')
})

test('billing confirmation is required before any external model call', async () => {
  let called = false
  const mock: typeof fetch = async () => { called = true; throw new Error('Must not call') }
  await assert.rejects(generate(loadConfig({ geminiKey: 'test-key-not-real' }, false), 'gemma', 'test', [], evidence, mock), /Free-tier/)
  assert.equal(called, false)
})

test('paid or unrelated model IDs cannot be configured', () => {
  assert.throws(() => loadConfig({ gemmaModel: 'gemini-paid-example' }, false), /free-only/)
})

test('Gemma payload keeps the key out of the URL and validates the answer', async () => {
  let calls = 0
  const mock: typeof fetch = async (url, init) => {
    calls++
    assert.ok(!String(url).includes('test-key-not-real'))
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'test-key-not-real')
    const payload = JSON.parse(String(init?.body))
    assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel, 'minimal')
    assert.equal(payload.tools, undefined)
    assert.equal(payload.contents[0].parts[1].text, 'Original page image for E1:')
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(answer()) }] } }] })
  }
  const result = await generate(
    loadConfig({ geminiKey: 'test-key-not-real', freeTierConfirmed: true }, false),
    'gemma', 'Only synthetic evidence', [{ sourceId: 'E1', bytes: Buffer.from('fake') }], evidence, mock,
  )
  assert.equal(result.status, 'answered')
  assert.equal(calls, 1)
})

test('free-quota errors do not trigger a paid fallback', async () => {
  let calls = 0
  const mock: typeof fetch = async () => { calls++; return new Response('{}', { status: 429 }) }
  await assert.rejects(
    generate(loadConfig({ geminiKey: 'test-key-not-real', freeTierConfirmed: true }, false), 'gemma', 'test', [], evidence, mock),
    /Do not enable billing/,
  )
  assert.equal(calls, 1)
})

test('cloud-tagged Ollama models are rejected before a request', async () => {
  await assert.rejects(
    generate(loadConfig({ ollamaModel: 'some-model:cloud' }, false), 'ollama', 'test', [], evidence),
    /non-cloud/,
  )
})
