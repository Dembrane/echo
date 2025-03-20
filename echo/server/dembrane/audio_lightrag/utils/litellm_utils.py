import json
from typing import Any, Optional

from litellm import completion
from pydantic import BaseModel

from dembrane.config import (
    AZURE_OPENAI_AUDIOMODEL_NAME,
    AZURE_OPENAI_LIGHTRAGLLM_NAME,
    AZURE_OPENAI_AUDIOMODEL_API_KEY,
    AZURE_OPENAI_AUDIOMODEL_ENDPOINT,
    AZURE_OPENAI_LIGHTRAGLLM_API_KEY,
    AZURE_OPENAI_LIGHTRAGLLM_ENDPOINT,
    AZURE_OPENAI_AUDIOMODEL_API_VERSION,
    AZURE_OPENAI_LIGHTRAGLLM_API_VERSION,
    AZURE_OPENAI_TEXTSTRUCTUREMODEL_NAME,
    AZURE_OPENAI_TEXTSTRUCTUREMODEL_API_KEY,
    AZURE_OPENAI_TEXTSTRUCTUREMODEL_ENDPOINT,
    AZURE_OPENAI_TEXTSTRUCTUREMODEL_API_VERSION,
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
        model=f"azure/{AZURE_OPENAI_AUDIOMODEL_NAME}",
        messages=audio_model_messages,
        api_base=AZURE_OPENAI_AUDIOMODEL_ENDPOINT,
        api_version=AZURE_OPENAI_AUDIOMODEL_API_VERSION,
        api_key=AZURE_OPENAI_AUDIOMODEL_API_KEY
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
        model=f"azure/{AZURE_OPENAI_TEXTSTRUCTUREMODEL_NAME}",
        messages=text_structuring_model_messages,
        api_base=AZURE_OPENAI_TEXTSTRUCTUREMODEL_ENDPOINT,
        api_version=AZURE_OPENAI_TEXTSTRUCTUREMODEL_API_VERSION,
        api_key=AZURE_OPENAI_TEXTSTRUCTUREMODEL_API_KEY,
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
        model=f"azure/{AZURE_OPENAI_LIGHTRAGLLM_NAME}",  # litellm format for Azure models
        messages=messages,
        temperature=kwargs.get("temperature", 0.2),
        api_key=AZURE_OPENAI_LIGHTRAGLLM_API_KEY,
        api_version=AZURE_OPENAI_LIGHTRAGLLM_API_VERSION,
        api_base=AZURE_OPENAI_LIGHTRAGLLM_ENDPOINT
    )
    return chat_completion.choices[0].message.content