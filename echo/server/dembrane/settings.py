"""
Centralized application settings grouped into cohesive sections.

Each section is responsible for loading its own environment variables via
``pydantic-settings``. The top-level ``AppSettings`` simply aggregates these
sections and exposes a friendly, typed surface area for the rest of the app.
# NOTE: Each field keeps aliases for both legacy flat env vars and the new
# namespaced form so existing deployments keep working. Update AGENTS.md if new
# patterns emerge.
# TODO(settings): drop the legacy env aliases once infra uses the namespaced
# variables everywhere.
"""

from __future__ import annotations

import json
import base64
import logging
from typing import Any, Dict, Literal, Optional
from pathlib import Path
from functools import lru_cache

from dotenv import load_dotenv
from pydantic import Field, BaseModel, AliasChoices, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

TranscriptionProvider = Literal["LiteLLM", "AssemblyAI", "Dembrane-25-09"]

_MODULE_BASE_DIR = Path(__file__).resolve().parent.parent
_DEFAULT_ENV_PATH = _MODULE_BASE_DIR / ".env"

if _DEFAULT_ENV_PATH.exists():
    logging.info(f"Loading environment variables from {_DEFAULT_ENV_PATH}")
    load_dotenv(_DEFAULT_ENV_PATH, override=True)
else:
    logging.info(f"Environment variables file not found at {_DEFAULT_ENV_PATH}. Skipping.")


def _coerce_service_account(value: Optional[Any]) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
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
        raise ValueError(
            "Service account JSON must be a mapping, JSON string, or base64-encoded JSON"
        )

    try:
        return json.loads(raw_value)
    except (TypeError, json.JSONDecodeError):
        try:
            decoded = base64.b64decode(raw_value)
            return json.loads(decoded)
        except (ValueError, json.JSONDecodeError, TypeError) as exc:
            raise ValueError(
                "Service account JSON must be valid JSON or base64-encoded JSON"
            ) from exc


class ResolvedLLMConfig(BaseModel):
    model: str
    api_key: Optional[str] = None
    api_base: Optional[str] = None
    api_version: Optional[str] = None
    vertex_credentials: Optional[Dict[str, Any]] = None
    vertex_project: Optional[str] = None
    vertex_location: Optional[str] = None


class LLMProviderConfig(BaseModel):
    model: Optional[str] = None
    api_key: Optional[str] = None
    api_base: Optional[str] = None
    api_version: Optional[str] = None
    vertex_credentials: Optional[Dict[str, Any]] = None
    gcp_sa_json: Optional[Dict[str, Any]] = None
    vertex_project: Optional[str] = None
    vertex_location: Optional[str] = None

    @field_validator("vertex_credentials", mode="before")
    @classmethod
    def parse_vertex_credentials(
        cls, value: Optional[Any]
    ) -> Optional[Dict[str, Any]]:
        return _coerce_service_account(value)

    @field_validator("gcp_sa_json", mode="before")
    @classmethod
    def parse_gcp_sa_json(cls, value: Optional[Any]) -> Optional[Dict[str, Any]]:
        return _coerce_service_account(value)

    def resolve(self) -> ResolvedLLMConfig:
        if not self.model:
            raise ValueError("LLM provider configuration requires a model.")

        return ResolvedLLMConfig(
            model=self.model,
            api_key=self.api_key,
            api_base=self.api_base,
            api_version=self.api_version,
            vertex_credentials=self.vertex_credentials or self.gcp_sa_json,
            vertex_project=self.vertex_project,
            vertex_location=self.vertex_location,
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


class BuildSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    build_version: str = Field(
        default="dev",
        alias="BUILD_VERSION",
        validation_alias=AliasChoices("BUILD_VERSION", "BUILD__VERSION"),
    )


class URLSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    api_base_url: str = Field(
        default="http://localhost:8000",
        alias="API_BASE_URL",
        validation_alias=AliasChoices("API_BASE_URL", "URLS__API_BASE_URL"),
    )
    admin_base_url: str = Field(
        default="http://localhost:3000",
        alias="ADMIN_BASE_URL",
        validation_alias=AliasChoices("ADMIN_BASE_URL", "URLS__ADMIN_BASE_URL"),
    )
    participant_base_url: str = Field(
        default="http://localhost:3001",
        alias="PARTICIPANT_BASE_URL",
        validation_alias=AliasChoices("PARTICIPANT_BASE_URL", "URLS__PARTICIPANT_BASE_URL"),
    )


class FeatureFlagSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    debug_mode: bool = Field(
        default=False,
        alias="DEBUG_MODE",
        validation_alias=AliasChoices("DEBUG_MODE", "FEATURE_FLAGS__DEBUG_MODE"),
    )
    disable_cors: bool = Field(
        default=False,
        alias="DISABLE_CORS",
        validation_alias=AliasChoices("DISABLE_CORS", "FEATURE_FLAGS__DISABLE_CORS"),
    )
    disable_redaction: bool = Field(
        default=False,
        alias="DISABLE_REDACTION",
        validation_alias=AliasChoices("DISABLE_REDACTION", "FEATURE_FLAGS__DISABLE_REDACTION"),
    )
    disable_chat_title_generation: bool = Field(
        default=False,
        alias="DISABLE_CHAT_TITLE_GENERATION",
        validation_alias=AliasChoices(
            "DISABLE_CHAT_TITLE_GENERATION", "FEATURE_FLAGS__DISABLE_CHAT_TITLE_GENERATION"
        ),
    )
    enable_chat_auto_select: bool = Field(
        default=False,
        alias="ENABLE_CHAT_AUTO_SELECT",
        validation_alias=AliasChoices(
            "ENABLE_CHAT_AUTO_SELECT", "FEATURE_FLAGS__ENABLE_CHAT_AUTO_SELECT"
        ),
    )
    serve_api_docs: bool = Field(
        default=False,
        alias="SERVE_API_DOCS",
        validation_alias=AliasChoices("SERVE_API_DOCS", "FEATURE_FLAGS__SERVE_API_DOCS"),
    )
    disable_sentry: bool = Field(
        default=False,
        alias="DISABLE_SENTRY",
        validation_alias=AliasChoices("DISABLE_SENTRY", "FEATURE_FLAGS__DISABLE_SENTRY"),
    )
    webhooks_enabled: bool = Field(
        default=False,
        alias="WEBHOOKS_ENABLED",
        validation_alias=AliasChoices("WEBHOOKS_ENABLED", "FEATURE_FLAGS__WEBHOOKS_ENABLED"),
    )


class DirectusSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    base_url: str = Field(
        default="http://directus:8055",
        alias="DIRECTUS_BASE_URL",
        validation_alias=AliasChoices("DIRECTUS_BASE_URL", "DIRECTUS__BASE_URL"),
    )
    secret: str = Field(
        ...,
        alias="DIRECTUS_SECRET",
        validation_alias=AliasChoices("DIRECTUS_SECRET", "DIRECTUS__SECRET"),
    )
    token: str = Field(
        ...,
        alias="DIRECTUS_TOKEN",
        validation_alias=AliasChoices("DIRECTUS_TOKEN", "DIRECTUS__TOKEN"),
    )
    session_cookie_name: str = Field(
        default="directus_session_token",
        alias="DIRECTUS_SESSION_COOKIE_NAME",
        validation_alias=AliasChoices(
            "DIRECTUS_SESSION_COOKIE_NAME", "DIRECTUS__SESSION_COOKIE_NAME"
        ),
    )


class DatabaseSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    database_url: str = Field(
        ...,
        alias="DATABASE_URL",
        validation_alias=AliasChoices("DATABASE_URL", "DATABASE__URL"),
    )

    @field_validator("database_url")
    @classmethod
    def normalize_database_url(cls, value: str) -> str:
        if value.startswith("postgresql+psycopg://"):
            return value
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        raise ValueError("DATABASE_URL must start with postgresql+psycopg://")


class CacheSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    redis_url: str = Field(
        ...,
        alias="REDIS_URL",
        validation_alias=AliasChoices("REDIS_URL", "CACHE__REDIS_URL"),
    )


class StorageSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    bucket: str = Field(
        ...,
        alias="STORAGE_S3_BUCKET",
        validation_alias=AliasChoices("STORAGE_S3_BUCKET", "STORAGE__BUCKET"),
    )
    region: Optional[str] = Field(
        default=None,
        alias="STORAGE_S3_REGION",
        validation_alias=AliasChoices("STORAGE_S3_REGION", "STORAGE__REGION"),
    )
    endpoint: str = Field(
        ...,
        alias="STORAGE_S3_ENDPOINT",
        validation_alias=AliasChoices("STORAGE_S3_ENDPOINT", "STORAGE__ENDPOINT"),
    )
    key: str = Field(
        ...,
        alias="STORAGE_S3_KEY",
        validation_alias=AliasChoices("STORAGE_S3_KEY", "STORAGE__KEY"),
    )
    secret: str = Field(
        ...,
        alias="STORAGE_S3_SECRET",
        validation_alias=AliasChoices("STORAGE_S3_SECRET", "STORAGE__SECRET"),
    )


class EmbeddingSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    model: str = Field(
        default="text-embedding-3-small",
        alias="EMBEDDING_MODEL",
        validation_alias=AliasChoices("EMBEDDING_MODEL", "EMBEDDING__MODEL"),
    )
    api_key: Optional[str] = Field(
        default=None,
        alias="EMBEDDING_API_KEY",
        validation_alias=AliasChoices("EMBEDDING_API_KEY", "EMBEDDING__API_KEY"),
    )
    base_url: Optional[str] = Field(
        default=None,
        alias="EMBEDDING_BASE_URL",
        validation_alias=AliasChoices(
            "EMBEDDING_BASE_URL",
            "EMBEDDING_API_BASE",
            "EMBEDDING__BASE_URL",
        ),
    )
    api_version: Optional[str] = Field(
        default=None,
        alias="EMBEDDING_API_VERSION",
        validation_alias=AliasChoices("EMBEDDING_API_VERSION", "EMBEDDING__API_VERSION"),
    )


class TranscriptionSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    provider: Optional[TranscriptionProvider] = Field(
        default=None,
        alias="TRANSCRIPTION_PROVIDER",
        validation_alias=AliasChoices("TRANSCRIPTION_PROVIDER", "TRANSCRIPTION__PROVIDER"),
    )
    gcp_sa_json: Optional[Dict[str, Any]] = Field(
        default=None,
        alias="GCP_SA_JSON",
        validation_alias=AliasChoices("GCP_SA_JSON", "TRANSCRIPTION__GCP_SA_JSON"),
    )
    assemblyai_api_key: Optional[str] = Field(
        default=None,
        alias="ASSEMBLYAI_API_KEY",
        validation_alias=AliasChoices("ASSEMBLYAI_API_KEY", "TRANSCRIPTION__ASSEMBLYAI__API_KEY"),
    )
    assemblyai_base_url: str = Field(
        default="https://api.eu.assemblyai.com",
        alias="ASSEMBLYAI_BASE_URL",
        validation_alias=AliasChoices("ASSEMBLYAI_BASE_URL", "TRANSCRIPTION__ASSEMBLYAI__BASE_URL"),
    )
    litellm_model: Optional[str] = Field(
        default=None,
        alias="LITELLM_TRANSCRIPTION_MODEL",
        validation_alias=AliasChoices(
            "LITELLM_TRANSCRIPTION_MODEL", "TRANSCRIPTION__LITELLM__MODEL"
        ),
    )
    litellm_api_key: Optional[str] = Field(
        default=None,
        alias="LITELLM_TRANSCRIPTION_API_KEY",
        validation_alias=AliasChoices(
            "LITELLM_TRANSCRIPTION_API_KEY", "TRANSCRIPTION__LITELLM__API_KEY"
        ),
    )
    litellm_api_base: Optional[str] = Field(
        default=None,
        alias="LITELLM_TRANSCRIPTION_API_BASE",
        validation_alias=AliasChoices(
            "LITELLM_TRANSCRIPTION_API_BASE", "TRANSCRIPTION__LITELLM__API_BASE"
        ),
    )
    litellm_api_version: Optional[str] = Field(
        default=None,
        alias="LITELLM_TRANSCRIPTION_API_VERSION",
        validation_alias=AliasChoices(
            "LITELLM_TRANSCRIPTION_API_VERSION", "TRANSCRIPTION__LITELLM__API_VERSION"
        ),
    )

    @field_validator("gcp_sa_json", mode="before")
    @classmethod
    def parse_gcp_sa_json(cls, value: Optional[Any]) -> Optional[Dict[str, Any]]:
        return _coerce_service_account(value)

    def ensure_valid(self) -> None:
        if self.provider == "AssemblyAI":
            if not self.assemblyai_api_key:
                raise ValueError(
                    "ASSEMBLYAI_API_KEY must be set when TRANSCRIPTION_PROVIDER=AssemblyAI"
                )
        elif self.provider == "LiteLLM":
            missing = [
                name
                for name, value in [
                    ("LITELLM_TRANSCRIPTION_MODEL", self.litellm_model),
                    ("LITELLM_TRANSCRIPTION_API_KEY", self.litellm_api_key),
                ]
                if value in (None, "")
            ]
            if missing:
                raise ValueError(
                    "Missing required LiteLLM transcription configuration: " + ", ".join(missing)
                )
        elif self.provider == "Dembrane-25-09":
            if self.gcp_sa_json is None:
                raise ValueError(
                    "GCP_SA_JSON must be provided when TRANSCRIPTION_PROVIDER=Dembrane-25-09"
                )


class AppSettings:
    """
    Aggregate application settings composed from modular sections.
    """

    def __init__(self) -> None:
        self.base_dir: Path = Path(__file__).resolve().parent.parent

        self.build = BuildSettings()
        self.urls = URLSettings()
        self.feature_flags = FeatureFlagSettings()
        self.directus = DirectusSettings()
        self.database = DatabaseSettings()
        self.cache = CacheSettings()
        self.storage = StorageSettings()
        self.transcription = TranscriptionSettings()
        self.llms = LLMSettings()
        self.embedding = EmbeddingSettings()

        self.transcription.ensure_valid()

    @property
    def environment(self) -> str:
        return "production" if self.build.build_version != "dev" else "development"

    @property
    def prompt_templates_dir(self) -> Path:
        return self.base_dir / "prompt_templates"


@lru_cache
def get_settings() -> AppSettings:
    settings = AppSettings()

    if settings.feature_flags.debug_mode:
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
