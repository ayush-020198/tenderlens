from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DocumentKind = Literal["tender", "corrigendum", "annexure", "boq", "form"]
Provider = Literal["evidence", "gemma", "ollama"]


class PackageCreate(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    reference: str = Field(default="", max_length=100)


class AskRequest(BaseModel):
    question: str = Field(min_length=3, max_length=1600)
    provider: Provider = "evidence"
    consent_external: bool = False
    include_images: bool = False


class SourceQuote(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str
    quote: str = Field(min_length=8, max_length=1400)


class ModelAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["answered", "insufficient", "conflicting"]
    answer: str = Field(min_length=1, max_length=4500)
    citations: list[SourceQuote] = Field(default_factory=list, max_length=8)
    missing: list[str] = Field(default_factory=list, max_length=5)
