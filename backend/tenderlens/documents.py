import hashlib
import io
import json
import re
import sqlite3
import warnings as python_warnings
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

import pdfplumber
import pypdfium2 as pdfium
import pytesseract
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import Settings
from .store import Store, new_id, now

PDF_LOCK = Lock()  # PDFium's native API must not run concurrently in this process.
MAX_PIXELS = 20_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
MEDIA_TYPES = {
    ".pdf": "application/pdf", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".txt": "text/plain",
}


class DocumentError(ValueError):
    pass


@dataclass
class ExtractedPage:
    number: int
    text: str
    extraction: str
    tables: list = field(default_factory=list)
    width: float | None = None
    height: float | None = None


def pdf_image(data: bytes, number: int, scale: float = 1.3) -> Image.Image:
    with PDF_LOCK:
        pdf = pdfium.PdfDocument(data)
        try:
            if not 1 <= number <= len(pdf):
                raise DocumentError("Page does not exist.")
            page = pdf[number - 1]
            try:
                width, height = page.get_size()
                safe_scale = min(scale, (MAX_PIXELS / max(width * height, 1)) ** 0.5)
                bitmap = page.render(scale=safe_scale)
                try:
                    return bitmap.to_pil().convert("RGB").copy()
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            pdf.close()


def ocr(image: Image.Image, settings: Settings) -> str:
    if not settings.ocr_enabled:
        raise DocumentError(
            "This page needs OCR. Install Tesseract and set OCR_ENABLED=true; "
            "no document text was sent to an external service."
        )
    try:
        return pytesseract.image_to_string(
            image, lang=settings.ocr_languages, timeout=45
        ).strip()
    except (pytesseract.TesseractNotFoundError, pytesseract.TesseractError, RuntimeError) as exc:
        raise DocumentError(
            "Local OCR failed. Check Tesseract installation and configured language packs."
        ) from exc


def table_text(tables: list) -> str:
    blocks = []
    for number, table in enumerate(tables, 1):
        rows = table["rows"]
        blocks.append(f"TABLE {number}\n" + "\n".join(
            " | ".join(cell or "" for cell in row) for row in rows
        ))
    return "\n\n".join(blocks)


def extract(data: bytes, suffix: str, settings: Settings) -> tuple[list[ExtractedPage], list[str]]:
    notices = []
    if suffix == ".txt":
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise DocumentError("Text files must use UTF-8 encoding.") from exc
        if "\x00" in text:
            raise DocumentError("The file is not a supported text document.")
        pages = [ExtractedPage(1, text.strip(), "native_text")]
    elif suffix in {".png", ".jpg", ".jpeg"}:
        try:
            with python_warnings.catch_warnings():
                python_warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as image:
                    if image.width * image.height > MAX_PIXELS:
                        raise DocumentError("Image exceeds the 20-megapixel processing limit.")
                    cleaned = ImageOps.exif_transpose(image).convert("RGB")
                    text = ocr(cleaned, settings)
                    pages = [ExtractedPage(1, text, "ocr", width=image.width, height=image.height)]
        except (UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise DocumentError("Invalid or oversized image file.") from exc
    elif suffix == ".pdf":
        if not data.lstrip().startswith(b"%PDF-"):
            raise DocumentError("This file does not have a PDF signature.")
        pages = []
        try:
            with pdfplumber.open(io.BytesIO(data)) as pdf:
                if not 1 <= len(pdf.pages) <= settings.max_pages:
                    raise DocumentError(f"Upload a PDF with 1-{settings.max_pages} pages.")
                for number, page in enumerate(pdf.pages, 1):
                    text = (page.extract_text(x_tolerance=2) or "").strip()
                    tables = []
                    for table in page.find_tables()[:12]:
                        rows = [
                            [re.sub(r"\s+", " ", cell).strip() if cell else "" for cell in row]
                            for row in table.extract()
                        ]
                        tables.append({"rows": rows, "bbox": list(table.bbox)})
                    method = "native_text"
                    if len(re.sub(r"\W", "", text)) < 20:
                        if settings.ocr_enabled:
                            text = ocr(pdf_image(data, number, scale=1.7), settings)
                            method = "ocr"
                        else:
                            method = "unreadable"
                            notices.append(
                                f"Page {number} has little or no readable text. Enable local OCR "
                                "before relying on package-wide completeness."
                            )
                    if tables:
                        text += "\n\n" + table_text(tables)
                    pages.append(ExtractedPage(
                        number, text, method, tables, page.width, page.height
                    ))
        except DocumentError:
            raise
        except Exception as exc:
            # Parser failures must become a visible failed upload, never an empty success.
            raise DocumentError("PDF extraction failed. It may be encrypted, damaged, or unsupported.") from exc
    else:
        raise DocumentError("Supported uploads are PDF, PNG, JPG and UTF-8 TXT.")
    if not any(len(p.text.strip()) >= 20 for p in pages):
        raise DocumentError("No usable text was extracted. Check the document or enable local OCR.")
    return pages, notices


def chunk_text(text: str, size: int = 1400, overlap: int = 180) -> list[str]:
    text = re.sub(r"[ \t]+", " ", text).strip()
    if not text:
        return []
    result = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            boundary = text.rfind("\n", start + size // 2, end)
            if boundary > start:
                end = boundary
        result.append(text[start:end])
        if end == len(text):
            break
        start = max(start + 1, end - overlap)
    return result


def ingest(
    store: Store, settings: Settings, package_id: str, filename: str, data: bytes,
    kind: str, issued_on: str | None = None, amends_document_id: str | None = None,
) -> dict:
    store.get_package(package_id)
    suffix = Path(filename).suffix.lower()
    if suffix not in MEDIA_TYPES:
        raise DocumentError("Supported uploads are PDF, PNG, JPG and UTF-8 TXT. Excel BOQs are not yet supported.")
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise DocumentError(f"File exceeds the {settings.max_upload_mb} MB limit.")
    if amends_document_id:
        store.document(package_id, amends_document_id)
        if kind != "corrigendum":
            raise DocumentError("Only a corrigendum can declare an amended document.")
    existing = store.documents(package_id)
    digest = hashlib.sha256(data).hexdigest()
    if any(doc["sha256"] == digest for doc in existing):
        raise DocumentError("This exact file is already in this tender package.")
    if len(existing) >= settings.max_documents:
        raise DocumentError(f"A package can contain at most {settings.max_documents} documents.")
    pages, notices = extract(data, suffix, settings)
    document_id = new_id()
    filename = filename.replace("\\", "/").rsplit("/", 1)[-1][:180]
    path = store.uploads / document_id
    path.write_bytes(data)
    try:
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            # Recheck after extraction; concurrent requests must not bypass limits.
            count = db.execute(
                "SELECT COUNT(*) FROM documents WHERE package_id=?", (package_id,)
            ).fetchone()[0]
            if count >= settings.max_documents:
                raise DocumentError("The package document limit was reached.")
            db.execute(
                "INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (document_id, package_id, filename, kind, issued_on, amends_document_id,
                 digest, MEDIA_TYPES[suffix], len(pages), json.dumps(notices), now()),
            )
            for page in pages:
                page_id = new_id()
                db.execute(
                    "INSERT INTO pages VALUES (?,?,?,?,?,?,?,?)",
                    (page_id, document_id, page.number, page.text,
                     json.dumps(page.tables, ensure_ascii=False), page.extraction,
                     page.width, page.height),
                )
                for ordinal, text in enumerate(chunk_text(page.text)):
                    db.execute("INSERT INTO chunks VALUES (?,?,?,?)", (new_id(), page_id, ordinal, text))
    except sqlite3.IntegrityError as exc:
        path.unlink(missing_ok=True)
        raise DocumentError("This document could not be saved; it may have been uploaded already.") from exc
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return store.document(package_id, document_id)


def page_png(store: Store, package_id: str, document_id: str, number: int) -> bytes:
    document = store.document(package_id, document_id)
    if not 1 <= number <= document["page_count"]:
        raise DocumentError("Page does not exist.")
    data = (store.uploads / document_id).read_bytes()
    if document["media_type"] == "application/pdf":
        image = pdf_image(data, number)
    elif document["media_type"].startswith("image/"):
        with Image.open(io.BytesIO(data)) as original:
            image = ImageOps.exif_transpose(original).convert("RGB")
    else:
        raise DocumentError("Text files have no page image. Use the extracted-text view.")
    image.thumbnail((1500, 2000))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()
