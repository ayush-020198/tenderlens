import io

import pytest
from PIL import Image

from tenderlens.demo import make_pdf


def upload(client, package, text, name="notice.txt", **fields):
    return client.post(
        f"/api/packages/{package['id']}/documents",
        files={"file": (name, text.encode() if isinstance(text, str) else text)},
        data=fields,
    )


def test_health_and_config_do_not_expose_key(client, settings):
    assert client.get("/api/health").json()["country"] == "IN"
    config = client.get("/api/config").json()
    assert config["google_configured"] is False
    assert "gemini_api_key" not in config


def test_cross_site_writes_rejected(client):
    response = client.post(
        "/api/packages", json={"name": "Bad origin"},
        headers={"Origin": "https://untrusted.example"},
    )
    assert response.status_code == 403


def test_missing_app_header_rejected(app):
    from fastapi.testclient import TestClient
    with TestClient(app) as other:
        assert other.post("/api/packages", json={"name": "No header"}).status_code == 403


def test_bad_host_rejected(client):
    assert client.get("/api/packages", headers={"Host": "rebind.example"}).status_code == 400


def test_empty_package_name_rejected(client):
    assert client.post("/api/packages", json={"name": "    "}).status_code == 422


def test_upload_and_evidence_roundtrip(client, package):
    response = upload(
        client, package,
        "Tender clause 3. Earnest Money Deposit (EMD): INR 50,000. "
        "GST must be quoted separately. Bid validity is 90 days.",
    )
    assert response.status_code == 201, response.text
    doc = response.json()
    assert doc["page_count"] == 1
    ask = client.post(
        f"/api/packages/{package['id']}/ask",
        json={"question": "What is the EMD amount?", "provider": "evidence"},
    )
    assert ask.status_code == 200, ask.text
    result = ask.json()["result"]
    assert result["answer_kind"] == "evidence_only"
    assert "50,000" in result["sources"][0]["text"]
    assert result["provider"] == "evidence"
    assert len(client.get(f"/api/packages/{package['id']}").json()["messages"]) == 1


def test_package_isolation(client, package):
    first = upload(client, package, "Confidential reference alpha. EMD is INR 77777.")
    second = client.post("/api/packages", json={"name": "Separate package"}).json()
    ask = client.post(
        f"/api/packages/{second['id']}/ask", json={"question": "What is the EMD?"}
    )
    assert ask.json()["result"]["sources"] == []
    assert client.get(
        f"/api/packages/{second['id']}/documents/{first.json()['id']}/pages"
    ).status_code == 404


def test_duplicate_and_invalid_uploads_are_visible(client, package):
    content = "Original tender text with earnest money deposit INR 12345."
    assert upload(client, package, content).status_code == 201
    assert upload(client, package, content).status_code == 422
    assert upload(client, package, b"not a pdf", "notice.pdf").status_code == 422
    assert upload(client, package, "not executable", "notice.exe").status_code == 422
    assert upload(client, package, b"\xff\xfe\x00bad", "bad.txt").status_code == 422
    assert len(client.get(f"/api/packages/{package['id']}").json()["documents"]) == 1


def test_upload_limit(client, package, settings):
    settings.max_upload_mb = 1
    assert upload(client, package, b"x" * (1024 * 1024 + 1)).status_code == 413
    assert client.get(f"/api/packages/{package['id']}").json()["documents"] == []


def test_invalid_date_and_cross_package_amendments(client, package):
    document = upload(client, package, "A sufficiently long original Indian tender notice.").json()
    other = client.post("/api/packages", json={"name": "Another package"}).json()
    assert upload(client, other, "A sufficiently long amendment document.", issued_on="bad").status_code == 422
    response = upload(
        client, other, "Amendment extends the deadline to 27 October 2026.",
        kind="corrigendum", amends_document_id=document["id"],
    )
    assert response.status_code == 404


def test_gemma_needs_consent_then_key(client, package):
    upload(client, package, "The earnest money deposit is INR 50000 for this tender.")
    endpoint = f"/api/packages/{package['id']}/ask"
    assert client.post(endpoint, json={"question": "What is the EMD?", "provider": "gemma"}).status_code == 403
    response = client.post(endpoint, json={
        "question": "What is the EMD?", "provider": "gemma", "consent_external": True,
    })
    assert response.status_code == 503
    assert client.get(f"/api/packages/{package['id']}").json()["messages"] == []


def test_blank_images_require_local_ocr(client, package):
    output = io.BytesIO()
    Image.new("RGB", (200, 100), "white").save(output, format="PNG")
    response = upload(client, package, output.getvalue(), "scan.png")
    assert response.status_code == 422
    assert "OCR" in response.json()["detail"]


def test_pdf_pages_and_preview(client, package):
    data = make_pdf([{
        "title": "Test Indian tender",
        "text": "Earnest Money Deposit (EMD): INR 50,000.\nSubmission deadline: 27 October 2026 at 15:00 IST.",
    }])
    response = upload(client, package, data, "test.pdf")
    assert response.status_code == 201, response.text
    document = response.json()
    prefix = f"/api/packages/{package['id']}/documents/{document['id']}"
    pages = client.get(prefix + "/pages").json()
    assert "50,000" in pages[0]["text"]
    image = client.get(prefix + "/pages/1/image")
    assert image.status_code == 200
    assert image.content.startswith(b"\x89PNG")
    assert client.get(prefix + "/pages/0/image").status_code == 422
    assert client.get(prefix + "/pages/100/image").status_code == 422
    assert client.get(prefix + "/file").headers["content-disposition"].startswith("attachment")


def test_synthetic_package_and_linked_amendment(client):
    first = client.post("/api/demo")
    assert first.status_code == 201, first.text
    package_id = first.json()["id"]
    assert client.post("/api/demo").json()["id"] == package_id
    detail = client.get(f"/api/packages/{package_id}").json()
    assert len(detail["documents"]) == 3
    amended = next(doc for doc in detail["documents"] if doc["kind"] == "corrigendum")
    assert amended["amends_document_id"] in [doc["id"] for doc in detail["documents"]]
    result = client.post(f"/api/packages/{package_id}/ask", json={
        "question": "What is the current submission deadline? Check the corrigendum.",
    }).json()["result"]
    assert any(source["kind"] == "corrigendum" for source in result["sources"])
    assert any("27 October 2026" in source["text"] for source in result["sources"])


@pytest.mark.parametrize("question", ["  ", "x", "z" * 1601])
def test_question_validation(client, package, question):
    assert client.post(
        f"/api/packages/{package['id']}/ask", json={"question": question}
    ).status_code == 422
