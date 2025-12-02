"""Settings configuration for the usage tracker."""

from typing import Optional
from pathlib import Path
from functools import lru_cache

from dotenv import load_dotenv
from pydantic import Field, AliasChoices
from pydantic_settings import BaseSettings, SettingsConfigDict


# Load .env from the tool's root directory
_TOOL_DIR = Path(__file__).resolve().parent.parent.parent
_ENV_PATH = _TOOL_DIR / ".env"

if _ENV_PATH.exists():
    load_dotenv(_ENV_PATH, override=True)


class DirectusSettings(BaseSettings):
    """Directus connection settings."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    base_url: str = Field(
        ...,
        validation_alias=AliasChoices("DIRECTUS_BASE_URL", "DIRECTUS__BASE_URL"),
    )
    token: str = Field(
        ...,
        validation_alias=AliasChoices("DIRECTUS_TOKEN", "DIRECTUS__TOKEN"),
    )


class LLMSettings(BaseSettings):
    """LLM configuration for generating insights."""

    model_config = SettingsConfigDict(
        env_prefix="LLM__TEXT_FAST__",
        env_file=".env",
        extra="ignore",
        case_sensitive=False,
    )

    model: Optional[str] = Field(default=None, validation_alias=AliasChoices("LLM__TEXT_FAST__MODEL", "MODEL"))
    api_key: Optional[str] = Field(default=None, validation_alias=AliasChoices("LLM__TEXT_FAST__API_KEY", "API_KEY"))
    api_base: Optional[str] = Field(default=None, validation_alias=AliasChoices("LLM__TEXT_FAST__API_BASE", "API_BASE"))
    api_version: Optional[str] = Field(
        default=None, validation_alias=AliasChoices("LLM__TEXT_FAST__API_VERSION", "API_VERSION")
    )

    @property
    def is_configured(self) -> bool:
        """Check if LLM is configured."""
        return bool(self.model and self.api_key)


class Settings:
    """Aggregated application settings."""

    def __init__(self) -> None:
        self.directus = DirectusSettings()
        self.llm = LLMSettings()


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()

