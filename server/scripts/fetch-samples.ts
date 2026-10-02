import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const { values } = parseArgs({
  options: {
    package: { type: 'string', default: 'iisc-wall-fans-2021' },
    'acknowledge-source-terms': { type: 'boolean', default: false },
  },
})
if (!values['acknowledge-source-terms']) throw new Error('Read datasets/sources.json, then pass --acknowledge-source-terms.')
const manifest = z.object({
  packages: z.array(z.object({
    id: z.string(), documents: z.array(z.object({
      filename: z.string(), url: z.string().url(), sha256: z.string().optional(),
    }).passthrough()),
  }).passthrough()),
}).passthrough().parse(JSON.parse(readFileSync('datasets/sources.json', 'utf8')))
const selected = manifest.packages.find(item => item.id === values.package)
if (!selected || !/^[a-z0-9-]+$/.test(selected.id)) throw new Error('Choose a package from the manifest.')
const permitted = (url: URL) => url.protocol === 'https:' &&
  ['iisc.ac.in', 'www.iisc.ac.in'].includes(url.hostname) && !url.username && !url.password

async function download(url: URL, hops = 0): Promise<{ data: Buffer; url: string }> {
  if (!permitted(url) || hops > 3) throw new Error('Unapproved source or redirect; download stopped.')
  const response = await fetch(url, {
    redirect: 'manual', signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'TenderLens-research/0.2 (public-document-reader)' },
  })
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    if (!location) throw new Error('Redirect has no location.')
    await response.body?.cancel()
    return download(new URL(location, url), hops + 1)
  }
  if (!response.ok || !response.body) throw new Error(`Official source returned HTTP ${response.status}; no access controls were bypassed.`)
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.length
    if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('Source exceeds the 20 MB limit.') }
    parts.push(result.value)
  }
  const data = Buffer.concat(parts)
  if (!data.subarray(0, 1024).toString('latin1').trimStart().startsWith('%PDF-')) throw new Error('Source did not return a PDF.')
  return { data, url: url.href }
}

const destination = path.resolve('data/public', selected.id)
mkdirSync(destination, { recursive: true })
const receipts = []
for (const document of selected.documents) {
  if (path.basename(document.filename) !== document.filename) throw new Error('Unsafe manifest filename.')
  const result = await download(new URL(document.url))
  const hash = createHash('sha256').update(result.data).digest('hex')
  if (document.sha256 && document.sha256 !== hash) throw new Error('Source content changed. Review it before changing the pinned hash.')
  const filename = path.join(destination, document.filename)
  writeFileSync(filename + '.download', result.data)
  renameSync(filename + '.download', filename)
  receipts.push({ ...document, resolved_url: result.url, sha256: hash, bytes: result.data.length, downloaded_at: new Date().toISOString() })
  console.log(`Downloaded ${document.filename}: ${result.data.length} bytes; SHA256 ${hash}`)
}
writeFileSync(path.join(destination, 'provenance.json'), JSON.stringify({ ...selected, download_receipts: receipts }, null, 2))
console.log('Original PDFs remain local and excluded from Git. Review them before creating real ground-truth labels.')
