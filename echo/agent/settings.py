from functools import lru_cache
import json
from typing import Any, Optional

from pydantic import Field
from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    echo_api_url: str = Field(default="http://localhost:8000/api", alias="ECHO_API_URL")
    llm_model: str = Field(default="claude-opus-4-6", alias="LLM_MODEL")
    vertex_project: str = Field(default="", alias="VERTEX_PROJECT")
    vertex_location: str = Field(default="europe-west1", alias="VERTEX_LOCATION")
    vertex_credentials: Optional[dict[str, Any]] = Field(
        default=None,
        alias="VERTEX_CREDENTIALS",
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

    class Config:
        env_file = ".env"
        extra = "ignore"

    @field_validator("vertex_credentials", "gcp_sa_json", mode="before")
    @classmethod
    def parse_json_blob(cls, value: Optional[Any]) -> Optional[dict[str, Any]]:
        if value in (None, "", b""):
            return None
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        raise ValueError("Expected a JSON object")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
