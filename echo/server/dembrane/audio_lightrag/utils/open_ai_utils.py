import json

from openai import AzureOpenAI
from pydantic import BaseModel

from dembrane.audio_lightrag.utils.prompts import Prompts
from dembrane.audio_lightrag.utils.audio_utils import wav_to_str


class Transctiptions(BaseModel):
    TRANSCRIPTS: list[str]
    CONTEXTUAL_TRANSCRIPT: str

def get_json_dict_from_audio(wav_loc: str,
                        audio_model_client: AzureOpenAI, 
                        audio_model_prompt: str, 
                        text_structuring_model_client: AzureOpenAI,
                        text_structuring_model_name: str,
                        ) -> dict:
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
                            "data": wav_to_str(wav_loc),
                            "format": "wav"
                        }
                    }
                ]
            }
        ]
    audio_model_generation = audio_model_client.chat.completions.create(
            model="gpt-4o-audio-preview",
            messages = audio_model_messages # type: ignore
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
    text_structuring_model_generation = text_structuring_model_client.beta.chat.completions.parse(
            model= text_structuring_model_name,
            messages = text_structuring_model_messages, # type: ignore
            response_format=Transctiptions,
        )
    return json.loads(text_structuring_model_generation.choices[0].message.content) # type: ignore