import { expect, test, type Page } from '@playwright/test'

const headers = { 'Content-Type': 'application/json' }

async function mockApi(page: Page) {
  const packages: object[] = []
  const documents = [
    { id: 'notice', name: '01_Demo_Notice_and_Eligibility.pdf', kind: 'tender', page_count: 2, warnings: [], issued_on: '2026-10-01', media_type: 'application/pdf' },
    { id: 'boq', name: '02_Demo_BOQ.pdf', kind: 'boq', page_count: 1, warnings: [], issued_on: '2026-10-01', media_type: 'application/pdf' },
    { id: 'amendment', name: '03_Demo_Corrigendum_01.pdf', kind: 'corrigendum', page_count: 1, warnings: [], issued_on: '2026-10-08', media_type: 'application/pdf', amends_document_id: 'notice' },
  ]
  const packageItem = { id: 'demo', name: 'Campus network upgrade', reference: 'SYNTHETIC / TL-IN / 2026 / 001', demo_key: 'india-v1', document_count: 3, page_count: 4 }
  const messages: object[] = []
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const endpoint = url.pathname
    let body: unknown
    let status = 200
    if (endpoint === '/api/config') body = { country: 'IN', google_configured: false, gemma_model: 'gemma-4-26b-a4b-it', ollama_model: 'qwen3.5:4b', retrieval_mode: 'bm25', rerank_enabled: false, ocr_enabled: false, ocr_languages: 'eng', max_upload_mb: 15, max_pages: 80, single_user: true }
    else if (endpoint === '/api/packages') body = packages
    else if (endpoint === '/api/demo') { packages.splice(0, packages.length, packageItem); body = packageItem; status = 201 }
    else if (endpoint === '/api/packages/demo') body = { ...packageItem, documents, messages }
    else if (endpoint.endsWith('/ask')) {
      const input = route.request().postDataJSON() as { question: string }
      const message = {
        id: `m${messages.length}`, question: input.question,
        result: {
          status: 'evidence', answer_kind: 'evidence_only', provider: 'evidence',
          answer: 'Here are the closest matching passages. This is local evidence search, not an AI-generated conclusion.',
          citations: [], missing: [], warnings: [], elapsed_seconds: 0.02, retrieval_mode: 'bm25',
          sources: [{ id: 'c1', source_id: 'E1', document_id: 'amendment', document_name: documents[2].name, kind: 'corrigendum', page: 1, text: 'The bid submission deadline is extended to 27 October 2026 at 15:00 IST.', extraction: 'native_text' }],
        },
      }
      messages.push(message); body = message
    } else if (endpoint.endsWith('/pages')) {
      body = [{ id: 'page1', number: 1, text: 'The bid submission deadline is extended to 27 October 2026 at 15:00 IST.', tables: [], extraction: 'native_text' }]
    } else if (endpoint.endsWith('/documents') && route.request().method() === 'POST') {
      status = 422; body = { detail: 'PDF extraction failed. It may be encrypted, damaged, or unsupported.' }
    } else { status = 404; body = { detail: 'Unknown UI fixture endpoint.' } }
    await route.fulfill({ status, headers, body: JSON.stringify(body) })
  })
}

test.beforeEach(async ({ page }) => {
  if (process.env.MOCK_API === '1') await mockApi(page)
})

test('sample package, evidence question and original-source navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Read the tender/ })).toBeVisible()
  await page.getByRole('button', { name: /Take a closer look/ }).click()
  await expect(page.getByRole('button', { name: /Campus network upgrade/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Submission deadline/ })).toBeEnabled()
  await page.screenshot({ path: '../artifacts/workspace-overview.png', fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: /Submission deadline/ }).click()
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.getByText('Evidence search', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Local evidence · no LLM', { exact: true }).last()).toBeVisible()
  await page.locator('.evidence-card').filter({ hasText: 'Corrigendum' }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.document-text')).toContainText('27 October 2026')
  await page.getByRole('button', { name: 'Close source' }).click()
  await page.screenshot({ path: '../artifacts/workspace-evidence.png', fullPage: true, animations: 'disabled' })
})

test('provider disclosure and missing-key gate', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Take a closer look/ }).click()
  await page.getByRole('button', { name: 'Model & privacy' }).click()
  await page.getByRole('button', { name: /Gemma 4 via Gemini API/ }).click()
  await expect(page.getByText(/Add GEMINI_API_KEY/)).toBeVisible()
  await page.getByRole('button', { name: /Continue with Gemma/ }).click()
  await page.getByRole('textbox', { name: 'Ask about this tender' }).fill('What is the EMD?')
  await expect(page.getByRole('checkbox')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send question' })).toBeDisabled()
})

test('invalid PDF upload surfaces an error instead of success', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Take a closer look/ }).click()
  await page.getByRole('button', { name: 'Add a document to this package' }).click()
  await page.getByLabel('Choose tender document').setInputFiles({
    name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a valid pdf'),
  })
  await page.getByRole('button', { name: 'Upload and read' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(/PDF|extraction/i)
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('mobile workspace and dark theme remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?scoutTheme=dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Open packages' }).click()
  await page.getByRole('button', { name: /Take a closer look/ }).click()
  await expect(page.getByRole('textbox', { name: 'Ask about this tender' })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await page.screenshot({ path: '../artifacts/workspace-mobile.png', fullPage: true, animations: 'disabled' })
})
