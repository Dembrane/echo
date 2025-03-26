import json
from typing import Any, Optional

import numpy as np
from litellm import embedding, completion
from pydantic import BaseModel

from dembrane.config import (
    LITELLM_LIGHTRAG_NAME,
    LITELLM_LIGHTRAG_APIKEY,
    LITELLM_LIGHTRAG_ENDPOINT,
    LITELLM_LIGHTRAG_PROVIDER,
    LITELLM_LIGHTRAG_API_VERSION,
    LITELLM_LIGHTRAG_AUDIOMODEL_NAME,
    LITELLM_LIGHTRAG_EMBEDDING_API_KEY,
    LITELLM_LIGHTRAG_AUDIOMODEL_API_KEY,
    LITELLM_LIGHTRAG_EMBEDDING_ENDPOINT,
    LITELLM_LIGHTRAG_EMBEDDING_PROVIDER,
    LITELLM_LIGHTRAG_AUDIOMODEL_ENDPOINT,
    LITELLM_LIGHTRAG_AUDIOMODEL_PROVIDER,
    LITELLM_LIGHTRAG_EMBEDDING_DEPLOYMENT,
    LITELLM_LIGHTRAG_EMBEDDING_API_VERSION,
    LITELLM_LIGHTRAG_AUDIOMODEL_API_VERSION,
    LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_NAME,
    LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_KEY,
    LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_ENDPOINT,
    LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_PROVIDER,
    LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_VERSION,
)
from dembrane.audio_lightrag.utils.prompts import Prompts


class Transctiptions(BaseModel):
    TRANSCRIPTS: list[str]
    CONTEXTUAL_TRANSCRIPT: str

def get_json_dict_from_audio(wav_encoding: str,
                        audio_model_prompt: str, 
                        ) -> dict: # type: ignore
    audio_model_messages=[
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": audio_model_prompt,
                    }
                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": wav_encoding,
                            "format": "wav"
                        }
                    }
                ]
            }
        ]

    audio_model_generation = completion(
        model=f"{LITELLM_LIGHTRAG_AUDIOMODEL_PROVIDER}/{LITELLM_LIGHTRAG_AUDIOMODEL_NAME}",
        messages=audio_model_messages,
        api_base=LITELLM_LIGHTRAG_AUDIOMODEL_ENDPOINT,
        api_version=LITELLM_LIGHTRAG_AUDIOMODEL_API_VERSION,
        api_key=LITELLM_LIGHTRAG_AUDIOMODEL_API_KEY
    )
    
    audio_model_generation_content = audio_model_generation.choices[0].message.content
    text_structuring_model_messages = [
        {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": Prompts.text_structuring_model_system_prompt(),
                        }
                    ]
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": audio_model_generation_content,
                        }
                    ]
                },
                
            ]

    text_structuring_model_generation = completion(
        model=f"{LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_PROVIDER}/{LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_NAME}",
        messages=text_structuring_model_messages,
        api_base=LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_ENDPOINT,
        api_version=LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_VERSION,
        api_key=LITELLM_LIGHTRAG_TEXTSTRUCTUREMODEL_API_KEY,
        response_format=Transctiptions)
    return json.loads(text_structuring_model_generation.choices[0].message.content) # type: ignore


async def llm_model_func(
    prompt: str, 
    system_prompt: Optional[str] = None, 
    history_messages: Optional[list[dict]] = None, 
    **kwargs: Any
) -> str:
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if history_messages:
        messages.extend(history_messages)
    messages.append({"role": "user", "content": prompt})

    chat_completion = completion(
        model=f"{LITELLM_LIGHTRAG_PROVIDER}/{LITELLM_LIGHTRAG_NAME}",  # litellm format for Azure models
        messages=messages,
        temperature=kwargs.get("temperature", 0.2),
        api_key=LITELLM_LIGHTRAG_APIKEY,
        api_version=LITELLM_LIGHTRAG_API_VERSION,
        api_base=LITELLM_LIGHTRAG_ENDPOINT
    )
    return chat_completion.choices[0].message.content

async def embedding_func(texts: list[str]) -> np.ndarray:
    # Bug in litellm forcing us to do this: https://github.com/BerriAI/litellm/issues/6967
    nd_arr_response = []
    for text in texts:
        temp = embedding(
            model=f"{LITELLM_LIGHTRAG_EMBEDDING_PROVIDER}/{LITELLM_LIGHTRAG_EMBEDDING_DEPLOYMENT}",
            input=text,
            api_key=str(LITELLM_LIGHTRAG_EMBEDDING_API_KEY),
            api_base=str(LITELLM_LIGHTRAG_EMBEDDING_ENDPOINT),
            api_version=str(LITELLM_LIGHTRAG_EMBEDDING_API_VERSION),
        )
        nd_arr_response.append(temp['data'][0]['embedding'])
    return np.array(nd_arr_response)