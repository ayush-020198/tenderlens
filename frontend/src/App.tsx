import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown,
  ChevronLeft, ChevronRight, CircleAlert, FileCheck2, FileText, FolderOpen,
  Image as ImageIcon, Layers3, LoaderCircle, LockKeyhole, Menu,
  Moon, Plus, Search, Send, Settings2, ShieldCheck, Sparkles, Sun, UploadCloud, X,
} from 'lucide-react'
import {
  api, pageImageUrl,
  type Config, type DocumentKind, type Evidence, type Message, type PackageDetail,
  type Page, type Provider, type TenderDocument, type TenderPackage,
} from './api'

const suggestions = [
  { label: 'Submission deadline', query: 'What is the current bid submission deadline? Check the corrigendum.', icon: '01' },
  { label: 'EMD & exemptions', query: 'What is the EMD amount? Is any MSME exemption explicitly provided?', icon: '02' },
  { label: 'Eligibility checklist', query: 'What financial and technical eligibility evidence must I submit?', icon: '03' },
  { label: 'Read the BOQ', query: 'What items, quantities, units and warranty requirements are listed in the BOQ?', icon: '04' },
]
const kindLabels: Record<DocumentKind, string> = {
  tender: 'Main tender', corrigendum: 'Corrigendum', annexure: 'Annexure', boq: 'BOQ', form: 'Form',
}
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The action failed. Please retry.'
const dateLabel = (date: string | null) => date
  ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(`${date}T12:00:00+05:30`))
  : 'Issue date not supplied'
const fetchWorkspace = () => Promise.all([api<Config>('/config'), api<TenderPackage[]>('/packages')])

function App() {
  const [config, setConfig] = useState<Config | null>(null)
  const [packages, setPackages] = useState<TenderPackage[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PackageDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')
  const [provider, setProvider] = useState<Provider>('evidence')
  const [consent, setConsent] = useState(false)
  const [includeImages, setIncludeImages] = useState(false)
  const [asking, setAsking] = useState(false)
  const [pendingQuestion, setPendingQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newReference, setNewReference] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadKind, setUploadKind] = useState<DocumentKind>('tender')
  const [issuedOn, setIssuedOn] = useState('')
  const [amends, setAmends] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [source, setSource] = useState<Evidence | null>(null)
  const [sourceDocument, setSourceDocument] = useState<TenderDocument | null>(null)
  const [pages, setPages] = useState<Page[]>([])
  const [pageNumber, setPageNumber] = useState(1)
  const [pageLoading, setPageLoading] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const [sourceTab, setSourceTab] = useState<'text' | 'image'>('text')
  const [imageError, setImageError] = useState(false)
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark')
  const [elapsed, setElapsed] = useState(0)
  const messagesEnd = useRef<HTMLDivElement>(null)
  const sourceSequence = useRef(0)
  const selectPackage = useCallback((id: string | null) => {
    setSelectedId(id)
    setDetail(null)
    setSourceDocument(null)
    sourceSequence.current += 1
  }, [])

  const refresh = useCallback(async () => {
    const [nextConfig, nextPackages] = await fetchWorkspace()
    setConfig(nextConfig)
    setPackages(nextPackages)
    return nextPackages
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchWorkspace().then(([nextConfig, items]) => {
      if (!cancelled) {
        setConfig(nextConfig)
        setPackages(items)
        selectPackage(items[0]?.id ?? null)
      }
    }).catch(e => { if (!cancelled) setError(errorText(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectPackage])

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    api<PackageDetail>(`/packages/${selectedId}`)
      .then(data => { if (!cancelled) setDetail(data) })
      .catch(e => { if (!cancelled) setError(errorText(e)) })
    return () => { cancelled = true }
  }, [selectedId])

  useEffect(() => {
    if (!asking) return
    const start = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [asking])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [detail?.messages.length, asking])

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        setNewOpen(false); setUploadOpen(false); setSettingsOpen(false); setSourceDocument(null)
        sourceSequence.current += 1
      }
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [busy])

  async function openDemo() {
    setBusy(true); setError('')
    try {
      const demo = await api<TenderPackage>('/demo', { method: 'POST' })
      await refresh()
      setMobileNav(false)
      selectPackage(demo.id)
      setDetail(await api<PackageDetail>(`/packages/${demo.id}`))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  async function createPackage(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const item = await api<TenderPackage>('/packages', {
        method: 'POST', body: JSON.stringify({ name: newName, reference: newReference }),
      })
      await refresh(); selectPackage(item.id); setNewOpen(false)
      setNewName(''); setNewReference(''); setUploadOpen(true)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault()
    if (!uploadFile || !selectedId) return
    setBusy(true); setError('')
    const target = selectedId
    const body = new FormData()
    body.append('file', uploadFile); body.append('kind', uploadKind)
    if (issuedOn) body.append('issued_on', issuedOn)
    if (uploadKind === 'corrigendum' && amends) body.append('amends_document_id', amends)
    try {
      await api(`/packages/${target}/documents`, { method: 'POST', body })
      setDetail(await api<PackageDetail>(`/packages/${target}`))
      await refresh(); setUploadOpen(false); setUploadFile(null)
      setIssuedOn(''); setAmends(''); setUploadKind('tender')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  async function ask(event?: React.FormEvent, suggested?: string) {
    event?.preventDefault()
    const text = (suggested ?? question).trim()
    if (!selectedId || text.length < 3 || asking) return
    const target = selectedId
    setError(''); setElapsed(0); setAsking(true); setPendingQuestion(text); setQuestion('')
    try {
      const message = await api<Message>(`/packages/${target}/ask`, {
        method: 'POST',
        body: JSON.stringify({ question: text, provider, consent_external: consent, include_images: includeImages }),
      })
      setDetail(current => current?.id === target ? { ...current, messages: [...current.messages, message] } : current)
    } catch (e) { setError(errorText(e)); setQuestion(text) }
    finally { setAsking(false); setPendingQuestion('') }
  }

  async function openSource(doc: TenderDocument, evidence?: Evidence) {
    if (!selectedId) return
    const sequence = ++sourceSequence.current
    setSourceDocument(doc); setSource(evidence ?? null); setPageNumber(evidence?.page ?? 1)
    setSourceTab('text'); setImageError(false); setPages([]); setPageLoading(true); setSourceError('')
    try {
      const result = await api<Page[]>(`/packages/${selectedId}/documents/${doc.id}/pages`)
      if (sequence === sourceSequence.current) setPages(result)
    } catch (e) { if (sequence === sourceSequence.current) setSourceError(errorText(e)) }
    finally { if (sequence === sourceSequence.current) setPageLoading(false) }
  }

  function evidenceClick(evidence: Evidence) {
    const doc = detail?.documents.find(item => item.id === evidence.document_id)
    if (doc) void openSource(doc, evidence)
  }

  function toggleTheme() {
    document.documentElement.dataset.theme = dark ? 'light' : 'dark'
    setDark(!dark)
  }

  const documents = detail?.documents ?? []
  const ready = documents.length > 0
  const providerLabel = provider === 'gemma' ? 'Gemma 4 · API' : provider === 'ollama' ? 'Local Ollama' : 'Evidence only'
  const activePage = pages.find(page => page.number === pageNumber)
  const hasMessages = (detail?.messages.length ?? 0) > 0

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <button className="icon-button nav-close" aria-label="Close packages" onClick={() => setMobileNav(false)}><X size={17} /></button>
        <a className="brand" href="/" aria-label="TenderLens home">
          <span className="brand-icon"><Layers3 size={23} strokeWidth={1.7} /></span>
          <span>Tender<span className="brand-light">Lens</span><small>INDIA WORKSPACE</small></span>
        </a>
        <button className="new-package" onClick={() => { setNewOpen(true); setMobileNav(false) }} disabled={busy || asking}>
          <Plus size={17} /> New tender package
        </button>
        <div className="nav-heading"><span>YOUR PACKAGES</span><span>{packages.length.toString().padStart(2, '0')}</span></div>
        <nav className="package-list" aria-label="Tender packages">
          {packages.map(item => (
            <button key={item.id} className={`package-link ${selectedId === item.id ? 'active' : ''}`}
              disabled={asking || busy} onClick={() => { selectPackage(item.id); setMobileNav(false) }}>
              <FolderOpen size={18} />
              <span><strong>{item.name}</strong><small>{item.document_count ?? 0} documents{item.demo_key ? ' · Demo' : ''}</small></span>
              {selectedId === item.id && <span className="active-dot" />}
            </button>
          ))}
          {!packages.length && <p className="sidebar-empty">Your documents, questions and evidence stay together here.</p>}
        </nav>
        <button className="sample-card" onClick={() => void openDemo()} disabled={busy || asking}>
          <div><Sparkles size={17} /><span>Take a closer look</span><ArrowUpRight size={15} /></div>
          <p>Explore an Indian tender, a BOQ and its corrigendum.</p>
          <small>Original synthetic sample · not a live bid</small>
        </button>
        <div className="sidebar-bottom">
          <button className="subtle-button" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /> Model & privacy</button>
          <button className="subtle-button" onClick={toggleTheme}>{dark ? <Sun size={17} /> : <Moon size={17} />} {dark ? 'Light appearance' : 'Dark appearance'}</button>
          <div className="local-note"><span className="connection-dot" /> Local workspace <LockKeyhole size={12} /></div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button className="icon-button mobile-menu" aria-label="Open packages" onClick={() => setMobileNav(!mobileNav)}><Menu size={20} /></button>
            <span className="breadcrumb-root">Workspace</span><ChevronRight size={14} /><strong>{detail?.name ?? 'Tender intelligence'}</strong>
          </div>
          <div className="topbar-actions">
            <span className="india-tag">IN <span /> India first</span>
            <button className="model-pill" onClick={() => setSettingsOpen(true)}>
              {provider === 'evidence' ? <Search size={14} /> : <Sparkles size={14} />}
              {providerLabel}<ChevronDown size={13} />
            </button>
          </div>
        </header>

        {error && <div role="alert" className="error-banner"><CircleAlert size={19} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}

        <div className="workspace-grid">
          <section className="conversation">
            <div className="conversation-scroll">
              {!hasMessages && !asking ? (
                <div className="welcome">
                  <div className="eyebrow"><span /> CLARITY BEFORE COMMITMENT</div>
                  <h1>Read the tender.<br /><span>Know what matters.</span></h1>
                  <p className="welcome-description">From EMD to the smallest footnote. Ask questions about your Indian tender package and follow every answer back to its source.</p>
                  <div className="trust-strip"><span><ShieldCheck size={15} /> Evidence-linked</span><span><BookOpen size={15} /> Amendment-aware</span><span><LockKeyhole size={15} /> You control sharing</span></div>
                  {!selectedId && !loading && (
                    <div className="welcome-actions">
                      <button className="primary-button" onClick={() => setNewOpen(true)}><Plus size={17} /> Create a tender package</button>
                      <button className="text-button" onClick={() => void openDemo()} disabled={busy}>Explore the sample <ArrowRight size={16} /></button>
                    </div>
                  )}
                  {selectedId && !ready && detail && (
                    <button className="primary-button" onClick={() => setUploadOpen(true)}><UploadCloud size={17} /> Add your first document</button>
                  )}
                  {(loading || (selectedId && !detail)) && <div className="loading-inline"><LoaderCircle className="spin" size={17} /> Opening workspace…</div>}
                  <div className="starter-heading"><span>A FEW GOOD QUESTIONS</span><span>Start here <ArrowDownToLine size={12} /></span></div>
                  <div className="suggestion-grid">
                    {suggestions.map(item => (
                      <button key={item.icon} className="suggestion" disabled={!ready || busy}
                        onClick={() => { setQuestion(item.query); document.getElementById('question')?.focus() }}>
                        <span className="suggestion-number">{item.icon}</span><strong>{item.label}</strong>
                        <p>{item.query}</p><ArrowUpRight size={17} />
                      </button>
                    ))}
                  </div>
                  <p className="scope-note">Built for Indian procurement documents. No assumed exemptions, invented clauses or automatic bid submissions.</p>
                </div>
              ) : (
                <div className="messages" aria-live="polite">
                  {detail?.demo_key && <div className="demo-notice"><CircleAlert size={14} /> Synthetic package. Dates and amounts are fictional.</div>}
                  {detail?.messages.map(message => (
                    <article className="message-pair" key={message.id}>
                      <div className="user-message"><span className="avatar user-avatar">Y</span><div><span className="message-label">YOU</span><p>{message.question}</p></div></div>
                      <div className="assistant-message">
                        <span className="avatar assistant-avatar"><Layers3 size={17} /></span>
                        <div className="answer-content">
                          <div className="answer-heading"><span className="message-label">TENDERLENS</span><span className={`status-badge ${message.result.status}`}>
                            {message.result.status === 'evidence' ? 'Evidence search' : message.result.status === 'insufficient' ? 'More evidence needed' : message.result.status === 'conflicting' ? 'Conflicting evidence' : 'Citations matched'}
                          </span></div>
                          <p className="answer-text">{message.result.answer}</p>
                          {message.result.missing.length > 0 && <div className="missing-box"><strong>Still needed</strong><ul>{message.result.missing.map(item => <li key={item}>{item}</li>)}</ul></div>}
                          {message.result.sources.length > 0 && (
                            <div className="evidence-grid">
                              {message.result.sources.map(evidence => {
                                const quote = message.result.citations.find(citation => citation.source_id === evidence.source_id)?.quote
                                return <button key={evidence.source_id} className="evidence-card" onClick={() => evidenceClick(evidence)}>
                                  <div><span className="source-id">{evidence.source_id}</span><span>{kindLabels[evidence.kind]}</span><ArrowUpRight size={14} /></div>
                                  <strong>{evidence.document_name}</strong>
                                  <p>{quote ?? evidence.text.slice(0, 170)}{!quote && evidence.text.length > 170 ? '…' : ''}</p>
                                  <small><FileText size={12} /> Page {evidence.page} · Open source</small>
                                </button>
                              })}
                            </div>
                          )}
                          {message.result.warnings.length > 0 && <details className="answer-warnings"><summary>Evidence limitations ({message.result.warnings.length})</summary><ul>{message.result.warnings.map(item => <li key={item}>{item}</li>)}</ul></details>}
                          <div className="answer-footer"><span>{message.result.answer_kind === 'generated' ? message.result.model : 'Local evidence · no LLM'}</span><span>{message.result.elapsed_seconds}s · {message.result.retrieval_mode}{message.result.image_count ? ` · ${message.result.image_count} page images` : ''}</span></div>
                        </div>
                      </div>
                    </article>
                  ))}
                  {asking && <div className="pending-response"><div className="user-message"><span className="avatar user-avatar">Y</span><p>{pendingQuestion}</p></div><div className="loading-inline"><LoaderCircle className="spin" size={17} /><span>{provider === 'evidence' ? 'Finding source passages' : 'Reading the evidence'}… {elapsed}s</span></div>{provider === 'ollama' && <small>CPU-only local models can take several minutes.</small>}</div>}
                  <div ref={messagesEnd} />
                </div>
              )}
            </div>
            <div className="composer-area">
              {provider === 'gemma' && <label className="consent-line"><input type="checkbox" checked={consent} disabled={asking} onChange={event => setConsent(event.target.checked)} />I may share selected excerpts, recent questions{includeImages ? ' and page images' : ''} with Google for this request.</label>}
              <form className="composer" onSubmit={event => void ask(event)}>
                <textarea id="question" aria-label="Ask about this tender" rows={2} maxLength={1600}
                  placeholder={ready ? 'Ask about dates, EMD, eligibility, a BOQ row…' : 'Add a tender package to begin…'}
                  value={question} onChange={event => setQuestion(event.target.value)} disabled={!ready || asking}
                  onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask() } }} />
                <div className="composer-bottom">
                  <div><button type="button" className="context-count" disabled={asking || busy} onClick={() => selectedId ? setUploadOpen(true) : setNewOpen(true)} aria-label="Add a document to this package"><FileCheck2 size={14} />{documents.length} documents <Plus size={12} /></button><button type="button" className={`vision-toggle ${includeImages ? 'enabled' : ''}`} disabled={provider === 'evidence' || asking} onClick={() => setIncludeImages(!includeImages)}><ImageIcon size={14} />Page vision {includeImages ? 'on' : 'off'}</button></div>
                  <button className="send-button" aria-label="Send question" disabled={!ready || asking || question.trim().length < 3 || (provider === 'gemma' && (!consent || !config?.google_configured || !config?.google_free_tier_confirmed))}>
                    {asking ? <LoaderCircle size={18} className="spin" /> : <Send size={18} />}
                  </button>
                </div>
              </form>
              <p className="composer-disclaimer">A reading assistant, not a procurement authority. Verify source documents before acting.</p>
            </div>
          </section>

          <aside className="document-panel">
            <div className="panel-heading"><div><span className="eyebrow">YOUR EVIDENCE</span><h2>Document room</h2></div><span className="count-badge">{documents.length}</span></div>
            {detail?.reference && <div className="reference-tag">{detail.reference}</div>}
            <button className="upload-zone" onClick={() => selectedId ? setUploadOpen(true) : setNewOpen(true)} disabled={busy || asking}>
              <span className="upload-icon"><UploadCloud size={23} strokeWidth={1.5} /></span>
              <strong>Add tender documents</strong><span>PDF, PNG, JPG or TXT</span><small>Up to {config?.max_upload_mb ?? 15} MB per file</small>
            </button>
            <div className="document-list">
              {documents.map(doc => (
                <button key={doc.id} className="document-card" onClick={() => void openSource(doc)}>
                  <span className={`file-icon ${doc.kind}`}><FileText size={19} /></span>
                  <span className="document-meta"><strong>{doc.name}</strong><small>{doc.page_count} {doc.page_count === 1 ? 'page' : 'pages'} · {kindLabels[doc.kind]}</small>{doc.kind === 'corrigendum' && <span className="amendment-label">Amendment · check scope</span>}{doc.warnings.length > 0 && <span className="document-warning"><CircleAlert size={12} /> Extraction needs review</span>}</span>
                  <ChevronRight size={14} />
                </button>
              ))}
              {!documents.length && <div className="empty-documents"><FileText size={26} strokeWidth={1.3} /><p>The notice is just the beginning.</p><span>Add annexures, BOQs and corrigenda to keep the complete picture together.</span></div>}
            </div>
            <div className="pipeline-card">
              <div><span className="connection-dot" /><strong>Evidence before answers</strong></div>
              <ol><li><span>1</span> Read and extract locally</li><li><span>2</span> Find relevant passages</li><li><span>3</span> Answer with source references</li></ol>
              <p>{provider === 'evidence' ? 'Current mode sends no document content to an LLM.' : provider === 'gemma' ? 'Only approved evidence goes to Google. Original files stay here.' : 'Selected evidence goes to your loopback Ollama server.'}</p>
            </div>
          </aside>
        </div>
      </main>

      {newOpen && <div className="modal-overlay" onClick={() => !busy && setNewOpen(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-title" onClick={event => event.stopPropagation()}>
        <button className="modal-close icon-button" aria-label="Close new package" onClick={() => setNewOpen(false)} disabled={busy}><X size={19} /></button>
        <span className="modal-symbol"><FolderOpen size={25} /></span><h2 id="new-title">One tender. One clear picture.</h2><p>Keep the notice, annexures and every corrigendum in the same package.</p>
        <form onSubmit={event => void createPackage(event)}>
          <label>Package name<input autoFocus required minLength={3} maxLength={120} value={newName} onChange={event => setNewName(event.target.value)} placeholder="e.g. Campus network upgrade" /></label>
          <label>Tender reference <small>optional</small><input maxLength={100} value={newReference} onChange={event => setNewReference(event.target.value)} placeholder="Tender / department / reference number" /></label>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="primary-button full-width" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />} Create package</button>
        </form>
      </section></div>}

      {uploadOpen && <div className="modal-overlay" onClick={() => !busy && setUploadOpen(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title" onClick={event => event.stopPropagation()}>
        <button className="modal-close icon-button" aria-label="Close upload" onClick={() => setUploadOpen(false)} disabled={busy}><X size={19} /></button>
        <span className="modal-symbol"><UploadCloud size={25} /></span><h2 id="upload-title">Add a piece of the picture.</h2><p>Extraction happens locally. A document is only added after processing succeeds.</p>
        <form onSubmit={event => void upload(event)}>
          <label className="file-picker"><UploadCloud size={21} /><strong>{uploadFile?.name ?? 'Choose a document'}</strong><span>PDF, PNG, JPG, TXT · {config?.max_upload_mb ?? 15} MB max</span><input type="file" aria-label="Choose tender document" accept=".pdf,.png,.jpg,.jpeg,.txt" required onChange={event => setUploadFile(event.target.files?.[0] ?? null)} /></label>
          <div className="form-row"><label>Document type<select value={uploadKind} onChange={event => setUploadKind(event.target.value as DocumentKind)}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Issue date <small>optional</small><input type="date" value={issuedOn} onChange={event => setIssuedOn(event.target.value)} /></label></div>
          {uploadKind === 'corrigendum' && <label>Amends which document?<select value={amends} onChange={event => setAmends(event.target.value)}><option value="">Not specified / verify manually</option>{documents.filter(doc => doc.kind !== 'corrigendum').map(doc => <option key={doc.id} value={doc.id}>{doc.name}</option>)}</select></label>}
          <div className="privacy-callout"><LockKeyhole size={15} /><span>Nothing is sent to Google during upload. Scanned pages require local OCR; unreadable pages are flagged.</span></div>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="primary-button full-width" disabled={busy || !uploadFile}>{busy ? <><LoaderCircle className="spin" size={17} />Extracting & indexing…</> : <><UploadCloud size={17} />Upload and read</>}</button>
        </form>
      </section></div>}

      {settingsOpen && <div className="modal-overlay" onClick={() => setSettingsOpen(false)}><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()}>
        <button className="modal-close icon-button" aria-label="Close model settings" onClick={() => setSettingsOpen(false)}><X size={19} /></button>
        <span className="eyebrow">TRANSPARENCY BY DESIGN</span><h2 id="settings-title">Choose how answers happen.</h2><p>The mode is always visible. No hidden provider fallback.</p>
        {([
          ['evidence', 'Evidence only', 'Find relevant passages locally. No API key, no LLM, no external sharing.', Search],
          ['gemma', 'Gemma 4 via Gemini API', config?.google_configured ? (config.google_free_tier_confirmed ? `${config.gemma_model} · key configured · Free-tier project confirmed.` : 'Key configured, but the Free-tier project is not confirmed. Billing must stay disabled.') : 'Add GEMINI_API_KEY to the server .env and restart. Your key never goes in the browser.', Sparkles],
          ['ollama', 'Local Ollama', `${config?.ollama_model ?? 'Local model'} · localhost only. CPU inference may take minutes.`, LockKeyhole],
        ] as const).map(([value, title, description, Icon]) => <button key={value} className={`provider-option ${provider === value ? 'selected' : ''}`}
          disabled={asking} onClick={() => { setProvider(value); setConsent(false); if (value === 'evidence') setIncludeImages(false) }}>
          <Icon size={21} /><span><strong>{title}</strong><small>{description}</small></span>{provider === value && <Check size={18} />}
        </button>)}
        <div className="settings-facts"><span>Retrieval <strong>{config?.retrieval_mode.toUpperCase() ?? '—'}</strong></span><span>Local OCR <strong>{config?.ocr_enabled ? config.ocr_languages : 'Off'}</strong></span><span>Scope <strong>India · English-first</strong></span></div>
        <div className="privacy-callout"><ShieldCheck size={18} /><span>Use public or approved, redacted tenders with the API. Evidence matching is not legal verification. This prototype is single-user and must not be exposed publicly without authentication.</span></div>
        <button className="primary-button full-width" onClick={() => setSettingsOpen(false)}>Continue with {providerLabel}<ArrowRight size={17} /></button>
      </section></div>}

      {sourceDocument && <div className="source-overlay" onClick={() => { setSourceDocument(null); sourceSequence.current += 1 }}>
        <section className="source-drawer" role="dialog" aria-modal="true" aria-labelledby="source-title" onClick={event => event.stopPropagation()}>
          <header><div><span className="eyebrow">SOURCE, NOT GUESSWORK</span><h2 id="source-title">{sourceDocument.name}</h2><p>{kindLabels[sourceDocument.kind]} · {dateLabel(sourceDocument.issued_on)}</p></div><button className="icon-button" aria-label="Close source" onClick={() => { setSourceDocument(null); sourceSequence.current += 1 }}><X size={21} /></button></header>
          <div className="source-toolbar"><div className="segmented-control"><button className={sourceTab === 'text' ? 'selected' : ''} onClick={() => setSourceTab('text')}><FileText size={14} />Extracted text</button><button className={sourceTab === 'image' ? 'selected' : ''} disabled={sourceDocument.media_type === 'text/plain'} onClick={() => setSourceTab('image')}><ImageIcon size={14} />Original page</button></div><a className="icon-button" aria-label="Download original" href={`/api/packages/${selectedId}/documents/${sourceDocument.id}/file`}><ArrowDownToLine size={17} /></a></div>
          <div className="page-navigation"><button className="icon-button" aria-label="Previous page" disabled={pageNumber <= 1} onClick={() => { setPageNumber(pageNumber - 1); setImageError(false) }}><ChevronLeft size={17} /></button><span>Page {pageNumber} of {sourceDocument.page_count}</span><button className="icon-button" aria-label="Next page" disabled={pageNumber >= sourceDocument.page_count} onClick={() => { setPageNumber(pageNumber + 1); setImageError(false) }}><ChevronRight size={17} /></button></div>
          <div className="source-body">
            {pageLoading && <div className="loading-inline"><LoaderCircle className="spin" size={17} />Loading source…</div>}
            {sourceError && <div role="alert" className="inline-error">{sourceError}</div>}
            {!pageLoading && activePage && sourceTab === 'text' && <>
              {source?.page === pageNumber && <div className="retrieved-excerpt"><span><Search size={13} /> RETRIEVED PASSAGE · {source.source_id}</span><p>{source.text}</p></div>}
              <div className="source-extraction-label">{activePage.extraction.replaceAll('_', ' ')} · check original for layout and footnotes</div>
              <pre className="document-text">{activePage.text || 'No readable text. Enable OCR and re-upload this document.'}</pre>
              {activePage.tables.map((table, index) => <div className="extracted-table" key={index}><span>Detected table {index + 1}</span><div><table><tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div></div>)}
            </>}
            {!pageLoading && sourceTab === 'image' && selectedId && <>{imageError ? <p role="alert" className="inline-error">Page preview failed. Download the original or try the extracted-text view.</p> : <img className="page-image" src={pageImageUrl(selectedId, sourceDocument.id, pageNumber)} alt={`Original page ${pageNumber} of ${sourceDocument.name}`} onError={() => setImageError(true)} />}</>}
          </div>
          <footer><ShieldCheck size={15} /> Source location verified by the app. Interpretation still needs your review.</footer>
        </section>
      </div>}
    </div>
  )
}

export default App
