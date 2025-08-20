# LightRAG Audio Validation System

This document describes the technical validation process for the LightRAG audio system, including data generation, dataset creation, and evaluation metrics.

## Overview

The validation system consists of three main components:

1. **Data Generation**: Extract and process audio data from the FLORAS dataset
2. **Dataset Upload**: Create validation datasets and upload to Hugging Face Hub
3. **Validation Evaluation**: Run LightRAG validation using RAGAS metrics

## Architecture

```
FLORAS Dataset → Data Processing → HuggingFace Hub → LightRAG Validation → Metrics Storage
```

## Components

### 1. Data Generation (`data_generator.py` / `floras_data_generator.py`)

#### Purpose
Extracts audio data from the ESP-net FLORAS dataset and generates validation test sets using RAGAS.

#### Process Flow
1. **Dataset Loading**: Loads the `espnet/floras` monolingual dataset in streaming mode
2. **Audio Filtering**: 
   - Filters audio files with quality score ≤ 1.0
   - Skips files > 10M samples (memory optimization)
   - Processes audio files < 10 minutes duration
3. **Text Processing**: 
   - Uses `RecursiveCharacterTextSplitter` with 1200 chunk size and 200 overlap
   - Creates Langchain documents with metadata preservation
4. **Test Set Generation**: 
   - Uses Azure OpenAI models for LLM and embeddings
   - Generates 300 test samples using RAGAS `TestsetGenerator`

#### Configuration Parameters
- `count_of_audio`: 10 (number of audio files to process)
- `testset_size`: 300 (number of test samples to generate)
- Chunk size: 1200 characters
- Chunk overlap: 200 characters

#### Key Dependencies
- `datasets`: For FLORAS dataset loading
- `ragas`: For test set generation
- `langchain`: For text processing and Azure OpenAI integration
- `huggingface_hub`: For dataset upload

### 2. Configuration Management (`validation_config.py`)

#### Environment Variables Required

##### Hugging Face Configuration
```bash
HF_TOKEN=<your_hf_token>
VALIDATION_DATASET_REPO=<hf_dataset_repo>
```

##### Azure OpenAI Configuration (Data Generation)
```bash
LITELLM_LIGHTRAG_NAME=<model_name>
LITELLM_LIGHTRAG_ENDPOINT=<azure_endpoint>
LITELLM_LIGHTRAG_APIKEY=<api_key>
LITELLM_LIGHTRAG_API_VERSION=<api_version>

# Embedding Model
LITELLM_LIGHTRAG_DATA_GENERATOR_EMBEDDING_ENDPOINT=<embedding_endpoint>
LITELLM_LIGHTRAG_DATA_GENERATOR_EMBEDDING_API_KEY=<embedding_api_key>
LITELLM_LIGHTRAG_DATA_GENERATOR_EMBEDDING_API_VERSION=<embedding_api_version>
LITELLM_LIGHTRAG_DATA_GENERATOR_EMBEDDING_DEPLOYMENT=<embedding_deployment>
```

##### Validation LLM Configuration
```bash
VALIDATION_LLM_MODEL=<validation_model>
VALIDATION_LLM_API_BASE=<validation_api_base>
VALIDATION_LLM_API_KEY=<validation_api_key>
VALIDATION_LLM_API_VERSION=<validation_api_version>
```

##### Weights & Biases Configuration
```bash
WANDB_API_KEY=<wandb_api_key>
WANDB_PROJECT=<project_name>  # defaults to "lightrag-evaluation"
```

##### Validation Parameters
```bash
VALIDATION_BSZ=<batch_size>           # Batch size for validation
VALIDATION_SAMPLE_SIZE=<sample_size>  # Number of samples to validate
```

### 3. LightRAG Validation (`lightrag_ragas_validation.py`)

#### Purpose
Evaluates LightRAG performance using RAGAS metrics on the generated validation dataset.

#### Evaluation Metrics
- **Context Precision with Reference**: Measures precision of retrieved context
- **Context Recall**: Measures recall of retrieved context  
- **Context Entity Recall**: Measures entity-level recall
- **Faithfulness**: Measures factual consistency of responses
- **Response Relevancy**: Measures relevance of generated responses (commented out)

#### Process Flow

1. **Dataset Loading**: Loads validation dataset from Hugging Face Hub
2. **RAG Initialization**: 
   - Configures LightRAG with PostgreSQL KV storage
   - Uses Neo4J for graph storage
   - Uses PostgreSQL for vector storage
   - Sets cosine similarity threshold to 0.4
3. **Batch Processing**: 
   - Processes data in configurable batches
   - Samples up to `validation_sample_size` records
4. **Query Processing**:
   - Extracts structured sections from RAG responses
   - Parses: Role, Goal, Conversation History, Data Sources, Entities, Relationships, Sources, Response Rules
   - Generates responses and retrieves contexts
5. **Evaluation**: 
   - Creates `SingleTurnSample` objects for RAGAS evaluation
   - Runs evaluation using configured metrics
   - Handles NaN values by replacing with zeros
6. **Logging**: 
   - Logs cumulative metrics to Weights & Biases
   - Saves checkpoints for each batch
   - Tracks model configurations and parameters

#### Storage Configuration
- **KV Storage**: PostgreSQL (`PGKVStorage`)
- **Document Status**: PostgreSQL (`PGDocStatusStorage`) 
- **Graph Storage**: Neo4J (`Neo4JStorage`)
- **Vector Storage**: PostgreSQL (`PGVectorStorage`)

## Usage Instructions

### Step 1: Environment Setup

1. Create a `.env` file with all required environment variables (see Configuration section)
2. Ensure access to:
   - Azure OpenAI services
   - Hugging Face Hub (with write permissions)
   - Weights & Biases account
   - PostgreSQL database
   - Neo4J database

### Step 2: Data Generation and Upload

```bash
# Run data generation (choose one)
python data_generator.py
# OR
python floras_data_generator.py
```

This will:
- Process FLORAS dataset audio files
- Generate validation test sets using RAGAS
- Upload the dataset to Hugging Face Hub

**Note**: The difference between `data_generator.py` and `floras_data_generator.py` is the target repository:
- `data_generator.py` uses `VALIDATION_DATASET_REPO`
- `floras_data_generator.py` uses `HF_VALIDATION_DATASET_REPO`

### Step 3: Audio Data Integration

**Important**: Before running validation, ensure all audio data is properly integrated into your LightRAG project/knowledge base. This step is project-specific and depends on your audio processing pipeline.

### Step 4: Run Validation

```bash
python lightrag_ragas_validation.py
```

This will:
- Load the validation dataset from Hugging Face
- Initialize LightRAG with configured storage backends
- Process validation samples in batches
- Evaluate using RAGAS metrics
- Log results to Weights & Biases
- Save local checkpoints

### Step 5: Monitor Results

- **Weights & Biases**: Real-time metrics tracking and visualization
- **Local Checkpoints**: Saved as `checkpoint_{batch_idx}.json`
- **Console Output**: Batch-by-batch progress and cumulative results

## Output Metrics

The validation system tracks the following metrics:

1. **Context Precision with Reference**: Precision of retrieved context against reference
2. **Context Recall**: Recall of retrieved context
3. **Context Entity Recall**: Entity-level recall performance
4. **Faithfulness**: Factual consistency of generated responses

Metrics are:
- Calculated per batch and cumulatively
- Logged to Weights & Biases with model configuration
- Saved locally in checkpoint files
- NaN values are replaced with 0 for stability

## File Structure

```
validation/
├── README.md                          # This documentation
├── validation_config.py               # Configuration management
├── data_generator.py                  # FLORAS data processing (VALIDATION_DATASET_REPO)
├── floras_data_generator.py          # FLORAS data processing (HF_VALIDATION_DATASET_REPO)
├── lightrag_ragas_validation.py      # Main validation script
└── data/                             # Local data directory (if needed)
```

## Troubleshooting

### Common Issues

1. **Memory Issues**: 
   - Reduce `count_of_audio` or `testset_size`
   - Ensure audio files are under size limits (10M samples)

2. **API Rate Limits**:
   - Reduce batch size (`VALIDATION_BSZ`)
   - Add delays between API calls if needed

3. **Storage Connection Issues**:
   - Verify PostgreSQL and Neo4J connectivity
   - Check database credentials and permissions

4. **Hugging Face Upload Issues**:
   - Verify `HF_TOKEN` permissions
   - Ensure dataset repository exists and is writable

### Performance Optimization

- **Batch Size**: Adjust `VALIDATION_BSZ` based on available memory and API limits
- **Sample Size**: Use `VALIDATION_SAMPLE_SIZE` to limit evaluation scope during testing
- **Parallel Processing**: The system processes batches sequentially but can be modified for parallel batch processing

## Dependencies

Key Python packages required:
- `datasets`: Hugging Face datasets
- `ragas`: RAG evaluation framework
- `lightrag`: LightRAG framework
- `langchain`: LLM framework and text processing
- `wandb`: Experiment tracking
- `pandas`, `numpy`: Data processing
- `tqdm`: Progress tracking
- `huggingface_hub`: Dataset management

## Security Considerations

- Store all API keys and tokens in environment variables
- Use `.env` files that are excluded from version control
- Ensure database connections use secure credentials
- Validate input data to prevent injection attacks
