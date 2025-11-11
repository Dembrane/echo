"""
Centralized application settings loaded from environment variables.

This module replaces the legacy ``dembrane.config`` globals with a single
typed settings object. Consumers should call ``get_settings()`` and read the
fields they need instead of importing environment variables directly.
"""

from __future__ import annotations

import json
import base64
import logging
from typing import Any, Dict, Literal, Optional, Mapping
from pathlib import Path
from functools import lru_cache

from pydantic import Field, BaseModel, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

TranscriptionProvider = Optional[Literal["LiteLLM", "AssemblyAI", "Dembrane-25-09"]]


class ResolvedLLMConfig(BaseModel):
    model: str
    api_key: Optional[str] = None
    api_base: Optional[str] = None
    api_version: Optional[str] = None


class LLMProviderConfig(BaseModel):
    model: Optional[str] = None
    api_key: Optional[str] = None
    api_base: Optional[str] = None
    api_version: Optional[str] = None

    def resolve(self) -> ResolvedLLMConfig:
        if not self.model:
            raise ValueError("LLM provider configuration requires a model.")

        return ResolvedLLMConfig(
            model=self.model,
            api_key=self.api_key,
            api_base=self.api_base,
            api_version=self.api_version,
        )


class LLMSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LLM__",
        env_nested_delimiter="__",
        env_file=".env",
        extra="ignore",
        case_sensitive=False,
    )

    multi_modal_pro: LLMProviderConfig = Field(default_factory=LLMProviderConfig)
    multi_modal_fast: LLMProviderConfig = Field(default_factory=LLMProviderConfig)
    text_fast: LLMProviderConfig = Field(default_factory=LLMProviderConfig)


class AppSettings(BaseSettings):
    """
    All environment-driven configuration for the Dembrane ECHO server.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    # General application configuration
    base_dir: Path = Field(default_factory=lambda: Path(__file__).resolve().parent.parent)
    build_version: str = Field(default="dev", alias="BUILD_VERSION")
    api_base_url: str = Field(default="http://localhost:8000", alias="API_BASE_URL")
    admin_base_url: str = Field(default="http://localhost:3000", alias="ADMIN_BASE_URL")
    participant_base_url: str = Field(default="http://localhost:3001", alias="PARTICIPANT_BASE_URL")

    # Features
    debug_mode: bool = Field(default=False, alias="DEBUG_MODE")
    disable_cors: bool = Field(default=False, alias="DISABLE_CORS")
    disable_redaction: bool = Field(default=False, alias="DISABLE_REDACTION")
    disable_chat_title_generation: bool = Field(
        default=False, alias="DISABLE_CHAT_TITLE_GENERATION"
    )
    enable_chat_auto_select: bool = Field(default=False, alias="ENABLE_CHAT_AUTO_SELECT")
    serve_api_docs: bool = Field(default=False, alias="SERVE_API_DOCS")
    disable_sentry: bool = Field(default=False, alias="DISABLE_SENTRY")

    # Directus / database / cache / storage
    directus_base_url: str = Field(default="http://directus:8055", alias="DIRECTUS_BASE_URL")
    directus_secret: str = Field(..., alias="DIRECTUS_SECRET")
    directus_token: str = Field(..., alias="DIRECTUS_TOKEN")
    directus_session_cookie_name: str = Field(
        default="directus_session_token", alias="DIRECTUS_SESSION_COOKIE_NAME"
    )

    database_url: str = Field(..., alias="DATABASE_URL")
    redis_url: str = Field(..., alias="REDIS_URL")

    storage_s3_bucket: str = Field(..., alias="STORAGE_S3_BUCKET")
    storage_s3_region: Optional[str] = Field(default=None, alias="STORAGE_S3_REGION")
    storage_s3_endpoint: str = Field(..., alias="STORAGE_S3_ENDPOINT")
    storage_s3_key: str = Field(..., alias="STORAGE_S3_KEY")
    storage_s3_secret: str = Field(..., alias="STORAGE_S3_SECRET")

    # Transcription providers
    transcription_provider: TranscriptionProvider = Field(
        default=None, alias="TRANSCRIPTION_PROVIDER"
    )
    gcp_sa_json: Optional[Dict[str, Any]] = Field(default=None, alias="GCP_SA_JSON")

    enable_assemblyai_transcription: bool = Field(
        default=False, alias="ENABLE_ASSEMBLYAI_TRANSCRIPTION"
    )
    assemblyai_api_key: Optional[str] = Field(default=None, alias="ASSEMBLYAI_API_KEY")
    assemblyai_base_url: str = Field(
        default="https://api.eu.assemblyai.com", alias="ASSEMBLYAI_BASE_URL"
    )

    enable_litellm_whisper_transcription: bool = Field(
        default=False, alias="ENABLE_LITELLM_WHISPER_TRANSCRIPTION"
    )

    llms: LLMSettings = Field(default_factory=LLMSettings)

    @field_validator("database_url", mode="before")
    @classmethod
    def normalize_database_url(cls, value: str) -> str:
        if value.startswith("postgresql+psycopg://"):
            return value
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        raise ValueError("DATABASE_URL must start with postgresql+psycopg://")

    @field_validator("gcp_sa_json", mode="before")
    @classmethod
    def parse_gcp_sa_json(
        cls, value: Optional[Any]
    ) -> Optional[Dict[str, Any]]:
        if value is None:
            return None

        if isinstance(value, Mapping):
            return dict(value)

        if isinstance(value, str):
            trimmed = value.strip()
            if trimmed in {"", "null", "None"}:
                return None
            raw_value: str | bytes = trimmed
        elif isinstance(value, (bytes, bytearray)):
            if not value:
                return None
            raw_value = value
        else:
            raise ValueError("GCP_SA_JSON must be a mapping, JSON string, or base64-encoded JSON")

        try:
            return json.loads(raw_value)
        except (TypeError, json.JSONDecodeError):
            try:
                decoded = base64.b64decode(raw_value)
                return json.loads(decoded)
            except (ValueError, json.JSONDecodeError, TypeError) as exc:
                raise ValueError("GCP_SA_JSON must be valid JSON or base64-encoded JSON") from exc

    @model_validator(mode="after")
    def validate_transcription_dependencies(self) -> "AppSettings":
        if self.enable_assemblyai_transcription and not self.assemblyai_api_key:
            raise ValueError(
                "ASSEMBLYAI_API_KEY must be set when AssemblyAI transcription is enabled"
            )

        if self.enable_litellm_whisper_transcription:
            missing = [
                name
                for name, value in [
                    ("LLM__MULTI_MODAL_FAST__MODEL", self.llms.multi_modal_fast.model),
                    ("LLM__MULTI_MODAL_FAST__API_KEY", self.llms.multi_modal_fast.api_key),
                ]
                if value in (None, "")
            ]
            if missing:
                raise ValueError(
                    "Missing required LiteLLM Whisper configuration when transcription is enabled: "
                    + ", ".join(missing)
                )

        return self

    @property
    def environment(self) -> str:
        return "production" if self.build_version != "dev" else "development"

    @property
    def prompt_templates_dir(self) -> Path:
        return self.base_dir / "prompt_templates"

    @property
    def json_templates_dir(self) -> Path:
        return self.base_dir / "json_templates"


@lru_cache
def get_settings() -> AppSettings:
    settings = AppSettings()

    if settings.debug_mode:
        logging.getLogger().setLevel(logging.DEBUG)

    for noisy in [
        "boto3",
        "botocore",
        "httpx",
        "httpcore",
        "LiteLLM",
        "requests",
        "psycopg",
        "s3transfer",
        "urllib3",
        "multipart",
    ]:
        logging.getLogger(noisy).setLevel(logging.WARNING)

    return settings
