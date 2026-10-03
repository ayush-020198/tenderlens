import { expect, test, type Page } from '@playwright/test'

async function chatFixture(page: Page) {
  const sent: { question: string; provider: string; consent_external: boolean }[] = []
  const source = {
    id: 'chunk-1', source_id: 'E1', document_id: 'notice', document_name: 'notice.txt',
    kind: 'tender', page: 1, text: 'The earnest money deposit is INR 50,000.',
    extraction: 'native_text', issued_on: null, amends_document_id: null,
  }
  await page.route('**/api/**', async route => {
    const endpoint = new URL(route.request().url()).pathname
    let body: unknown
    if (endpoint === '/api/config') body = {
      country: 'IN', google_configured: true, google_free_tier_confirmed: true,
      gemma_model: 'gemma-4-26b-a4b-it', ollama_model: 'qwen3.5:4b',
      retrieval_mode: 'bm25', rerank_enabled: false, ocr_enabled: false,
      ocr_languages: 'eng', max_upload_mb: 15, max_pages: 80, single_user: true,
    }
    else if (endpoint === '/api/packages') body = [
      { id: 'first', name: 'First tender', reference: '', document_count: 1, page_count: 1 },
      { id: 'second', name: 'Second tender', reference: '', document_count: 1, page_count: 1 },
    ]
    else if (endpoint.endsWith('/ask')) {
      const input = route.request().postDataJSON()
      sent.push(input)
      body = {
        id: `m${sent.length}`, question: input.question,
        result: {
          status: 'answered', answer_kind: 'generated', provider: 'gemma',
          model: 'gemma-4-26b-a4b-it',
          answer: 'You need an EMD of INR 50,000. That is the deposit specified in this tender.',
          citations: [{ source_id: 'E1', quote: source.text }], missing: [],
          sources: [source], warnings: [], elapsed_seconds: 1, retrieval_mode: 'bm25',
        },
      }
    } else if (endpoint.endsWith('/pages')) body = [{ id: 'p1', number: 1, text: source.text, extraction: 'native_text', tables: [] }]
    else body = {
      id: endpoint.endsWith('/second') ? 'second' : 'first',
      name: endpoint.endsWith('/second') ? 'Second tender' : 'First tender',
      reference: '', demo_key: null, messages: [],
      documents: [{ id: 'notice', name: 'notice.txt', kind: 'tender', page_count: 1, warnings: [], issued_on: null, media_type: 'text/plain' }],
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  return sent
}

test('configured Gemma is the initial chat mode but never pre-authorizes sharing', async ({ page }) => {
  const sent = await chatFixture(page)
  await page.goto('/')
  await expect(page.locator('.model-pill')).toContainText('Gemma')
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  await page.getByRole('textbox', { name: 'Ask about this tender' }).fill('What is the EMD?')
  await page.getByRole('textbox', { name: 'Ask about this tender' }).press('Enter')
  expect(sent).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Send question' })).toBeDisabled()
})

test('chat leads with an answer and keeps cited sources available underneath', async ({ page }) => {
  const sent = await chatFixture(page)
  await page.goto('/')
  await page.getByRole('checkbox').check()
  await page.getByRole('textbox', { name: 'Ask about this tender' }).fill('What is the EMD?')
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.locator('.answer-text')).toContainText('You need an EMD of INR 50,000.')
  expect(sent[0]).toMatchObject({ provider: 'gemma', consent_external: true })
  await expect(page.locator('.evidence-card')).toBeHidden()
  await page.getByText('1 cited source · View evidence', { exact: true }).click()
  await expect(page.locator('.evidence-card')).toBeVisible()
  await page.locator('.evidence-card').click()
  await expect(page.locator('.document-text')).toContainText('50,000')
})

test('an explicit evidence-only choice survives reload and offers a clear chat switch', async ({ page }) => {
  await chatFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Model & privacy' }).click()
  await page.getByRole('button', { name: /^Evidence only/ }).click()
  await page.getByRole('button', { name: /Continue with Evidence only/ }).click()
  await page.reload()
  await expect(page.locator('.model-pill')).toContainText('Evidence only')
  await expect(page.getByText('Source search is on.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to Gemma chat' }).click()
  await expect(page.locator('.model-pill')).toContainText('Gemma')
  await expect(page.getByRole('checkbox')).not.toBeChecked()
})

test('chat consent does not transfer to another package or page-vision setting', async ({ page }) => {
  await chatFixture(page)
  await page.goto('/')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: /Second tender/ }).click()
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: /Page vision off/ }).click()
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  await page.getByRole('checkbox').check()
  await page.reload()
  await expect(page.getByRole('checkbox')).not.toBeChecked()
})
