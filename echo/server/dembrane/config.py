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

UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
if not os.path.exists(UPLOADS_DIR):
    os.makedirs(UPLOADS_DIR)
logger.debug(f"UPLOADS_DIR: {UPLOADS_DIR}")

PROMPT_TEMPLATES_DIR = os.path.join(BASE_DIR, "prompt_templates")
logger.debug(f"PROMPT_TEMPLATES_DIR: {PROMPT_TEMPLATES_DIR}")

RESOURCE_UPLOADS_DIR = os.path.join(UPLOADS_DIR, "resources")
if not os.path.exists(RESOURCE_UPLOADS_DIR):
    os.makedirs(RESOURCE_UPLOADS_DIR)
logger.debug(f"RESOURCE_UPLOADS_DIR: {RESOURCE_UPLOADS_DIR}")

AUDIO_CHUNKS_DIR = os.path.join(UPLOADS_DIR, "audio_chunks")
if not os.path.exists(AUDIO_CHUNKS_DIR):
    os.makedirs(AUDIO_CHUNKS_DIR)
logger.debug(f"AUDIO_CHUNKS_DIR: {AUDIO_CHUNKS_DIR}")

IMAGES_DIR = os.path.join(UPLOADS_DIR, "images")
if not os.path.exists(IMAGES_DIR):
    os.makedirs(IMAGES_DIR)
logger.debug(f"IMAGES_DIR: {IMAGES_DIR}")

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

AZURE_OPENAI_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY")
assert AZURE_OPENAI_API_KEY, "AZURE_OPENAI_API_KEY environment variable is not set"
logger.debug("AZURE_OPENAI_API_KEY: set")
AZURE_OPENAI_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION")
assert AZURE_OPENAI_API_VERSION, "AZURE_OPENAI_API_VERSION environment variable is not set"
logger.debug("AZURE_OPENAI_API_VERSION: set")

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



# *****************LIGHTRAG CONFIGURATIONS*****************

#---------------Secrets---------------

# Lightrag LLM model: Makes nodes and answers queries
LITELLM_LIGHTRAG_PROVIDER = os.environ.get("LITELLM_PROVIDER", "azure")
assert LITELLM_LIGHTRAG_PROVIDER, "LITELLM_PROVIDER environment variable is not set"
logger.debug("LITELLM_PROVIDER: set")

LITELLM_LIGHTRAG_APIKEY = os.environ.get("LITELLM_LIGHTRAG_APIKEY")   
assert LITELLM_LIGHTRAG_APIKEY, "LITELLM_LIGHTRAG_APIKEY environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_APIKEY: set")

LITELLM_LIGHTRAG_API_VERSION = os.environ.get("LITELLM_LIGHTRAG_API_VERSION")
assert LITELLM_LIGHTRAG_API_VERSION, "LITELLM_LIGHTRAG_API_VERSION environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_API_VERSION: set")

LITELLM_LIGHTRAG_ENDPOINT = os.environ.get("LITELLM_LIGHTRAG_ENDPOINT")
assert LITELLM_LIGHTRAG_ENDPOINT, "LITELLM_LIGHTRAG_ENDPOINT environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_ENDPOINT: set")

LITELLM_LIGHTRAG_NAME = os.environ.get("LITELLM_LIGHTRAG_NAME")
assert LITELLM_LIGHTRAG_NAME, "LITELLM_LIGHTRAG_NAME environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_NAME: set")

# Lightrag Audio model: Transcribes audio and gets contextual transcript
LITELLM_LIGHTRAG_AUDIOMODEL_PROVIDER = os.environ.get("LITELLM_LIGHTRAG_AUDIOMODEL_PROVIDER", "azure")
assert LITELLM_LIGHTRAG_AUDIOMODEL_PROVIDER, "LITELLM_LIGHTRAG_AUDIOMODEL_PROVIDER environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_AUDIOMODEL_PROVIDER: set")

LITELLM_LIGHTRAG_AUDIOMODEL_ENDPOINT = os.environ.get("LITELLM_LIGHTRAG_AUDIOMODEL_ENDPOINT")
assert LITELLM_LIGHTRAG_AUDIOMODEL_ENDPOINT, "LITELLM_LIGHTRAG_AUDIOMODEL_ENDPOINT environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_AUDIOMODEL_ENDPOINT: set")

LITELLM_LIGHTRAG_AUDIOMODEL_API_KEY = os.environ.get("LITELLM_LIGHTRAG_AUDIOMODEL_API_KEY")
assert LITELLM_LIGHTRAG_AUDIOMODEL_API_KEY, "LITELLM_LIGHTRAG_AUDIOMODEL_API_KEY environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_AUDIOMODEL_API_KEY: set")

LITELLM_LIGHTRAG_AUDIOMODEL_API_VERSION = os.environ.get("LITELLM_LIGHTRAG_AUDIOMODEL_API_VERSION")
assert LITELLM_LIGHTRAG_AUDIOMODEL_API_VERSION, "LITELLM_LIGHTRAG_AUDIOMODEL_API_VERSION environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_AUDIOMODEL_API_VERSION: set")

LITELLM_LIGHTRAG_AUDIOMODEL_NAME = os.environ.get("LITELLM_LIGHTRAG_AUDIOMODEL_NAME")
assert LITELLM_LIGHTRAG_AUDIOMODEL_NAME, "LITELLM_LIGHTRAG_AUDIOMODEL_NAME environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_AUDIOMODEL_NAME: set")

# Lightrag Text Structure model: Structures output from audio model
LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_PROVIDER = os.environ.get("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_PROVIDER", "azure")
assert LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_PROVIDER, "LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_PROVIDER environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_PROVIDER: set")

LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_ENDPOINT = os.environ.get("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_ENDPOINT")
assert LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_ENDPOINT, "LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_ENDPOINT environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_ENDPOINT: set")

LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_NAME = os.environ.get("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_NAME")
assert LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_NAME, "LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_NAME environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_NAME: set")

LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_KEY = os.environ.get("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_KEY")
assert LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_KEY, "LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_KEY environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_KEY: set")

LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_VERSION = os.environ.get("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_VERSION")
assert LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_VERSION, "LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_VERSION environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_VERSION: set")

# Lightrag Embedding model: Embeds text
LITELLM_LIGHTRAG_EMBEDDING_PROVIDER = os.environ.get("LITELLM_LIGHTRAG_EMBEDDING_PROVIDER", "azure")
assert LITELLM_LIGHTRAG_EMBEDDING_PROVIDER, "LITELLM_LIGHTRAG_EMBEDDING_PROVIDER environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_EMBEDDING_PROVIDER: set")

LITELLM_LIGHTRAG_EMBEDDING_ENDPOINT = os.environ.get("LITELLM_LIGHTRAG_EMBEDDING_ENDPOINT")
assert LITELLM_LIGHTRAG_EMBEDDING_ENDPOINT, "LITELLM_LIGHTRAG_EMBEDDING_ENDPOINT environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_EMBEDDING_ENDPOINT: set")

LITELLM_LIGHTRAG_EMBEDDING_DEPLOYMENT = os.environ.get("LITELLM_LIGHTRAG_EMBEDDING_DEPLOYMENT")
assert LITELLM_LIGHTRAG_EMBEDDING_DEPLOYMENT, "LITELLM_LIGHTRAG_EMBEDDING_DEPLOYMENT environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_EMBEDDING_DEPLOYMENT: set")

LITELLM_LIGHTRAG_EMBEDDING_API_KEY = os.environ.get("LITELLM_LIGHTRAG_EMBEDDING_API_KEY")
assert LITELLM_LIGHTRAG_EMBEDDING_API_KEY, "LITELLM_LIGHTRAG_EMBEDDING_API_KEY environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_EMBEDDING_API_KEY: set")

LITELLM_LIGHTRAG_EMBEDDING_API_VERSION = os.environ.get("LITELLM_LIGHTRAG_EMBEDDING_API_VERSION")
assert LITELLM_LIGHTRAG_EMBEDDING_API_VERSION, "LITELLM_LIGHTRAG_EMBEDDING_API_VERSION environment variable is not set"
logger.debug("LITELLM_LIGHTRAG_EMBEDDING_API_VERSION: set")
#---------------/Secrets---------------


#---------------Configurations---------------
AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM = os.environ.get("AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM", 10)
assert AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM, "AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM environment variable is not set"
logger.debug("AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM: set")

AUDIO_LIGHTRAG_TIME_THRESHOLD_SECONDS = os.environ.get("AUDIO_LIGHTRAG_TIME_THRESHOLD_SECONDS", 60)
assert AUDIO_LIGHTRAG_TIME_THRESHOLD_SECONDS, "AUDIO_LIGHTRAG_TIME_THRESHOLD_SECONDS environment variable is not set"
logger.debug("AUDIO_LIGHTRAG_TIME_THRESHOLD_SECONDS: set")

ENABLE_AUDIO_LIGHTRAG_INPUT = os.environ.get("ENABLE_AUDIO_LIGHTRAG_INPUT") 
assert ENABLE_AUDIO_LIGHTRAG_INPUT, "ENABLE_AUDIO_LIGHTRAG_INPUT environment variable is not set"
logger.debug(f"ENABLE_AUDIO_LIGHTRAG_INPUT: {ENABLE_AUDIO_LIGHTRAG_INPUT}")

AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB = os.environ.get("AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB", 15)
assert AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB, "AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB environment variable is not set"
logger.debug("AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB: set")

#---------------/Configurations---------------

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
]:
    logging.getLogger(hide_logger).setLevel(logging.WARNING)
