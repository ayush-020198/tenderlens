import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

const mock = process.env.MOCK_API === '1'
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8765',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: process.env.CI ? 'chromium' : 'edge',
    use: {
      ...devices['Desktop Chrome'],
      ...(process.env.CI ? {} : { channel: 'msedge' }),
      viewport: { width: 1480, height: 1000 },
    },
  }],
  webServer: {
    command: mock
      ? 'npm run dev -- --port 8765'
      : 'uv run uvicorn tenderlens.api:create_app --factory --host 127.0.0.1 --port 8765',
    cwd: mock ? import.meta.dirname : path.resolve(import.meta.dirname, '..'),
    url: 'http://127.0.0.1:8765',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      TENDERLENS_DATA_DIR: path.resolve(import.meta.dirname, '../data/e2e'),
      RETRIEVAL_MODE: 'bm25',
      GEMINI_API_KEY: '',
      OCR_ENABLED: 'false',
    },
  },
})
