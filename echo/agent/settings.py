import base64
import json
from functools import lru_cache
from typing import Any, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    echo_api_url: str = Field(default="http://localhost:8000/api", alias="ECHO_API_URL")
    # Vertex model id (no provider prefix).
    llm_model: str = Field(default="gemini-3.5-flash", alias="LLM_MODEL")
    # Comma-separated model ids tried in order when the primary errors or is
    # rate limited (e.g. "gemini-3.7-flash,gemini-3.5-flash"). Empty means none.
    llm_fallback_models: str = Field(default="", alias="LLM_FALLBACK_MODELS")
    vertex_location: str = Field(default="eu", alias="VERTEX_LOCATION")
    # The EU multi-region host keeps processing in the EU. The global host
    # (aiplatform.googleapis.com) does not, even with locations/eu in the path.
    vertex_api_endpoint: str = Field(
        default="aiplatform.eu.rep.googleapis.com", alias="VERTEX_API_ENDPOINT"
    )
    vertex_project: str = Field(default="", alias="VERTEX_PROJECT")
    # Service-account JSON blob. VERTEX_CREDENTIALS wins over GCP_SA_JSON;
    # with neither set, Application Default Credentials apply.
    vertex_credentials: Optional[dict[str, Any]] = Field(
        default=None, alias="VERTEX_CREDENTIALS"
    )
    gcp_sa_json: Optional[dict[str, Any]] = Field(default=None, alias="GCP_SA_JSON")
    agent_graph_recursion_limit: int = Field(
        default=80,
        alias="AGENT_GRAPH_RECURSION_LIMIT",
    )
    agent_cors_origins: str = Field(
        default="http://localhost:5173,http://localhost:5174",
        alias="AGENT_CORS_ORIGINS",
    )

    @property
    def llm_fallback_model_list(self) -> list[str]:
        return [m.strip() for m in self.llm_fallback_models.split(",") if m.strip()]

    @field_validator("vertex_credentials", "gcp_sa_json", mode="before")
    @classmethod
    def _parse_service_account_json(cls, value: Any) -> Optional[dict[str, Any]]:
        # Accept a dict, a raw JSON string, or a base64-encoded JSON string.
        # The prod/echo-next secret stores GCP_SA_JSON base64-encoded, matching
        # the server's _coerce_service_account behavior.
        if value is None or isinstance(value, dict):
            return value
        if isinstance(value, str):
            stripped = value.strip()
            if stripped in {"", "null", "None"}:
                return None
            try:
                return json.loads(stripped)
            except json.JSONDecodeError:
                try:
                    return json.loads(base64.b64decode(stripped))
                except Exception as exc:
                    raise ValueError(
                        "Service account JSON must be valid JSON or base64-encoded JSON"
                    ) from exc
        raise ValueError("Expected a JSON object or JSON string")

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
