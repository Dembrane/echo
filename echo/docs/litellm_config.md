# LiteLLM Configuration Documentation

This document outlines all LiteLLM-related configurations and their explanations used in the system.

## LLM Model Groups (with Load Balancing and Failover)

The system uses LiteLLM Router for automatic load balancing and failover across multiple deployments. Each model group can have multiple deployments configured using numbered suffixes.

### Model Groups

| Group | Purpose | Supports Audio |
|-------|---------|----------------|
| `MULTI_MODAL_PRO` | Chat, reports, Echo replies, artifact generation | Yes (Gemini) |
| `MULTI_MODAL_FAST` | Realtime verification | Yes (Gemini) |
| `TEXT_FAST` | Summaries, chat streaming, auto-select | No (text only) |

### Configuration Pattern

Primary deployment (required):
```bash
LLM__<GROUP>__MODEL=<model>
LLM__<GROUP>__API_KEY=<key>
# ... other params
```

Fallback deployments (optional, numbered):
```bash
LLM__<GROUP>_1__MODEL=<model>
LLM__<GROUP>_2__MODEL=<model>
# ... etc
```

**Weight is inferred from the suffix**: Primary gets weight 10, `_1` gets weight 9, `_2` gets weight 8, etc.

### Example: EU Multi-Region Configuration

```bash
# TEXT_FAST: Azure West Europe (primary) + Sweden Central (fallback) + Gemini EU
LLM__TEXT_FAST__MODEL=azure/gpt-4o-mini
LLM__TEXT_FAST__API_BASE=https://westeurope.openai.azure.com
LLM__TEXT_FAST__API_KEY=sk-azure-west-...
LLM__TEXT_FAST__API_VERSION=2024-02-15-preview

LLM__TEXT_FAST_1__MODEL=azure/gpt-4o-mini
LLM__TEXT_FAST_1__API_BASE=https://swedencentral.openai.azure.com
LLM__TEXT_FAST_1__API_KEY=sk-azure-sweden-...
LLM__TEXT_FAST_1__API_VERSION=2024-02-15-preview

LLM__TEXT_FAST_2__MODEL=vertex_ai/gemini-2.0-flash
LLM__TEXT_FAST_2__VERTEX_LOCATION=europe-west1
LLM__TEXT_FAST_2__VERTEX_PROJECT=dembrane-prod
LLM__TEXT_FAST_2__VERTEX_CREDENTIALS=${GCP_SA_JSON}

# MULTI_MODAL_PRO: Gemini EU regions (audio support required)
LLM__MULTI_MODAL_PRO__MODEL=vertex_ai/gemini-2.5-pro
LLM__MULTI_MODAL_PRO__VERTEX_LOCATION=europe-west1
LLM__MULTI_MODAL_PRO__VERTEX_PROJECT=dembrane-prod
LLM__MULTI_MODAL_PRO__VERTEX_CREDENTIALS=${GCP_SA_JSON}

LLM__MULTI_MODAL_PRO_1__MODEL=vertex_ai/gemini-2.5-pro
LLM__MULTI_MODAL_PRO_1__VERTEX_LOCATION=europe-west4
LLM__MULTI_MODAL_PRO_1__VERTEX_PROJECT=dembrane-prod
LLM__MULTI_MODAL_PRO_1__VERTEX_CREDENTIALS=${GCP_SA_JSON}

# MULTI_MODAL_FAST: Same pattern
LLM__MULTI_MODAL_FAST__MODEL=vertex_ai/gemini-2.5-flash
LLM__MULTI_MODAL_FAST__VERTEX_LOCATION=europe-west4
LLM__MULTI_MODAL_FAST__VERTEX_CREDENTIALS=${GCP_SA_JSON}

LLM__MULTI_MODAL_FAST_1__MODEL=vertex_ai/gemini-2.5-flash
LLM__MULTI_MODAL_FAST_1__VERTEX_LOCATION=europe-west1
LLM__MULTI_MODAL_FAST_1__VERTEX_CREDENTIALS=${GCP_SA_JSON}
```

### Router Behavior

The LiteLLM Router provides:

- **Weighted load balancing**: Requests distributed based on deployment weight
- **Automatic retries**: 3 retries with exponential backoff
- **Cooldowns**: Failing deployments cooled down for 60 seconds after 3 failures
- **Failover**: Automatic failover to healthy deployments
- **Redis integration**: Distributed state tracking via existing Redis

### Startup Logging

At startup, the system logs all discovered deployments:

```
INFO  LiteLLM Router deployment summary:
INFO    text_fast: 3 deployment(s)
INFO      [0] azure/gpt-4o-mini @ westeurope (primary, weight=10)
INFO      [1] azure/gpt-4o-mini @ swedencentral (fallback, weight=9)
INFO      [2] vertex_ai/gemini-2.0-flash @ europe-west1 (fallback, weight=8)
INFO    multi_modal_pro: 2 deployment(s)
INFO      [0] vertex_ai/gemini-2.5-pro @ europe-west1 (primary, weight=10)
INFO      [1] vertex_ai/gemini-2.5-pro @ europe-west4 (fallback, weight=9)
INFO  Router initialized with 5 deployments (retries=3, cooldown=60s)
```

---

## Main LLM Model
**LIGHTRAG_LITELLM_MODEL**: Used by lightrag to perform Named Entity Recognition (NER) and create the knowledge graph
- Required Configurations:
  - `LIGHTRAG_LITELLM_MODEL`: Model identifier (e.g., azure/gpt-4o-mini)
  - `LIGHTRAG_LITELLM_API_KEY`: API key for authentication
  - `LIGHTRAG_LITELLM_API_VERSION`: API version
  - `LIGHTRAG_LITELLM_API_BASE`: Base URL for the API

## Audio Transcription Model
**LIGHTRAG_LITELLM_AUDIOMODEL_MODEL**: Used by audio-lightrag to convert input to transcript and generate contextual transcript
- Required Configurations:
  - `LIGHTRAG_LITELLM_AUDIOMODEL_MODEL`: Model identifier (e.g., azure/whisper-large-v3)
  - `LIGHTRAG_LITELLM_AUDIOMODEL_API_BASE`: Base URL for the audio model API
  - `LIGHTRAG_LITELLM_AUDIOMODEL_API_KEY`: API key for authentication
  - `LIGHTRAG_LITELLM_AUDIOMODEL_API_VERSION`: API version

## Text Structure Model
**LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL**: Used to structure the output of the audio model into desired format
- Required Configurations:
  - `LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL`: Model identifier (e.g., azure/gpt-4o-mini)
  - `LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE`: Base URL for the text structure model API
  - `LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY`: API key for authentication
  - `LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION`: API version

## Embedding Model
**LIGHTRAG_LITELLM_EMBEDDING_MODEL**: Used by lightrag to create embeddings for text
- Required Configurations:
  - `LIGHTRAG_LITELLM_EMBEDDING_MODEL`: Model identifier (e.g., azure/text-embedding-ada-002)
  - `LIGHTRAG_LITELLM_EMBEDDING_API_BASE`: Base URL for the embedding model API
  - `LIGHTRAG_LITELLM_EMBEDDING_API_KEY`: API key for authentication
  - `LIGHTRAG_LITELLM_EMBEDDING_API_VERSION`: API version

## Inference Model
**LIGHTRAG_LITELLM_INFERENCE_MODEL**: Used for responding to queries with auto-select capability
- Required Configurations:
  - `LIGHTRAG_LITELLM_INFERENCE_MODEL`: Model identifier (default: anthropic/claude-3-5-sonnet-20240620)
  - `LIGHTRAG_LITELLM_INFERENCE_API_KEY`: API key for authentication

## Additional Audio LightRAG Configurations

### Audio Processing Settings
- `AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM`: Number of conversation history items to maintain (default: 10)
- `AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS`: Time threshold for audio processing in seconds (default: 60). Files will not be processed if uploaded earlier than cooloff. Currently disabled, pass the current current tz stamp of directus in run_etl to enable
- `AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB`: Maximum allowed audio file size in MB (default: 15)
- `AUDIO_LIGHTRAG_TOP_K_PROMPT`: Top K value for prompt processing (default: 100)

### Feature Flags
- `ENABLE_AUDIO_LIGHTRAG_INPUT`: Enable/disable audio input processing (default: false)
- `ENABLE_CHAT_AUTO_SELECT`: Enable/disable auto-select feature (default: false) 

### Redis Lock Configuration
- `AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX`: Prefix for Redis lock keys (default: "etl_lock_conv_"). Used to create unique lock keys for each conversation ID in the ETL pipeline.
- `AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY`: Time in seconds before a Redis lock expires (default: 3600, which is 1 hour). This prevents the same conversation ID from being processed within this time period.