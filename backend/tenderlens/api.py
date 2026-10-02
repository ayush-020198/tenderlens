import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .answering import AnswerError, collect_images, generate, prompt_for
from .config import Settings
from .demo import seed_demo
from .documents import DocumentError, ingest, page_png
from .retrieval import RetrievalError, Retriever
from .schemas import AskRequest, DocumentKind, PackageCreate
from .store import Store

logger = logging.getLogger("tenderlens")


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or Settings()
    store = Store(config.data_dir)
    retriever = Retriever(config)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield

    app = FastAPI(title="TenderLens India", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.state.settings = config
    app.state.retriever = retriever
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=config.allowed_hosts)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-TenderLens-Client"],
    )

    @app.middleware("http")
    async def local_guard(request: Request, call_next):
        if request.url.path.startswith("/api/") and request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("x-tenderlens-client") != "browser":
                return JSONResponse(
                    status_code=403, content={"detail": "Missing application request header."}
                )
            origin = request.headers.get("origin")
            if origin and origin not in {
                "http://localhost:5173", "http://127.0.0.1:5173",
                "http://localhost:8000", "http://127.0.0.1:8000",
                "http://localhost:8765", "http://127.0.0.1:8765",
            }:
                return JSONResponse(status_code=403, content={"detail": "Origin not allowed."})
            length = request.headers.get("content-length")
            if length and length.isdecimal() and int(length) > (config.max_upload_mb + 1) * 1024 * 1024:
                return JSONResponse(status_code=413, content={"detail": "Request exceeds the upload limit."})
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(KeyError)
    async def missing_handler(request: Request, exc: KeyError):
        return JSONResponse(status_code=404, content={"detail": str(exc.args[0])})

    @app.exception_handler(DocumentError)
    async def document_handler(request: Request, exc: DocumentError):
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(RetrievalError)
    async def retrieval_handler(request: Request, exc: RetrievalError):
        logger.error("Local retrieval failed: %s", type(exc.__cause__).__name__)
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(AnswerError)
    async def answer_handler(request: Request, exc: AnswerError):
        logger.warning("Answer generation rejected: %s", str(exc))
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(Exception)
    async def internal_handler(request: Request, exc: Exception):
        incident = uuid.uuid4().hex[:10]
        logger.error("Unexpected request failure %s: %s", incident, type(exc).__name__)
        return JSONResponse(status_code=500, content={
            "detail": f"An internal error interrupted this action. Reference: {incident}. No success was recorded."
        })

    @app.get("/api/health")
    def health():
        return {"status": "ok", "country": "IN", "version": "0.1.0"}

    @app.get("/api/config")
    def public_config():
        return {
            "country": "IN", "gemma_model": config.gemma_model,
            "google_configured": config.google_configured,
            "ollama_model": config.ollama_model,
            "retrieval_mode": config.retrieval_mode, "rerank_enabled": config.rerank_enabled,
            "ocr_enabled": config.ocr_enabled, "ocr_languages": config.ocr_languages,
            "max_upload_mb": config.max_upload_mb, "max_pages": config.max_pages,
            "single_user": True,
        }

    @app.get("/api/packages")
    def list_packages():
        return store.packages()

    @app.post("/api/packages", status_code=201)
    def create_package(body: PackageCreate):
        if len(body.name.strip()) < 3:
            raise HTTPException(422, "Enter a package name with at least three visible characters.")
        return store.create_package(body.name, body.reference)

    @app.post("/api/demo", status_code=201)
    def demo():
        return seed_demo(store, config)

    @app.get("/api/packages/{package_id}")
    def get_package(package_id: str):
        return store.get_package(package_id) | {
            "documents": store.documents(package_id), "messages": store.history(package_id)
        }

    @app.post("/api/packages/{package_id}/documents", status_code=201)
    async def upload(
        package_id: str,
        file: Annotated[UploadFile, File()],
        kind: Annotated[DocumentKind, Form()] = "tender",
        issued_on: Annotated[str | None, Form()] = None,
        amends_document_id: Annotated[str | None, Form()] = None,
    ):
        store.get_package(package_id)
        if issued_on:
            try:
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", issued_on):
                    raise ValueError("Not a YYYY-MM-DD date.")
                date.fromisoformat(issued_on)
            except ValueError as exc:
                raise HTTPException(422, "Issue date must use YYYY-MM-DD.") from exc
        data = bytearray()
        try:
            while block := await file.read(1024 * 1024):
                data.extend(block)
                if len(data) > config.max_upload_mb * 1024 * 1024:
                    raise HTTPException(413, f"File exceeds {config.max_upload_mb} MB.")
        finally:
            await file.close()
        return await run_in_threadpool(
            ingest, store, config, package_id, file.filename or "upload",
            bytes(data), kind, issued_on, amends_document_id or None,
        )

    @app.get("/api/packages/{package_id}/documents/{document_id}/pages")
    def pages(package_id: str, document_id: str):
        return store.pages(package_id, document_id)

    @app.get("/api/packages/{package_id}/documents/{document_id}/file")
    def original(package_id: str, document_id: str):
        item = store.document(package_id, document_id)
        return FileResponse(
            store.uploads / document_id,
            media_type=item["media_type"], filename=item["name"],
            content_disposition_type="attachment",
        )

    @app.get("/api/packages/{package_id}/documents/{document_id}/pages/{number}/image")
    def image(package_id: str, document_id: str, number: int):
        return Response(page_png(store, package_id, document_id, number), media_type="image/png")

    @app.post("/api/packages/{package_id}/ask")
    def ask(package_id: str, body: AskRequest):
        store.get_package(package_id)
        if len(body.question.strip()) < 3:
            raise HTTPException(422, "Enter a question with at least three visible characters.")
        if body.provider == "gemma" and not body.consent_external:
            raise HTTPException(
                403, "Confirm you may send selected excerpts, recent questions and optional page images to Google."
            )
        if body.provider == "gemma" and not config.google_configured:
            raise HTTPException(503, "Gemma is not configured. Add GEMINI_API_KEY to the server .env and restart.")
        started = time.perf_counter()
        history = store.history(package_id, limit=3)
        query = body.question
        # Follow-up queries borrow only recent questions from the same package,
        # never earlier generated answers as factual evidence.
        if len(body.question.split()) < 7 and history:
            query = history[-1]["question"] + " " + query
        evidence, notices = retriever.search(store.evidence(package_id), query)
        extraction_notices = [notice for doc in store.documents(package_id) for notice in doc["warnings"]]
        notices = extraction_notices + notices
        if not evidence:
            result = {
                "status": "insufficient", "answer": "No matching passages were retrieved. Try the exact clause, item number or document wording. This is not proof that the information is absent from the tender.",
                "citations": [], "missing": ["Relevant readable source passages"],
                "answer_kind": "evidence_only",
            }
        elif body.provider == "evidence":
            result = {
                "status": "evidence", "answer": "Here are the closest matching passages from your tender package. Open each source to check the wording, dates and conditions. This is local evidence search, not an AI-generated conclusion.",
                "citations": [], "missing": [], "answer_kind": "evidence_only",
            }
        else:
            images = collect_images(store, package_id, evidence) if body.include_images else []
            result = generate(
                config, body.provider, prompt_for(body.question, evidence, history, notices),
                images, evidence,
            )
            result["answer_kind"] = "generated"
            result["image_count"] = len(images)
            notices.append(
                "Citation IDs and quoted text were checked. This does not verify every claim's meaning; inspect the source before acting."
            )
        result.update({
            "sources": evidence, "warnings": list(dict.fromkeys(notices)),
            "provider": body.provider if result["answer_kind"] == "generated" else "evidence",
            "model": (
                config.gemma_model if body.provider == "gemma" else config.ollama_model
            ) if result["answer_kind"] == "generated" else None,
            "retrieval_mode": config.retrieval_mode,
            "elapsed_seconds": round(time.perf_counter() - started, 2),
        })
        return store.save_message(package_id, body.question.strip(), result)

    if config.frontend_dist.is_dir():
        app.mount("/assets", StaticFiles(directory=config.frontend_dist / "assets"), name="assets")

        @app.get("/")
        def home():
            return FileResponse(config.frontend_dist / "index.html")

        @app.get("/favicon.svg")
        def favicon():
            return FileResponse(config.frontend_dist / "favicon.svg", media_type="image/svg+xml")

    return app
