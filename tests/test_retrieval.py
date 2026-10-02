from tenderlens.documents import chunk_text
from tenderlens.retrieval import Retriever


def item(identifier, text, kind="tender", parent=None, page=1):
    return {
        "id": identifier, "document_id": identifier, "document_name": f"{identifier}.pdf",
        "text": text, "page": page, "kind": kind, "issued_on": None,
        "amends_document_id": parent, "extraction": "native_text",
    }


def test_tiny_corpus_common_terms_retrieved(settings):
    evidence, _ = Retriever(settings).search([
        item("a", "EMD earnest money deposit INR 50000 for this tender."),
        item("b", "EMD exemption must not be assumed for this tender."),
    ], "What is the EMD?")
    assert evidence
    assert any("50000" in result["text"] for result in evidence)


def test_linked_amendment_kept_without_upload_order_precedence(settings):
    evidence, _ = Retriever(settings).search([
        item("old", "Submission deadline 20 October 2026."),
        item("amend", "Clause 2 now reads 27 October 2026.", "corrigendum", "old"),
    ], "submission deadline")
    assert {result["document_id"] for result in evidence} == {"old", "amend"}


def test_unrelated_query_returns_no_lexical_evidence(settings):
    assert Retriever(settings).search(
        [item("a", "Supply of cables with three year warranty.")], "arbitration jurisdiction"
    )[0] == []


def test_chunks_preserve_last_characters_and_bound_size():
    text = ("Paragraph about Indian tender requirements.\n" * 120) + "FINAL FOOTNOTE"
    chunks = chunk_text(text)
    assert chunks[-1].endswith("FINAL FOOTNOTE")
    assert all(len(chunk) <= 1400 for chunk in chunks)
