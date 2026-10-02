import json

import httpx
import pytest

from tenderlens.answering import AnswerError, generate, normalized, validate_answer


@pytest.fixture
def evidence():
    return [{
        "source_id": "E1",
        "text": "Clause 3. The Earnest Money Deposit is INR 50,000. No exemption is specified.",
    }]


def response_text(citations=None, status="answered"):
    return json.dumps({
        "status": status, "answer": "The EMD is INR 50,000.",
        "citations": citations if citations is not None else [{
            "source_id": "E1", "quote": "The Earnest Money Deposit is INR 50,000."
        }],
        "missing": [],
    })


def test_exact_quote_validation(evidence):
    result = validate_answer(response_text(), evidence)
    assert result["status"] == "answered"


@pytest.mark.parametrize("text", [
    "Not JSON",
    response_text([]),
    response_text([{"source_id": "E99", "quote": "The Earnest Money Deposit is INR 50,000."}]),
    response_text([{"source_id": "E1", "quote": "All MSMEs are exempt from EMD."}]),
])
def test_bad_answers_rejected(evidence, text):
    with pytest.raises(AnswerError):
        validate_answer(text, evidence)


def test_insufficient_can_abstain_without_citation(evidence):
    result = validate_answer(json.dumps({
        "status": "insufficient", "answer": "GST rate is not established by these passages.",
        "citations": [], "missing": ["Applicable GST clause"],
    }), evidence)
    assert result["status"] == "insufficient"


def test_normalization_preserves_amount_differences():
    assert normalized("INR 50,000") != normalized("INR 5,000")


def test_google_payload_consent_content_and_key_not_in_url(settings, evidence, monkeypatch):
    from tenderlens.config import Settings
    settings = Settings(_env_file=None, TENDERLENS_DATA_DIR=settings.data_dir, gemini_api_key="test-key-not-real")
    requests = []
    original = httpx.Client

    def handle(request):
        requests.append(request)
        assert "test-key-not-real" not in str(request.url)
        assert request.headers["x-goog-api-key"] == "test-key-not-real"
        data = json.loads(request.content)
        assert data["generationConfig"]["thinkingConfig"]["thinkingLevel"] == "minimal"
        assert "tools" not in data
        assert data["contents"][0]["parts"][1]["text"] == "Original page image for E1:"
        return httpx.Response(200, json={
            "candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": response_text()}]}}]
        })

    monkeypatch.setattr(
        "tenderlens.answering.httpx.Client",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    result = generate(settings, "gemma", "Only synthetic evidence", [("E1", b"fake-png")], evidence)
    assert result["status"] == "answered"
    assert len(requests) == 1


def test_remote_ollama_blocked(settings, evidence):
    settings.ollama_base_url = "https://example.invalid"
    with pytest.raises(AnswerError, match="loopback"):
        generate(settings, "ollama", "test", [], evidence)
