from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    gemini_api_key: SecretStr = SecretStr("")
    gemma_model: str = "gemma-4-26b-a4b-it"
    data_dir: Path = Field(default=Path("data"), validation_alias="TENDERLENS_DATA_DIR")
    retrieval_mode: str = "bm25"
    embedding_model: str = "intfloat/multilingual-e5-small"
    rerank_enabled: bool = False
    rerank_model: str = "Xenova/ms-marco-MiniLM-L-6-v2"
    ocr_enabled: bool = False
    ocr_languages: str = "eng"
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen3.5:4b"
    allowed_hosts: list[str] = ["127.0.0.1", "localhost", "testserver"]
    max_upload_mb: int = 15
    max_pages: int = 80
    max_documents: int = 20
    max_question_chars: int = 1600
    frontend_dist: Path = Path("frontend/dist")

    @property
    def google_configured(self) -> bool:
        return bool(self.gemini_api_key.get_secret_value().strip())
