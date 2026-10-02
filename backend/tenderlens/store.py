import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path


def new_id() -> str:
    return uuid.uuid4().hex


def now() -> str:
    return datetime.now(UTC).isoformat()


class Store:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.uploads = self.root / "uploads"
        self.uploads.mkdir(exist_ok=True)
        self.path = self.root / "tenderlens.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS packages (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, reference TEXT NOT NULL,
                    created_at TEXT NOT NULL, demo_key TEXT UNIQUE
                );
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES packages(id),
                    name TEXT NOT NULL, kind TEXT NOT NULL, issued_on TEXT,
                    amends_document_id TEXT REFERENCES documents(id),
                    sha256 TEXT NOT NULL, media_type TEXT NOT NULL, page_count INTEGER NOT NULL,
                    warnings TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(package_id, sha256)
                );
                CREATE TABLE IF NOT EXISTS pages (
                    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
                    number INTEGER NOT NULL, text TEXT NOT NULL, tables_json TEXT NOT NULL,
                    extraction TEXT NOT NULL, width REAL, height REAL,
                    UNIQUE(document_id, number)
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id),
                    ordinal INTEGER NOT NULL, text TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES packages(id),
                    question TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS documents_package ON documents(package_id);
                CREATE INDEX IF NOT EXISTS messages_package ON messages(package_id, created_at);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def create_package(self, name: str, reference: str = "", demo_key: str | None = None) -> dict:
        record = dict(
            id=new_id(), name=name.strip(), reference=reference.strip(),
            created_at=now(), demo_key=demo_key,
        )
        with self.connect() as db:
            db.execute(
                "INSERT INTO packages VALUES (:id,:name,:reference,:created_at,:demo_key)", record
            )
        return self.get_package(record["id"])

    def get_package(self, package_id: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM packages WHERE id=?", (package_id,)).fetchone()
        if row is None:
            raise KeyError("Tender package not found.")
        return dict(row)

    def packages(self) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("""
                SELECT p.*, COUNT(d.id) AS document_count,
                COALESCE(SUM(d.page_count),0) AS page_count FROM packages p
                LEFT JOIN documents d ON d.package_id=p.id
                GROUP BY p.id ORDER BY p.created_at DESC
            """).fetchall()
        return [dict(row) for row in rows]

    def documents(self, package_id: str) -> list[dict]:
        self.get_package(package_id)
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM documents WHERE package_id=? ORDER BY created_at",
                (package_id,),
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["warnings"] = json.loads(item["warnings"])
            result.append(item)
        return result

    def document(self, package_id: str, document_id: str) -> dict:
        for item in self.documents(package_id):
            if item["id"] == document_id:
                return item
        raise KeyError("Document not found in this tender package.")

    def pages(self, package_id: str, document_id: str) -> list[dict]:
        self.document(package_id, document_id)
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM pages WHERE document_id=? ORDER BY number", (document_id,)
            ).fetchall()
        return [dict(row) | {"tables": json.loads(row["tables_json"])} for row in rows]

    def evidence(self, package_id: str) -> list[dict]:
        self.get_package(package_id)
        with self.connect() as db:
            rows = db.execute("""
                SELECT c.id, c.text, c.ordinal, p.number AS page, p.extraction,
                d.id AS document_id, d.name AS document_name, d.kind, d.issued_on,
                d.amends_document_id FROM chunks c
                JOIN pages p ON p.id=c.page_id
                JOIN documents d ON d.id=p.document_id
                WHERE d.package_id=? ORDER BY d.created_at,p.number,c.ordinal
            """, (package_id,)).fetchall()
        return [dict(row) for row in rows]

    def history(self, package_id: str, limit: int = 60) -> list[dict]:
        self.get_package(package_id)
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM messages WHERE package_id=? ORDER BY created_at DESC LIMIT ?",
                (package_id, limit),
            ).fetchall()
        return [dict(row) | {"result": json.loads(row["result"])} for row in reversed(rows)]

    def save_message(self, package_id: str, question: str, result: dict) -> dict:
        record = dict(
            id=new_id(), package_id=package_id, question=question,
            result=json.dumps(result, ensure_ascii=False), created_at=now(),
        )
        with self.connect() as db:
            db.execute(
                "INSERT INTO messages VALUES (:id,:package_id,:question,:result,:created_at)", record
            )
        return record | {"result": result}
