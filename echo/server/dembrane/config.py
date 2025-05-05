# This configuration file implements a robust environment-based configuration
# system with built-in logging. It follows a "fail-fast" pattern by asserting
# required environment variables and provides sensible defaults for optional ones.

import os
import logging

import dotenv

logging.basicConfig(level=logging.INFO, force=True)

logger = logging.getLogger("config")

BASE_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
dotenv_path = os.path.join(BASE_DIR, ".env")

if os.path.exists(dotenv_path):
    logger.info(f"loading environment variables from {dotenv_path}")
    dotenv.load_dotenv(dotenv_path, verbose=True, override=True)

DEBUG_MODE = os.environ.get("DEBUG_MODE", "false").lower() in ["true", "1"]
logger.info(f"DEBUG_MODE: {DEBUG_MODE}")
if DEBUG_MODE:
    # everything is debug if debug mode is enabled
    logging.getLogger().setLevel(logging.DEBUG)
    # set the current logger to debug
    logger.setLevel(logging.DEBUG)

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8000")
logger.debug(f"API_BASE_URL: {API_BASE_URL}")

ADMIN_BASE_URL = os.environ.get("ADMIN_BASE_URL", "http://localhost:3000")
logger.debug(f"ADMIN_BASE_URL: {ADMIN_BASE_URL}")

PARTICIPANT_BASE_URL = os.environ.get("PARTICIPANT_BASE_URL", "http://localhost:3001")
logger.debug(f"PARTICIPANT_BASE_URL: {PARTICIPANT_BASE_URL}")

DIRECTUS_BASE_URL = os.environ.get("DIRECTUS_BASE_URL", "http://directus:8055")
logger.debug(f"DIRECTUS_BASE_URL: {DIRECTUS_BASE_URL}")

DISABLE_REDACTION = os.environ.get("DISABLE_REDACTION", "false").lower() in ["true", "1"]
logger.debug(f"DISABLE_REDACTION: {DISABLE_REDACTION}")

PROMPT_TEMPLATES_DIR = os.path.join(BASE_DIR, "prompt_templates")
logger.debug(f"PROMPT_TEMPLATES_DIR: {PROMPT_TEMPLATES_DIR}")

EMBEDDINGS_CACHE_DIR = os.path.join(BASE_DIR, "embeddings_cache")
logger.debug(f"EMBEDDINGS_CACHE_DIR: {EMBEDDINGS_CACHE_DIR}")

TRANKIT_CACHE_DIR = os.path.join(BASE_DIR, "trankit_cache")
logger.debug(f"TRANKIT_CACHE_DIR: {TRANKIT_CACHE_DIR}")

DIRECTUS_SECRET = os.environ.get("DIRECTUS_SECRET")
assert DIRECTUS_SECRET, "DIRECTUS_SECRET environment variable is not set"
logger.debug("DIRECTUS_SECRET: set")

DIRECTUS_TOKEN = os.environ.get("DIRECTUS_TOKEN")
assert DIRECTUS_TOKEN, "DIRECTUS_TOKEN environment variable is not set"
logger.debug("DIRECTUS_TOKEN: set")

DIRECTUS_SESSION_COOKIE_NAME = os.environ.get(
    "DIRECTUS_SESSION_COOKIE_NAME", "directus_session_token"
)
logger.debug(f"DIRECTUS_SESSION_COOKIE_NAME: {DIRECTUS_SESSION_COOKIE_NAME}")

DATABASE_URL = os.environ.get("DATABASE_URL")
assert DATABASE_URL, "DATABASE_URL environment variable is not set"
logger.debug("DATABASE_URL: set")

if not DATABASE_URL.startswith("postgresql+psycopg://"):
    logger.warning("DATABASE_URL is not a postgresql+psycopg:// URL, attempting to fix it...")
    if DATABASE_URL.startswith("postgresql://"):
        DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://")
    else:
        raise ValueError("DATABASE_URL is not valid (we need a postgresql+psycopg URL)")

REDIS_URL = os.environ.get("REDIS_URL")
assert REDIS_URL, "REDIS_URL environment variable is not set"
logger.debug("REDIS_URL: set")

OPENAI_API_BASE_URL = os.environ.get("OPENAI_API_BASE_URL", "https://api.openai.com/v1")
logger.debug(f"OPENAI_API_BASE_URL: {OPENAI_API_BASE_URL}")

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
assert OPENAI_API_KEY, "OPENAI_API_KEY environment variable is not set"
logger.debug("OPENAI_API_KEY: set")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
assert ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY environment variable is not set"
logger.debug("ANTHROPIC_API_KEY: set")

# GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
# assert GEMINI_API_KEY, "GEMINI_API_KEY environment variable is not set"
# logger.debug(f"GEMINI_API_KEY: {'set' if GEMINI_API_KEY else 'not set'}")

SERVE_API_DOCS = os.environ.get("SERVE_API_DOCS", "false").lower() in ["true", "1"]
logger.debug(f"SERVE_API_DOCS: {SERVE_API_DOCS}")

DISABLE_SENTRY = os.environ.get("DISABLE_SENTRY", "false").lower() in ["true", "1"]
logger.debug(f"DISABLE_SENTRY: {DISABLE_SENTRY}")

BUILD_VERSION = os.environ.get("BUILD_VERSION", "dev")
logger.debug(f"BUILD_VERSION: {BUILD_VERSION}")

ENVIRONMENT = "development"
if BUILD_VERSION != "dev":
    ENVIRONMENT = "production"
logger.debug(f"ENVIRONMENT: {ENVIRONMENT}")

# Neo4j configuration
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
logger.debug(f"NEO4J_URI: {NEO4J_URI}")

NEO4J_USERNAME = os.environ.get("NEO4J_USERNAME", "neo4j")
logger.debug(f"NEO4J_USERNAME: {NEO4J_USERNAME}")

NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "admin@dembrane")
logger.debug("NEO4J_PASSWORD: set")

STORAGE_S3_BUCKET = os.environ.get("STORAGE_S3_BUCKET")
assert STORAGE_S3_BUCKET, "STORAGE_S3_BUCKET environment variable is not set"
logger.debug("STORAGE_S3_BUCKET: set")

STORAGE_S3_REGION = os.environ.get("STORAGE_S3_REGION", None)
logger.debug(f"STORAGE_S3_REGION: {STORAGE_S3_REGION}")
if STORAGE_S3_REGION is None:
    logger.warning("STORAGE_S3_REGION is not set, using 'None'")

STORAGE_S3_ENDPOINT = os.environ.get("STORAGE_S3_ENDPOINT")
assert STORAGE_S3_ENDPOINT, "STORAGE_S3_ENDPOINT environment variable is not set"
logger.debug("STORAGE_S3_ENDPOINT: set")

STORAGE_S3_KEY = os.environ.get("STORAGE_S3_KEY")
assert STORAGE_S3_KEY, "STORAGE_S3_KEY environment variable is not set"
logger.debug("STORAGE_S3_KEY: set")

STORAGE_S3_SECRET = os.environ.get("STORAGE_S3_SECRET")
assert STORAGE_S3_SECRET, "STORAGE_S3_SECRET environment variable is not set"
logger.debug("STORAGE_S3_SECRET: set")

DISABLE_CORS = os.environ.get("DISABLE_CORS", "false").lower() in ["true", "1"]
logger.debug(f"DISABLE_CORS: {DISABLE_CORS}")


LITELLM_WHISPER_URL = os.environ.get("LITELLM_WHISPER_URL")
LITELLM_WHISPER_API_KEY = os.environ.get("LITELLM_WHISPER_API_KEY", OPENAI_API_KEY)
LITELLM_WHISPER_API_VERSION = os.environ.get("LITELLM_WHISPER_API_VERSION", "2024-06-01")
LITELLM_WHISPER_MODEL = os.environ.get("LITELLM_WHISPER_MODEL", "whisper-1")
assert LITELLM_WHISPER_API_KEY, "LITELLM_WHISPER_API_KEY environment variable is not set"
logger.debug("LITELLM_WHISPER_API_KEY: set")
assert LITELLM_WHISPER_API_VERSION, "LITELLM_WHISPER_API_VERSION environment variable is not set"
logger.debug("LITELLM_WHISPER_API_VERSION: set")
assert LITELLM_WHISPER_MODEL, "LITELLM_WHISPER_MODEL environment variable is not set"
logger.debug("LITELLM_WHISPER_MODEL: set")
if LITELLM_WHISPER_MODEL != "whisper-1":
    assert LITELLM_WHISPER_URL, "LITELLM_WHISPER_URL environment variable is not set"
    logger.debug("LITELLM_WHISPER_URL: set")

# *****************LIGHTRAG CONFIGURATIONS*****************

# ---------------Secrets---------------

# Lightrag LLM model: Makes nodes and answers queries
LIGHTRAG_LITELLM_MODEL = os.environ.get("LIGHTRAG_LITELLM_MODEL")  # azure/gpt-4o-mini
assert LIGHTRAG_LITELLM_MODEL, "LIGHTRAG_LITELLM_MODEL environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_MODEL: set")

LIGHTRAG_LITELLM_API_KEY = os.environ.get("LIGHTRAG_LITELLM_API_KEY")
assert LIGHTRAG_LITELLM_API_KEY, "LIGHTRAG_LITELLM_API_KEY environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_API_KEY: set")

LIGHTRAG_LITELLM_API_VERSION = os.environ.get("LIGHTRAG_LITELLM_API_VERSION")
assert LIGHTRAG_LITELLM_API_VERSION, "LIGHTRAG_LITELLM_API_VERSION environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_API_VERSION: set")

LIGHTRAG_LITELLM_API_BASE = os.environ.get("LIGHTRAG_LITELLM_API_BASE")
assert LIGHTRAG_LITELLM_API_BASE, "LIGHTRAG_LITELLM_API_BASE environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_API_BASE: set")


# Lightrag Audio model: Transcribes audio and gets contextual transcript
LIGHTRAG_LITELLM_AUDIOMODEL_MODEL = os.environ.get(
    "LIGHTRAG_LITELLM_AUDIOMODEL_MODEL"
)  # azure/whisper-large-v3
assert (
    LIGHTRAG_LITELLM_AUDIOMODEL_MODEL
), "LIGHTRAG_LITELLM_AUDIOMODEL_MODEL environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_AUDIOMODEL_MODEL: set")

LIGHTRAG_LITELLM_AUDIOMODEL_API_BASE = os.environ.get("LIGHTRAG_LITELLM_AUDIOMODEL_API_BASE")
assert (
    LIGHTRAG_LITELLM_AUDIOMODEL_API_BASE
), "LIGHTRAG_LITELLM_AUDIOMODEL_API_BASE environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_AUDIOMODEL_API_BASE: set")

LIGHTRAG_LITELLM_AUDIOMODEL_API_KEY = os.environ.get("LIGHTRAG_LITELLM_AUDIOMODEL_API_KEY")
assert (
    LIGHTRAG_LITELLM_AUDIOMODEL_API_KEY
), "LIGHTRAG_LITELLM_AUDIOMODEL_API_KEY environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_AUDIOMODEL_API_KEY: set")

LIGHTRAG_LITELLM_AUDIOMODEL_API_VERSION = os.environ.get("LIGHTRAG_LITELLM_AUDIOMODEL_API_VERSION")
assert (
    LIGHTRAG_LITELLM_AUDIOMODEL_API_VERSION
), "LIGHTRAG_LITELLM_AUDIOMODEL_API_VERSION environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_AUDIOMODEL_API_VERSION: set")


# Lightrag Text Structure model: Structures output from audio model
LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL = os.environ.get(
    "LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL"
)  # azure/gpt-4o-mini
assert (
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL
), "LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL: set")

LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE = os.environ.get(
    "LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE"
)
assert (
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE
), "LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE: set")

LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY = os.environ.get(
    "LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY"
)
assert (
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY
), "LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY: set")

LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION = os.environ.get(
    "LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION"
)
assert (
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION
), "LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION: set")

# Lightrag Embedding model: Embeds text
LIGHTRAG_LITELLM_EMBEDDING_MODEL = os.environ.get(
    "LIGHTRAG_LITELLM_EMBEDDING_MODEL"
)  # azure/text-embedding-ada-002
assert (
    LIGHTRAG_LITELLM_EMBEDDING_MODEL
), "LIGHTRAG_LITELLM_EMBEDDING_MODEL environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_EMBEDDING_MODEL: set")

LIGHTRAG_LITELLM_EMBEDDING_API_BASE = os.environ.get("LIGHTRAG_LITELLM_EMBEDDING_API_BASE")
assert (
    LIGHTRAG_LITELLM_EMBEDDING_API_BASE
), "LIGHTRAG_LITELLM_EMBEDDING_API_BASE environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_EMBEDDING_API_BASE: set")

LIGHTRAG_LITELLM_EMBEDDING_API_KEY = os.environ.get("LIGHTRAG_LITELLM_EMBEDDING_API_KEY")
assert (
    LIGHTRAG_LITELLM_EMBEDDING_API_KEY
), "LIGHTRAG_LITELLM_EMBEDDING_API_KEY environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_EMBEDDING_API_KEY: set")

LIGHTRAG_LITELLM_EMBEDDING_API_VERSION = os.environ.get("LIGHTRAG_LITELLM_EMBEDDING_API_VERSION")
assert (
    LIGHTRAG_LITELLM_EMBEDDING_API_VERSION
), "LIGHTRAG_LITELLM_EMBEDDING_API_VERSION environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_EMBEDDING_API_VERSION: set")

LIGHTRAG_LITELLM_INFERENCE_MODEL = os.environ.get(
    "LIGHTRAG_LITELLM_INFERENCE_MODEL", "anthropic/claude-3-5-sonnet-20240620"
)
assert (
    LIGHTRAG_LITELLM_INFERENCE_MODEL
), "LIGHTRAG_LITELLM_INFERENCE_MODEL environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_INFERENCE_MODEL: set")

LIGHTRAG_LITELLM_INFERENCE_API_KEY = os.environ.get("LIGHTRAG_LITELLM_INFERENCE_API_KEY")
assert (
    LIGHTRAG_LITELLM_INFERENCE_API_KEY
), "LIGHTRAG_LITELLM_INFERENCE_API_KEY environment variable is not set"
logger.debug("LIGHTRAG_LITELLM_INFERENCE_API_KEY: set")

LIGHTRAG_LITELLM_INFERENCE_API_VERSION = os.environ.get("LIGHTRAG_LITELLM_INFERENCE_API_VERSION")
if LIGHTRAG_LITELLM_INFERENCE_API_VERSION:
    logger.debug("LIGHTRAG_LITELLM_INFERENCE_API_VERSION: set")
else:
    logger.debug("LIGHTRAG_LITELLM_INFERENCE_API_VERSION: not set")

LIGHTRAG_LITELLM_INFERENCE_API_BASE = os.environ.get("LIGHTRAG_LITELLM_INFERENCE_API_BASE")
if LIGHTRAG_LITELLM_INFERENCE_API_BASE:
    logger.debug("LIGHTRAG_LITELLM_INFERENCE_API_BASE: set")
else:
    logger.debug("LIGHTRAG_LITELLM_INFERENCE_API_BASE: not set")

#---------------/Secrets---------------


# ---------------Configurations---------------
AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM = int(
    os.environ.get("AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM", 10)
)
assert (
    AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM
), "AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM environment variable is not set"
logger.debug("AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM: set")

AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS = int(
    os.environ.get("AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS", 60)
)
assert (
    AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS
), "AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS environment variable is not set"
logger.debug("AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS: set")

ENABLE_AUDIO_LIGHTRAG_INPUT = os.environ.get("ENABLE_AUDIO_LIGHTRAG_INPUT", "false").lower() in [
    "true",
    "1",
]
assert (
    ENABLE_AUDIO_LIGHTRAG_INPUT is not None
), "ENABLE_AUDIO_LIGHTRAG_INPUT environment variable is not set"
logger.debug(f"ENABLE_AUDIO_LIGHTRAG_INPUT: {ENABLE_AUDIO_LIGHTRAG_INPUT}")

AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB = int(
    os.environ.get("AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB", 15)
)
assert (
    AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB
), "AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB environment variable is not set"
logger.debug("AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB: set")

AUDIO_LIGHTRAG_TOP_K_PROMPT = int(os.environ.get("AUDIO_LIGHTRAG_TOP_K_PROMPT", 100))
assert AUDIO_LIGHTRAG_TOP_K_PROMPT, "AUDIO_LIGHTRAG_TOP_K_PROMPT environment variable is not set"
logger.debug("AUDIO_LIGHTRAG_TOP_K_PROMPT: set")

ENABLE_CHAT_AUTO_SELECT = os.environ.get("ENABLE_CHAT_AUTO_SELECT", "false").lower() in [
    "true",
    "1",
]
assert (
    ENABLE_CHAT_AUTO_SELECT is not None
), "ENABLE_CHAT_AUTO_SELECT environment variable is not set"
logger.debug(f"ENABLE_CHAT_AUTO_SELECT: {ENABLE_CHAT_AUTO_SELECT}")

# Redis lock configuration
AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX = os.environ.get("AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX", "etl_lock_conv_")
assert AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX, "AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX environment variable is not set"
logger.debug("AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX: set")

AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY = int(os.environ.get("AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY", 3600))
assert AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY, "AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY environment variable is not set"
logger.debug("AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY: set")

# ---------------/Configurations---------------

# *****************/LIGHTRAG CONFIGURATIONS*****************


# hide some noisy loggers
for hide_logger in [
    "boto3",
    "botocore",
    "httpx",
    "httpcore",
    "LiteLLM",
    "openai",
    "requests",
    "psycopg",
    "s3transfer",
    "urllib3",
    "multipart",
]:
    logging.getLogger(hide_logger).setLevel(logging.WARNING)
