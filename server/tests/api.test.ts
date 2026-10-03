import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import sharp from 'sharp'
import { createApp } from '../src/app.js'
import { loadConfig, type Config } from '../src/config.js'
import { makePdf } from '../src/demo.js'
import type { Package, TenderDocument, Message } from '../src/types.js'

async function serverFor(t: TestContext, overrides: Partial<Config> = {}, modelFetch?: typeof fetch) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tenderlens-test-'))
  const config = loadConfig({ dataDir: directory, ocrEnabled: false, frontendDir: path.join(directory, 'no-frontend'), ...overrides }, false)
  const { app, store } = createApp(config, modelFetch)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    store.close()
    assert.ok(directory.startsWith(path.join(os.tmpdir(), 'tenderlens-test-')))
    rmSync(directory, { recursive: true, force: true })
  })
  const request = (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('X-TenderLens-Client', 'browser')
    if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    return fetch(base + url, { ...init, headers })
  }
  const packageResponse = await request('/api/packages', { method: 'POST', body: JSON.stringify({ name: 'India test package' }) })
  assert.equal(packageResponse.status, 201)
  const item: Package = await packageResponse.json()
  const upload = (bytes: Buffer | string, name = 'notice.txt', fields: Record<string, string> = {}, packageId = item.id) => {
    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(Buffer.from(bytes))]), name)
    for (const [key, value] of Object.entries(fields)) body.append(key, value)
    return request(`/api/packages/${packageId}/documents`, { method: 'POST', body })
  }
  return { request, upload, item, base, store, config }
}

test('health/config disclose readiness without revealing secrets', async t => {
  const { request } = await serverFor(t)
  assert.equal((await (await request('/api/health')).json()).country, 'IN')
  const config = await (await request('/api/config')).json()
  assert.equal(config.google_configured, false)
  assert.equal(config.free_only, true)
  assert.equal(config.geminiKey, undefined)
})

test('origin and application-header gates reject cross-site writes', async t => {
  const { request, base } = await serverFor(t)
  assert.equal((await request('/api/packages', {
    method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: JSON.stringify({ name: 'No access' }),
  })).status, 403)
  assert.equal((await fetch(base + '/api/packages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'No header' }),
  })).status, 403)
})

test('a text upload produces local evidence and saved history', async t => {
  const { upload, request, item } = await serverFor(t)
  assert.equal((await upload('Clause 3. Earnest Money Deposit (EMD): INR 50,000. GST is quoted separately.')).status, 201)
  const response = await request(`/api/packages/${item.id}/ask`, {
    method: 'POST', body: JSON.stringify({ question: 'What is the EMD amount?' }),
  })
  assert.equal(response.status, 200)
  const message: Message = await response.json()
  assert.equal(message.result.answer_kind, 'evidence_only')
  assert.ok(message.result.sources[0].text.includes('50,000'))
  assert.equal(message.result.model, null)
  const detail = await (await request(`/api/packages/${item.id}`)).json()
  assert.equal(detail.messages.length, 1)
})

test('documents and answers do not cross package boundaries', async t => {
  const { upload, request, item } = await serverFor(t)
  const doc: TenderDocument = await (await upload('Confidential reference alpha. EMD is INR 77777.')).json()
  const other: Package = await (await request('/api/packages', {
    method: 'POST', body: JSON.stringify({ name: 'Separate package' }),
  })).json()
  assert.notEqual(item.id, other.id)
  assert.equal((await request(`/api/packages/${other.id}/documents/${doc.id}/pages`)).status, 404)
  const message: Message = await (await request(`/api/packages/${other.id}/ask`, {
    method: 'POST', body: JSON.stringify({ question: 'What is the EMD?' }),
  })).json()
  assert.deepEqual(message.result.sources, [])
})

test('malformed, duplicate and oversized uploads fail visibly', async t => {
  const { upload, config, request, item } = await serverFor(t, { maxUploadBytes: 1024 })
  const text = 'An original tender with a deposit of INR 50000.'
  assert.equal((await upload(text)).status, 201)
  assert.equal((await upload(text)).status, 422)
  assert.equal((await upload('not a PDF', 'broken.pdf')).status, 422)
  assert.equal((await upload('not executable', 'bad.exe')).status, 422)
  assert.equal((await upload(Buffer.from([0xff, 0xfe, 0]), 'bad.txt')).status, 422)
  assert.equal((await upload(Buffer.alloc(config.maxUploadBytes + 1))).status, 413)
  assert.equal((await (await request(`/api/packages/${item.id}`)).json()).documents.length, 1)
})

test('dates and amendment relationships are checked', async t => {
  const { upload, request } = await serverFor(t)
  const doc: TenderDocument = await (await upload('A sufficiently long main tender notice for the test.')).json()
  assert.equal((await upload('A sufficiently long amendment notice.', 'change.txt', { issued_on: '20261001' })).status, 422)
  const other: Package = await (await request('/api/packages', { method: 'POST', body: JSON.stringify({ name: 'Other tender' }) })).json()
  assert.equal((await upload('Amendment extends the deadline to 27 October 2026.', 'change.txt', {
    kind: 'corrigendum', amends_document_id: doc.id,
  }, other.id)).status, 404)
})

test('Gemma requires consent, a key, and a free-tier confirmation', async t => {
  const { upload, request, item } = await serverFor(t)
  await upload('The earnest money deposit is INR 50000 for this tender.')
  const endpoint = `/api/packages/${item.id}/ask`
  assert.equal((await request(endpoint, { method: 'POST', body: JSON.stringify({ question: 'What is the EMD?', provider: 'gemma' }) })).status, 403)
  assert.equal((await request(endpoint, { method: 'POST', body: JSON.stringify({
    question: 'What is the EMD?', provider: 'gemma', consent_external: true,
  }) })).status, 503)
  assert.equal((await (await request(`/api/packages/${item.id}`)).json()).messages.length, 0)
})

test('a configured key without free-tier confirmation cannot be used', async t => {
  const { upload, request, item } = await serverFor(t, { geminiKey: 'test-key-not-real', freeTierConfirmed: false })
  await upload('The earnest money deposit is INR 50000 for this tender.')
  const response = await request(`/api/packages/${item.id}/ask`, {
    method: 'POST', body: JSON.stringify({ question: 'What is the EMD?', provider: 'gemma', consent_external: true }),
  })
  assert.equal(response.status, 403)
})

test('PDF extraction and original-page preview work without Python', async t => {
  const { upload, request, item } = await serverFor(t)
  const bytes = await makePdf([{
    title: 'Indian tender sample',
    text: 'Earnest Money Deposit (EMD): INR 50,000.\nSubmission deadline: 27 October 2026 at 15:00 IST.',
  }])
  const response = await upload(bytes, 'test.pdf')
  assert.equal(response.status, 201, await response.clone().text())
  const doc: TenderDocument = await response.json()
  const prefix = `/api/packages/${item.id}/documents/${doc.id}`
  const pages = await (await request(prefix + '/pages')).json()
  assert.ok(pages[0].text.includes('50,000'))
  const image = await request(prefix + '/pages/1/image')
  assert.equal(image.status, 200)
  assert.ok(Buffer.from(await image.arrayBuffer()).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
  assert.equal((await request(prefix + '/pages/0/image')).status, 422)
  assert.equal((await request(prefix + '/pages/99/image')).status, 422)
})

test('synthetic demo is repeatable and retrieves the linked corrigendum', async t => {
  const { request } = await serverFor(t)
  const first = await request('/api/demo', { method: 'POST' })
  assert.equal(first.status, 201, await first.clone().text())
  const item: Package = await first.json()
  const second: Package = await (await request('/api/demo', { method: 'POST' })).json()
  assert.equal(second.id, item.id)
  const detail = await (await request(`/api/packages/${item.id}`)).json()
  assert.equal(detail.documents.length, 3)
  const message: Message = await (await request(`/api/packages/${item.id}/ask`, {
    method: 'POST', body: JSON.stringify({ question: 'What is the current submission deadline? Check the corrigendum.' }),
  })).json()
  assert.ok(message.result.sources.some(source => source.kind === 'corrigendum' && source.text.includes('27 October 2026')))
})

test('scanned images fail clearly when OCR is disabled', async t => {
  const { upload } = await serverFor(t)
  const image = await sharp({ create: { width: 200, height: 100, channels: 3, background: 'white' } }).png().toBuffer()
  const response = await upload(image, 'scan.png')
  assert.equal(response.status, 422)
  assert.match((await response.json()).detail, /OCR/)
})

test('blank or oversized questions are rejected', async t => {
  const { request, item } = await serverFor(t)
  for (const question of [' ', '', 'z'.repeat(1601)]) {
    assert.equal((await request(`/api/packages/${item.id}/ask`, {
      method: 'POST', body: JSON.stringify({ question }),
    })).status, 422)
  }
})

test('Gemma can greet or clarify without a matching tender passage', async t => {
  let calls = 0
  const mock: typeof fetch = async (_url, init) => {
    calls++
    const payload = JSON.parse(String(init?.body))
    const prompt = JSON.parse(payload.contents[0].parts[0].text)
    assert.deepEqual(prompt.passages, [])
    return Response.json({ candidates: [{
      finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
        status: 'insufficient', answer: 'Hi! What would you like to understand about your tender?',
        citations: [], missing: [],
      }) }] },
    }] })
  }
  const { request, item } = await serverFor(t, {
    geminiKey: 'test-key-not-real', freeTierConfirmed: true,
  }, mock)
  const response = await request(`/api/packages/${item.id}/ask`, {
    method: 'POST', body: JSON.stringify({ question: 'Hi', provider: 'gemma', consent_external: true }),
  })
  assert.equal(response.status, 200)
  const message: Message = await response.json()
  assert.equal(message.result.answer_kind, 'generated')
  assert.match(message.result.answer, /^Hi!/)
  assert.deepEqual(message.result.sources, [])
  assert.equal(calls, 1)
})

test('conversation turns retain actual prior evidence and do not cross packages', async t => {
  const prompts: { recent_conversation_for_context_only: { user: string; assistant: string }[]; passages: { source_id: string; text: string }[] }[] = []
  const mock: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body))
    const prompt = JSON.parse(payload.contents[0].parts[0].text)
    prompts.push(prompt)
    const source = prompt.passages.find((passage: { text: string }) => passage.text.includes('50,000'))
    return Response.json({ candidates: [{
      finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(source ? {
        status: 'answered', answer: 'You need to provide an EMD of INR 50,000.',
        citations: [{ source_id: source.source_id, quote: 'The earnest money deposit is INR 50,000.' }], missing: [],
      } : {
        status: 'insufficient', answer: 'Which requirement would you like me to explain?',
        citations: [], missing: ['The requirement or source clause'],
      }) }] },
    }] })
  }
  const { request, upload, item } = await serverFor(t, {
    geminiKey: 'test-key-not-real', freeTierConfirmed: true,
  }, mock)
  await upload('The earnest money deposit is INR 50,000.')
  for (const question of ['What is the EMD?', 'Can you explain that in a much simpler way?']) {
    const response = await request(`/api/packages/${item.id}/ask`, {
      method: 'POST', body: JSON.stringify({ question, provider: 'gemma', consent_external: true }),
    })
    assert.equal(response.status, 200, await response.clone().text())
  }
  assert.equal(prompts[1].recent_conversation_for_context_only[0].assistant, 'You need to provide an EMD of INR 50,000.')
  assert.ok(prompts[1].passages.some(source => source.text.includes('50,000')))
  const other: Package = await (await request('/api/packages', {
    method: 'POST', body: JSON.stringify({ name: 'Unrelated package' }),
  })).json()
  await request(`/api/packages/${other.id}/ask`, {
    method: 'POST', body: JSON.stringify({ question: 'Explain that.', provider: 'gemma', consent_external: true }),
  })
  assert.deepEqual(prompts[2].recent_conversation_for_context_only, [])
  assert.deepEqual(prompts[2].passages, [])
})
