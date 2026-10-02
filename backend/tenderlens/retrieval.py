import hashlib
import json
import re
from threading import Lock

import numpy as np
from rank_bm25 import BM25Okapi

from .config import Settings

STOP = set("the a an of to is are in for and or what which how does do with this it by be can i".split())
EXPANSIONS = {
    "emd": "earnest money deposit bid security",
    "deadline": "submission closing due date",
    "turnover": "annual financial eligibility revenue",
    "msme": "msme mse exemption exempt udyam",
    "gst": "gst goods services tax inclusive exclusive",
    "boq": "boq bill quantities quantity specification schedule",
    "corrigendum": "corrigendum amendment revised extension",
    "जमानत": "emd earnest money security",
    "अंतिम": "deadline submission closing",
}


def tokens(text: str) -> list[str]:
    return [token for token in re.findall(r"[\w\u0900-\u097f]+", text.casefold()) if token not in STOP]


def expand(question: str) -> str:
    words = tokens(question)
    return question + " " + " ".join(EXPANSIONS.get(word, "") for word in words)


class RetrievalError(RuntimeError):
    pass


class Retriever:
    def __init__(self, settings: Settings):
        if settings.retrieval_mode not in {"bm25", "hybrid"}:
            raise ValueError("RETRIEVAL_MODE must be bm25 or hybrid.")
        self.settings = settings
        self._encoder = None
        self._reranker = None
        self._lock = Lock()
        self.cache = settings.data_dir.resolve() / "embeddings"

    def _models(self):
        try:
            from fastembed import TextEmbedding
            from fastembed.rerank.cross_encoder import TextCrossEncoder
        except ImportError as exc:
            raise RetrievalError("Install local retrieval dependencies: uv sync --extra retrieval") from exc
        if self._encoder is None:
            self._encoder = TextEmbedding(
                model_name=self.settings.embedding_model, threads=4,
                cache_dir=str(self.settings.data_dir.resolve() / "model-cache"),
            )
        if self.settings.rerank_enabled and self._reranker is None:
            self._reranker = TextCrossEncoder(
                model_name=self.settings.rerank_model, threads=4,
                cache_dir=str(self.settings.data_dir.resolve() / "model-cache"),
            )

    def search(self, chunks: list[dict], question: str, limit: int = 6) -> tuple[list[dict], list[str]]:
        if not chunks:
            return [], []
        query = expand(question)
        texts = [chunk["text"] for chunk in chunks]
        documents = [tokens(text) or ["_empty"] for text in texts]
        # Positive IDF prevents common-but-important terms in tiny tender packages
        # from producing a negative score and disappearing from evidence results.
        bm25 = BM25Okapi(documents, epsilon=0.25)
        for term, count in {t: sum(t in d for d in documents) for t in set(tokens(query))}.items():
            bm25.idf[term] = float(np.log(1 + (len(documents) - count + 0.5) / (count + 0.5)))
        lexical = np.asarray(bm25.get_scores(tokens(query)))
        candidates = [int(i) for i in np.argsort(-lexical) if lexical[i] > 0]
        notices = []
        if self.settings.retrieval_mode == "hybrid":
            with self._lock:
                try:
                    self._models()
                    key = hashlib.sha256(json.dumps(
                        [self.settings.embedding_model, texts], ensure_ascii=False
                    ).encode()).hexdigest()
                    self.cache.mkdir(parents=True, exist_ok=True)
                    path = self.cache / f"{key}.npy"
                    if path.exists():
                        matrix = np.load(path, allow_pickle=False)
                    else:
                        matrix = np.asarray(list(self._encoder.passage_embed(texts)))
                        temporary = path.with_suffix(".tmp")
                        with temporary.open("wb") as stream:
                            np.save(stream, matrix, allow_pickle=False)
                        temporary.replace(path)
                    vector = np.asarray(next(iter(self._encoder.query_embed(query))))
                    cosine = matrix @ vector / (
                        np.linalg.norm(matrix, axis=1) * np.linalg.norm(vector) + 1e-10
                    )
                    dense = [int(i) for i in np.argsort(-cosine)[:18]]
                    fused: dict[int, float] = {}
                    for ranking in (candidates[:18], dense):
                        for rank, index in enumerate(ranking):
                            fused[index] = fused.get(index, 0) + 1 / (60 + rank + 1)
                    candidates = sorted(fused, key=fused.get, reverse=True)
                    if self._reranker is not None and not re.search(r"[\u0900-\u097f]", question):
                        shortlist = candidates[:12]
                        scores = list(self._reranker.rerank(query, [texts[i] for i in shortlist]))
                        candidates = [shortlist[i] for i in np.argsort(-np.asarray(scores))]
                    elif self._reranker is not None:
                        notices.append("English reranker skipped for a Hindi query; multilingual retrieval is still used.")
                except RetrievalError:
                    raise
                except Exception as exc:
                    raise RetrievalError(
                        "Local embedding/reranking failed. Check model downloads and configuration; "
                        "the app did not silently switch retrieval methods."
                    ) from exc
        elif self.settings.rerank_enabled:
            raise RetrievalError("RERANK_ENABLED requires RETRIEVAL_MODE=hybrid.")
        chosen = []
        seen_pages = set()
        for index in candidates:
            item = chunks[index]
            key = (item["document_id"], item["page"])
            if key not in seen_pages:
                chosen.append(item)
                seen_pages.add(key)
            if len(chosen) == limit:
                break
        # Include an explicitly linked amendment's first passage even if it uses
        # different vocabulary. This supplies evidence, not automatic precedence.
        chosen_docs = {item["document_id"] for item in chosen}
        for chunk in chunks:
            if (
                chunk["kind"] == "corrigendum" and chunk["amends_document_id"] in chosen_docs
                and chunk["document_id"] not in {item["document_id"] for item in chosen}
                and len(chosen) < limit + 2
            ):
                chosen.append(chunk)
                notices.append("A linked corrigendum was included; its actual scope must be checked.")
        return [
            item | {"source_id": f"E{number}", "score_kind": self.settings.retrieval_mode}
            for number, item in enumerate(chosen, 1)
        ], notices
