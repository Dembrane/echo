from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    echo_api_url: str = Field(default="http://localhost:8000/api", alias="ECHO_API_URL")
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    llm_model: str = Field(default="gemini-3-pro-preview", alias="LLM_MODEL")
    agent_cors_origins: str = Field(
        default="http://localhost:5173,http://localhost:5174",
        alias="AGENT_CORS_ORIGINS",
    )

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
