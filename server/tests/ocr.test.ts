import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { loadConfig } from '../src/config.js'
import { extract } from '../src/documents.js'

test('packaged English OCR reads a generated scan without a network download', { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tenderlens-ocr-'))
  try {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="500">
      <rect width="1600" height="500" fill="white"/>
      <text x="80" y="140" font-family="Arial" font-size="58" fill="black">INDIAN TENDER - SYNTHETIC TEST</text>
      <text x="80" y="260" font-family="Arial" font-size="58" fill="black">EMD: INR 50,000</text>
      <text x="80" y="380" font-family="Arial" font-size="48" fill="black">Submission deadline: 27 October 2026</text>
    </svg>`)
    const image = await sharp(svg).png().toBuffer()
    const result = await extract(image, '.png', loadConfig({ dataDir: directory, ocrEnabled: true }, false))
    assert.equal(result.pages[0].extraction, 'ocr')
    assert.match(result.pages[0].text, /50,?000/)
    assert.match(result.pages[0].text, /27 October 2026/)
  } finally {
    assert.ok(directory.startsWith(path.join(os.tmpdir(), 'tenderlens-ocr-')))
    rmSync(directory, { recursive: true, force: true })
  }
})
