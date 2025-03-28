import json
from typing import Any, Optional

import numpy as np
from litellm import embedding, completion
from pydantic import BaseModel

from dembrane.config import (
    LIGHTRAG_LITELLM_MODEL,
    LIGHTRAG_LITELLM_API_KEY,
    LIGHTRAG_LITELLM_API_BASE,
    LIGHTRAG_LITELLM_API_VERSION,
    LIGHTRAG_LITELLM_EMBEDDING_MODEL,
    LIGHTRAG_LITELLM_AUDIOMODEL_MODEL,
    LIGHTRAG_LITELLM_EMBEDDING_API_KEY,
    LIGHTRAG_LITELLM_AUDIOMODEL_API_KEY,
    LIGHTRAG_LITELLM_EMBEDDING_API_BASE,
    LIGHTRAG_LITELLM_AUDIOMODEL_API_BASE,
    LIGHTRAG_LITELLM_EMBEDDING_API_VERSION,
    LIGHTRAG_LITELLM_AUDIOMODEL_API_VERSION,
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL,
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY,
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE,
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION,
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
        model=f"{LIGHTRAG_LITELLM_AUDIOMODEL_MODEL}",
        messages=audio_model_messages,
        api_base=LIGHTRAG_LITELLM_AUDIOMODEL_API_BASE,
        api_version=LIGHTRAG_LITELLM_AUDIOMODEL_API_VERSION,
        api_key=LIGHTRAG_LITELLM_AUDIOMODEL_API_KEY
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
        model=f"{LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL}",
        messages=text_structuring_model_messages,
        api_base=LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE,
        api_version=LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION,
        api_key=LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY,
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
        model=f"{LIGHTRAG_LITELLM_MODEL}",  # litellm format for Azure models
        messages=messages,
        temperature=kwargs.get("temperature", 0.2),
        api_key=LIGHTRAG_LITELLM_API_KEY,
        api_version=LIGHTRAG_LITELLM_API_VERSION,
        api_base=LIGHTRAG_LITELLM_API_BASE
    )
    return chat_completion.choices[0].message.content

async def embedding_func(texts: list[str]) -> np.ndarray:
    # Bug in litellm forcing us to do this: https://github.com/BerriAI/litellm/issues/6967
    nd_arr_response = []
    for text in texts:
        temp = embedding(
            model=f"{LIGHTRAG_LITELLM_EMBEDDING_MODEL}",
            input=text,
            api_key=str(LIGHTRAG_LITELLM_EMBEDDING_API_KEY),
            api_version=str(LIGHTRAG_LITELLM_EMBEDDING_API_VERSION),
            api_base=str(LIGHTRAG_LITELLM_EMBEDDING_API_BASE),
        )
        nd_arr_response.append(temp['data'][0]['embedding'])
    return np.array(nd_arr_response)