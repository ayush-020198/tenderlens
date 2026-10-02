import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Retriever } from '../src/retrieval.js'
import { loadConfig } from '../src/config.js'
import type { Chunk } from '../src/types.js'

const chunks: Chunk[] = [
  { id: '1', document_id: 'a', document_name: 'notice.pdf', text: 'Earnest money is INR 50000.', page: 1, extraction: 'native_text', kind: 'tender', issued_on: null, amends_document_id: null, ordinal: 0 },
  { id: '2', document_id: 'b', document_name: 'boq.pdf', text: 'Network switches quantity 12.', page: 1, extraction: 'native_text', kind: 'boq', issued_on: null, amends_document_id: null, ordinal: 0 },
]

test('hybrid retrieval uses local vectors and reuses its source cache', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tenderlens-hybrid-'))
  let documentEmbeds = 0
  const mock: typeof fetch = async (url, init) => {
    assert.ok(String(url).startsWith('http://127.0.0.1:11434/'))
    assert.equal(init?.redirect, 'error')
    if (String(url).endsWith('/api/show')) return Response.json({ remote_host: null, remote_model: null })
    const body: { input: string[] } = JSON.parse(String(init?.body))
    if (body.input[0].startsWith('task:')) return Response.json({ embeddings: [[1, 0]] })
    documentEmbeds++
    return Response.json({ embeddings: body.input.map((_, index) => index === 0 ? [1, 0] : [0, 1]) })
  }
  try {
    const retriever = new Retriever(loadConfig({ dataDir: directory, retrievalMode: 'hybrid' }, false), mock)
    const first = await retriever.search(chunks, 'deposit requirement')
    const second = await retriever.search(chunks, 'bid security')
    assert.equal(first.evidence[0].document_id, 'a')
    assert.equal(second.evidence[0].document_id, 'a')
    assert.equal(documentEmbeds, 1)
    await retriever.search(chunks.map(item => ({ ...item, document_name: `renamed-${item.document_name}` })), 'deposit')
    assert.equal(documentEmbeds, 2)
  } finally {
    assert.ok(directory.startsWith(path.join(os.tmpdir(), 'tenderlens-hybrid-')))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('remote embedding models are rejected rather than used silently', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tenderlens-hybrid-'))
  const mock: typeof fetch = async () => Response.json({ remote_host: 'https://example.invalid', remote_model: 'remote' })
  try {
    const retriever = new Retriever(loadConfig({ dataDir: directory, retrievalMode: 'hybrid' }, false), mock)
    await assert.rejects(retriever.search(chunks, 'deposit'), /must be local/)
  } finally {
    assert.ok(directory.startsWith(path.join(os.tmpdir(), 'tenderlens-hybrid-')))
    rmSync(directory, { recursive: true, force: true })
  }
})
