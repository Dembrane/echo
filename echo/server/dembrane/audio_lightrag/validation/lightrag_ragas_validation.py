import os
import asyncio

import pandas as pd
from dotenv import load_dotenv
from datasets import load_dataset
from lightrag import LightRAG, QueryParam
from ragas.metrics import LLMContextRecall
from huggingface_hub import login
from ragas.dataset_schema import SingleTurnSample
from lightrag.kg.shared_storage import initialize_pipeline_status
from langchain_openai.chat_models import AzureChatOpenAI

from dembrane.config import (
    LIGHTRAG_LITELLM_MODEL,
    LIGHTRAG_LITELLM_API_KEY,
    LIGHTRAG_LITELLM_API_VERSION,
    LIGHTRAG_LITELLM_API_BASE,
)
from dembrane.audio_lightrag.utils.litellm_utils import embedding_func, llm_model_func

load_dotenv()


async def initialize_rag():
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

rag = asyncio.run(initialize_rag())

async def get_rag_items(user_input):
    # Initialize RAG instance
    relevant_keys = ["Data Sources", "Entities", 
                     "Relationships", "Sources", "Response Rules"]
    result = await rag.aquery(user_input, param=QueryParam(mode="mix", only_need_prompt=True))
    result_dict = parse_sections(result)
    relevant_result_dict = {k:v for k,v in result_dict.items() if k in relevant_keys}
    retrieved_contexts = '\n'.join(relevant_result_dict.values()).split('\n')
    response = await rag.aquery(user_input, param=QueryParam(mode="mix", only_need_prompt=False))
    return response, retrieved_contexts


# asyncio.run(main())


# Load the dataset from Hugging Face Hub
HF_TOKEN = os.getenv('HF_TOKEN')
login(token=HF_TOKEN)
dataset = load_dataset("Roy2358/echo_val_dataset")
df = pd.DataFrame(dataset['train'])
df = df.head(5)

#No litellm integration. Piggybacking on Azure OpenAI for now.
evaluator_llm = AzureChatOpenAI(
    deployment_name=LIGHTRAG_LITELLM_MODEL,
    api_version=LIGHTRAG_LITELLM_API_VERSION,
    api_key=LIGHTRAG_LITELLM_API_KEY,
    azure_endpoint=LIGHTRAG_LITELLM_API_BASE,
    temperature=0.0
)

print('stop')
