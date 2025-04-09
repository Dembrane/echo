# import os
import asyncio

import numpy as np
import pandas as pd
from ragas import EvaluationDataset, evaluate

# from dotenv import load_dotenv
from datasets import load_dataset
from lightrag import LightRAG, QueryParam
from ragas.llms import LangchainLLMWrapper
from ragas.metrics import (
    Faithfulness,
    LLMContextRecall,
    ResponseRelevancy,
    ContextEntityRecall,
    LLMContextPrecisionWithReference,
)
from huggingface_hub import login
from validation_config import (
    HF_TOKEN,
    WANDB_API_KEY,
    WANDB_PROJECT,
    VALIDATION_LLM_MODEL,
    VALIDATION_LLM_API_KEY,
    VALIDATION_DATASET_REPO,
    VALIDATION_LLM_API_BASE,
    VALIDATION_LLM_API_VERSION,
    validation_bsz,
    validation_sample_size,
)
from ragas.dataset_schema import SingleTurnSample
from lightrag.kg.shared_storage import initialize_pipeline_status
from langchain_community.chat_models import ChatLiteLLM

# from langchain_openai.chat_models import AzureChatOpenAI
import wandb
from dembrane.config import (
    LIGHTRAG_LITELLM_MODEL,
    LIGHTRAG_LITELLM_EMBEDDING_MODEL,
    LIGHTRAG_LITELLM_AUDIOMODEL_MODEL,
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL,
)
from dembrane.audio_lightrag.utils.litellm_utils import embedding_func, llm_model_func

# Load the dataset from Hugging Face Hub
login(token=HF_TOKEN)

section_keys = [
        "---Role---",
        "---Goal---",
        "---Conversation History---",
        "---Data Sources---",
        "-----Entities-----",
        "-----Relationships-----",
        "-----Sources-----",
        "---Response Rules---"
    ]
dataset = load_dataset(VALIDATION_DATASET_REPO)
df = pd.DataFrame(dataset['train'])
df = df.sample(min(validation_sample_size, len(df)))
batches = [df.iloc[i:i+validation_bsz] for i in range(0, len(df), validation_bsz)]
config={"bsz": validation_bsz,
        "dataset_name": VALIDATION_DATASET_REPO,
        "sample_size": validation_sample_size,
        "validation_llm_model": VALIDATION_LLM_MODEL,
        "LIGHTRAG_LITELLM_MODEL": LIGHTRAG_LITELLM_MODEL,
        "LIGHTRAG_LITELLM_AUDIOMODEL_MODEL": LIGHTRAG_LITELLM_AUDIOMODEL_MODEL,
        "LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL": LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL,
        "LIGHTRAG_LITELLM_EMBEDDING_MODEL": LIGHTRAG_LITELLM_EMBEDDING_MODEL }
wandb_name = f"{validation_sample_size}-{LIGHTRAG_LITELLM_EMBEDDING_MODEL}-{LIGHTRAG_LITELLM_MODEL}-{LIGHTRAG_LITELLM_AUDIOMODEL_MODEL}-{LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL}"


context_precision = LLMContextPrecisionWithReference()
context_recall = LLMContextRecall()
context_entity_recall = ContextEntityRecall()
response_relevancy = ResponseRelevancy()
faithfulness = Faithfulness()

metrics=[
    context_precision,
    context_recall,
    context_entity_recall,
    faithfulness,
    # response_relevancy,
]
async def initialize_rag() -> LightRAG:
    rag = LightRAG(
            working_dir=None,
            llm_model_func=llm_model_func,
            embedding_func=embedding_func,
            kv_storage="PGKVStorage",
            doc_status_storage="PGDocStatusStorage",
            graph_storage="Neo4JStorage",
            vector_storage="PGVectorStorage",
            vector_db_storage_cls_kwargs={
                "cosine_better_than_threshold": 0.4
            }
        )
    await rag.initialize_storages()
    await initialize_pipeline_status()
    return rag

def parse_sections(text: str) -> dict:
    # List of possible section keys to look for
    result = {}
    
    # Find content between section markers
    for i, key in enumerate(section_keys):
        if key not in text:
            continue
            
        start_idx = text.find(key) + len(key)
        
        # Find the next section key that exists in the remaining text
        end_idx = len(text)
        for next_key in section_keys[i+1:]:
            if next_key in text[start_idx:]:
                end_idx = text.find(next_key, start_idx)
                break
        
        # Extract content and clean it
        content = text[start_idx:end_idx].strip()
        
        # Store in dictionary using simplified key (without dashes)
        simple_key = key.strip('-')
        result[simple_key] = content
    
    return result

async def get_rag_items(user_input: str, rag: LightRAG) -> tuple[str, list[str]]:
    # Initialize RAG instance
    relevant_keys = ["Data Sources", "Entities", 
                     "Relationships", "Sources", "Response Rules"]
    result = await rag.aquery(user_input, param=QueryParam(mode="mix", only_need_prompt=True))
    result_dict = parse_sections(result)
    relevant_result_dict = {k:v for k,v in result_dict.items() if k in relevant_keys}
    retrieved_contexts = '\n'.join(relevant_result_dict.values()).split('\n')
    response = await rag.aquery(user_input, param=QueryParam(mode="mix", only_need_prompt=False))
    return response, retrieved_contexts

async def get_single_turn_samples(df: pd.DataFrame) -> list[SingleTurnSample]:
    single_turn_samples = []
    for _, row in df.iterrows():
        # get_rag_items 
        response, retrieved_contexts = await get_rag_items(row['user_input'], rag)
        single_turn_samples.append(
            SingleTurnSample(
                response=response,
                retrieved_contexts=retrieved_contexts,
                user_input=row['user_input'],
                reference=row['reference'],
                reference_contexts = row['reference_contexts']
            )
        )
    return single_turn_samples

rag = asyncio.run(initialize_rag())
cummulative_dict = None
#No litellm integration. Piggybacking on Azure OpenAI for now.
evaluator_llm = LangchainLLMWrapper(
    ChatLiteLLM(            
    api_key=str(VALIDATION_LLM_API_KEY),
    api_version=str(VALIDATION_LLM_API_VERSION),
    api_base=str(VALIDATION_LLM_API_BASE),
    model=VALIDATION_LLM_MODEL
)
)
wandb.login(key=WANDB_API_KEY)
wandb.init(project=WANDB_PROJECT, 
           name=wandb_name,
           config=config)
for i, batch in enumerate(batches):
    single_turn_samples = asyncio.run(get_single_turn_samples(batch))
    batch_dataset = EvaluationDataset(single_turn_samples)
    batch_report = evaluate(
        batch_dataset, 
        metrics=metrics, 
        llm=evaluator_llm
    )
    print(f"After batch {i+1}, cumulative results ({validation_bsz*(i+1)} samples):")
    print(batch_report)
    
    log_dict = batch_report.to_pandas().to_dict()
    log_dict["batch_idx"] = [i]

    if cummulative_dict:
        cummulative_dict = {k: cummulative_value_list + batch_report._scores_dict[k] 
                            for k,cummulative_value_list in cummulative_dict.items()}
    else:
        cummulative_dict = batch_report._scores_dict
    
    # func to replace np.nan with 0 for a list
    def replace_nan_with_zero(li):
        return [0 if isinstance(i, float) and np.isnan(i) else i for i in li]
    cummulative_dict = {k: replace_nan_with_zero(v) for k,v in cummulative_dict.items()}
    wandb.log({k:np.median(v) for k,v in cummulative_dict.items()})
    
    checkpoint = {
        "batch_idx": i,
        "latest_metrics": batch_report
    }
    wandb.save(f"checkpoint_{i}.json")

wandb.finish()
