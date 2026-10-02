import pytest
from fastapi.testclient import TestClient

from tenderlens.api import create_app
from tenderlens.config import Settings


@pytest.fixture
def settings(tmp_path):
    return Settings(_env_file=None, TENDERLENS_DATA_DIR=tmp_path, gemini_api_key="")


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app, headers={"X-TenderLens-Client": "browser"}) as test_client:
        yield test_client


@pytest.fixture
def package(client):
    response = client.post("/api/packages", json={"name": "India test package"})
    assert response.status_code == 201
    return response.json()
