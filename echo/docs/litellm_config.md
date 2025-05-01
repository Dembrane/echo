# LiteLLM Configuration Documentation

This document outlines all LiteLLM-related configurations and their explanations used in the system.

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
- `REDIS_LOCK_EXPIRY`: Time in seconds before a Redis lock expires (default: 3600, which is 1 hour). This prevents the same conversation ID from being processed within this time period.