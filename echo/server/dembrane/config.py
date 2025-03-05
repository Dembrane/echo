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
    dotenv.load_dotenv(dotenv_path, verbose=True)

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

DIRECTUS_SESSION_COOKIE_NAME = os.environ.get("DIRECTUS_SESSION_COOKIE_NAME", "directus_session_token")
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

RABBITMQ_URL = os.environ.get("RABBITMQ_URL")
assert RABBITMQ_URL, "RABBITMQ_URL environment variable is not set"
logger.debug("RABBITMQ_URL: set")

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
