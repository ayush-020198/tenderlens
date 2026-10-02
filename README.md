# TenderLens India

**Read the tender. Know what matters.**

An evidence-first workspace for Indian tender notices, annexures, BOQs, forms
and corrigenda. Upload a package, ask a question, and inspect the exact source
page instead of trusting an unsupported answer.

**Status:** functional single-user prototype. **India-only, English-first.**
No model has been trained or fine-tuned. This is not a procurement authority,
legal adviser, bidder-eligibility certification tool, or automatic bid submitter.

## What you can do

- Group related documents into a tender package; retain page-level provenance.
- Search EMD, bid fees, GST wording, turnover, eligibility, quantities and deadlines.
- Inspect extracted text, detected PDF tables, original pages and quoted evidence.
- Include explicit corrigendum links without treating upload order as legal precedence.
- Choose no-key evidence search, hosted Gemma 4, or an existing local Ollama model.

The responsive React interface includes light/dark themes, package navigation,
an evidence panel, a source-page drawer, provider disclosure and visible errors.
The bundled demo is **entirely synthetic**, including its future-dated amendment.

## API or local model?

**API-first for generated answers; local-first for document processing.**

| Mode | What happens | Requirements |
|---|---|---|
| Evidence only (default) | Retrieves real passages; does **not** pretend to generate an AI answer | No model or API key |
| Gemma via Gemini API | Sends selected passages, recent questions and optionally up to two page images to Google | Server-side API key, model access and per-request user consent |
| Local Ollama | Sends context to a loopback Ollama server | An already installed model; no automatic model download |

Google's [Gemma API documentation](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api)
lists `gemma-4-26b-a4b-it` and `gemma-4-31b-it`, including image input.
The default is `gemma-4-26b-a4b-it`. Account availability, quota and policies still
apply. No live Google request is made by the default tests.

API-first is **not** offline. The app never switches from a failed local model
to a hosted provider, and it never substitutes another model after a Gemma error.
Model access, timeout, invalid JSON and mismatched citations are visible failures.

## Architecture

```text
React / TypeScript / Vite
           |
        FastAPI
           |
  SQLite + private local uploads
           |
  Native PDF/text extraction ---- scanned pages -> optional local Tesseract OCR
           |
  Page-bound text chunks + table rows + document/amendment metadata
           |
  BM25 baseline OR multilingual embeddings + BM25 + optional reranking
           |
  Evidence-only response OR consent-gated Gemma / loopback Ollama
           |
  Answer schema + source-ID / verbatim-quote validation
           |
  Answer + evidence cards + original page
```

The model does **not** receive the complete repository or an entire tender by
default. Documents are data, not executable instructions. No model tools, web
search, document-supplied URLs or shell execution are enabled.

### Deliberate limits

- PDF, PNG, JPG and UTF-8 TXT uploads; **Excel/CSV BOQs and DOCX are not supported yet**.
- Maximum 15 MB per file, 80 PDF pages and 20 documents per package by default.
- Local OCR is optional and explicit. Unreadable PDF pages are flagged; an
  entirely unreadable upload fails rather than appearing successful.
- A citation can match its source while the model still misinterprets it.
  **Quote matching is not semantic verification or a guarantee of correctness.**
- This synchronous, single-worker prototype is not designed for large concurrent
  OCR jobs, multi-user authorization or public deployment.

## Quick start

### Prerequisites

- Python **3.12 or 3.13**; Python 3.12 is the tested target.
- [uv](https://docs.astral.sh/uv/getting-started/installation/).
- Node.js **24 LTS** recommended (Vite requires Node 20.19+ or 22.12+).
- Access to the permitted package registries; optional Tesseract for scans.
- Your personal GitHub access for this private repository.

### 1. Clone and configure

```powershell
git clone https://github.com/ayush-020198/tenderlens.git
cd tenderlens
Copy-Item .env.example .env
uv sync --python 3.12
```

Do not put credentials in source code, `VITE_*` variables, command history,
screenshots, dataset manifests or Git commits. `.env` and `data/` are ignored.

### 2. Build the UI

```powershell
npm --prefix frontend ci
npm --prefix frontend run build
```

### 3. Start the application

```powershell
uv run uvicorn tenderlens.api:create_app --factory --host 127.0.0.1 --port 8000
```

Open **http://127.0.0.1:8000** and choose **Take a closer look**.
The app generates the synthetic Indian PDF package locally and indexes it.
Ask about the submission deadline, EMD or BOQ. Default answers are clearly labeled
**Evidence search**, not Gemma-generated text.

For UI development, run the API command above in one terminal, then:

```powershell
cd frontend
npm run dev
```

Open **http://127.0.0.1:5173**. Vite proxies `/api` to the local backend.
Stop each foreground process with Ctrl+C when finished.

### 4. Enable Gemma answers

Create an authorized key in [Google AI Studio](https://aistudio.google.com/apikey).
Edit your **local** `.env`:

```dotenv
GEMINI_API_KEY=your-key-goes-here-only-locally
GEMMA_MODEL=gemma-4-26b-a4b-it
```

Restart the API, open **Model & privacy**, and select **Gemma 4 via Gemini API**.
Before submitting a question, confirm the document-sharing checkbox.
**Page vision** additionally shares rendered source-page images; leave it off
when text evidence is sufficient.

Use public or authorized, appropriately redacted documents. Read the
[Gemini API terms](https://ai.google.dev/gemini-api/terms), including applicable
data-use conditions. Do not assume an unpaid API has confidential-data guarantees.

### 5. Optional local inference

Configure an already installed Ollama instance:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:4b
```

Choose **Local Ollama** in the UI. Cloud/remote model metadata is rejected.
Configure Ollama itself for local-only operation (`OLLAMA_NO_CLOUD=1`) and do not
sign into or select a cloud model. CPU inference can take minutes. Vision requires
a model that actually supports image input.

Gemma API use is the intended Gemma-track path. A local Qwen option is an explicit
alternative for experimentation, **not a claim that Qwen is Gemma**.

## Local embeddings and reranking

The default BM25 pipeline is intentionally usable without downloading model weights.
For the pretrained local hybrid pipeline:

```powershell
uv sync --extra retrieval
```

Then edit `.env` and restart:

```dotenv
RETRIEVAL_MODE=hybrid
EMBEDDING_MODEL=intfloat/multilingual-e5-small
RERANK_ENABLED=true
RERANK_MODEL=Xenova/ms-marco-MiniLM-L-6-v2
```

FastEmbed downloads these public model weights on first use. Inference stays local;
document text is not uploaded to an embedding API. Model downloads require permitted
network access and their respective licenses still apply.

Hybrid retrieval combines BM25 and dense rankings using reciprocal-rank fusion.
The reranker is English-oriented and is skipped for Devanagari queries with an
explicit notice. Hindi support is experimental: neither a multilingual embedding
model nor a language pack proves Hindi-tender accuracy.

Cache files and model assets are under `data/`, excluded from Git. If the chosen
pipeline cannot initialize, the app reports that failure instead of silently
using a different retrieval method.

## Scanned documents and Hindi

Install Tesseract from an approved source and add its executable to PATH.
Use `tesseract --list-langs` to confirm the language packs. For English/Hindi:

```dotenv
OCR_ENABLED=true
OCR_LANGUAGES=eng+hin
```

Restart the API, then re-upload documents that previously failed extraction.
OCR is bounded per page. Scanned-table reconstruction is limited: inspect the
original page and use authorized page vision when needed. Do not assume OCR
preserves columns, decimal places or footnotes.

## Indian sample data

### Included: synthetic development package

`backend/tenderlens/data/demo.json` is original fictional data containing a notice,
eligibility conditions, a BOQ and a date-only corrigendum. It is bundled with the
application and safe to use without an external tender download.

`datasets/synthetic-development.json` contains ten development questions with
expected answers and required source documents. They are **not training data,
not an independent benchmark, and not real procurement advice**.

### Download separately: official historical Indian documents

`datasets/sources.json` records an IISc Bengaluru archive, a 2021 wall-mounted-fan
tender and its listed corrigendum. These are historical reading examples, not
active opportunities. The manifest records content hashes and rights limitations.

```powershell
python scripts\fetch_public_samples.py --acknowledge-source-terms
```

Downloads go to `data/public/iisc-wall-fans-2021/` with a SHA-256 provenance receipt.
Review the references and the actual amendment scope, then upload the PDFs through
the UI. The script rejects non-PDF responses, unexpected hosts, oversized downloads
and changed hashes. It does not bypass login, CAPTCHA or source access controls.

**Real PDFs are not committed or redistributed.** Public availability is not a
training or redistribution license. Publisher terms and attribution remain applicable.

### Why no random Kaggle dataset?

The first requirement is an Indian tender package with authoritative source pages,
not an unrelated document benchmark. No Kaggle credentials or dataset are required.
A future Kaggle source must first be checked for Indian coverage, original-document
provenance, license, duplicate tender families and usable page-level annotations.

For a real evaluation pilot, collect 10-20 permitted Indian tender packages and
200-500 human-reviewed questions. Separate development and untouched test packages.
Keep a tender and all its amendments in the same split; avoid near-identical template
families leaking across splits.

## Validation

### Backend

```powershell
uv run pytest -q
uv run ruff check backend tests scripts
```

Tests cover source isolation, consent/key gates, malformed/oversized uploads,
PDF page previews, synthetic amendments, quote validation, provider request shape
and local-only routing. They use a mocked hosted API, not a paid or live Gemma call.

### Frontend and browser

```powershell
npm --prefix frontend run lint
npm --prefix frontend run build
cd frontend
npm run test:e2e
```

Local browser checks use installed Microsoft Edge. CI uses Chromium.
Playwright starts and stops a dedicated API server with separate test data.

If backend dependencies are unavailable, UI-only contract checks can run against
explicit browser fixtures:

```powershell
$env:MOCK_API = "1"
npm run test:e2e
Remove-Item Env:MOCK_API
```

These mock checks **do not prove backend or model functionality**. GitHub Actions
runs real backend tests on Windows/Linux and browser flows against the real API.

### Retrieval development checks

```powershell
uv run python scripts\check_retrieval.py
```

This reports whether expected synthetic source documents were retrieved.
It does not grade answer correctness. Measure OCR critical-field errors, evidence
recall, citation support, amendment handling, abstention, latency and cost separately.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | empty | Server-only key; never returned by `/api/config` |
| `GEMMA_MODEL` | `gemma-4-26b-a4b-it` | Hosted Gemma model |
| `TENDERLENS_DATA_DIR` | `./data` | SQLite, originals and caches |
| `RETRIEVAL_MODE` | `bm25` | `bm25` or `hybrid` |
| `EMBEDDING_MODEL` | `intfloat/multilingual-e5-small` | Optional local embedder |
| `RERANK_ENABLED` | `false` | Requires hybrid retrieval |
| `RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Optional English cross-encoder |
| `OCR_ENABLED` | `false` | Local scanned-page OCR |
| `OCR_LANGUAGES` | `eng` | Installed Tesseract languages |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Loopback only |
| `OLLAMA_MODEL` | `qwen3.5:4b` | Explicit local alternative |

## Privacy and operational boundaries

- Files, extracted content, embeddings and chat history are stored unencrypted
  in the selected local data directory. Protect that directory; retain only permitted data.
- Hosted requests require explicit UI consent and a server-side key. Selected
  page images can contain more information than the quoted passage.
- Source-ID/quote checks do not establish semantic entailment, eligibility or
  legal precedence. Users must inspect original documents before acting.
- Host/origin checks reduce accidental browser exposure; they are **not
  authentication**. Other authorized users/processes on the same machine are
  outside this prototype's isolation boundary.
- Do not expose the server publicly. Production needs identity/authorization,
  encrypted storage, tenant isolation, retention/deletion controls, quotas,
  sandboxed document workers, monitoring and a separate security review.

## Corporate networks / package access

An accessible `https://pypi.org/` index does not guarantee that the package-file
host `https://files.pythonhosted.org/` is permitted. If downloads fail on a managed
DevBox, ask its owner or IT for the **approved Python package feed and instructions**,
or use a permitted personal development machine.

Do not disable TLS verification, tunnel around a network block, put credentials in
index URLs, or use an untrusted mirror. This repository does not contain internal
feed addresses, company tokens, employer code or private work configuration.

GitHub-hosted CI validates the original project code and synthetic fixtures on
separate standard runners. It does not move downloaded packages back onto the
restricted DevBox or change the DevBox's policy.

## Container setup

On a permitted machine with Docker:

```powershell
docker build -t tenderlens .
docker run --rm -p 127.0.0.1:8000:8000 --env-file .env -v tenderlens-data:/app/data tenderlens
```

The container includes English/Hindi Tesseract and runs as a non-root user.
Set `OCR_ENABLED=true` to use OCR. It does not include local LLM weights or optional
embedding models. Loopback Ollama refers to the container itself; configure a
reviewed local network integration before attempting container-to-host inference.

## Roadmap and training policy

1. Establish the pretrained extraction/retrieval/Gemma baseline with source evidence.
2. Assemble permitted Indian tender packages and human-reviewed development/test splits.
3. Diagnose errors by component rather than guessing that the LLM needs training.
4. Improve the failing extractor, chunking, retrieval, reranker or prompt.
5. Consider targeted fine-tuning only after repeatable failures and a held-out
   comparison demonstrate a need. No training job is included in this prototype.

Multi-user cloud deployment, Excel BOQs, robust scanned-table reconstruction,
regional-language evaluation and explicit amendment-scope reasoning are next-stage
work. International expansion comes after the Indian workflow is evaluated;
currency, date conventions, procurement terminology and jurisdiction policies
must not be blindly generalized.

## Project layout

```text
backend/tenderlens/   API, extraction, retrieval, providers, storage and demo
frontend/            React workspace and browser tests
tests/               Backend regression tests
datasets/            Source manifests and synthetic development questions
scripts/             Approved-source downloader and retrieval checks
data/                Private runtime artifacts (gitignored)
```

## License and attribution

Application code and original synthetic fixtures: [MIT](LICENSE).
Theme and third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Downloaded documents, model weights and dependencies retain their own terms.
