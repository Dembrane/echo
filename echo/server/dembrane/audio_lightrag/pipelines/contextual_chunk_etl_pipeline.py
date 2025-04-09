# import os
import base64
import asyncio
from io import BytesIO
from logging import getLogger

import pandas as pd
import requests
from pydub import AudioSegment

from dembrane.s3 import get_stream_from_s3
from dembrane.config import (
    API_BASE_URL,
    RUNPOD_API_KEY,
    AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM,
)
from dembrane.directus import directus
from dembrane.api.stateless import (
    InsertRequest,
    DiarizationRequest,
    diarization,
    insert_item,
)
from dembrane.api.dependency_auth import DirectusSession
from dembrane.audio_lightrag.utils.prompts import Prompts, format_diarization_df
from dembrane.audio_lightrag.utils.audio_utils import wav_to_str
from dembrane.audio_lightrag.utils.litellm_utils import get_json_dict_from_audio
from dembrane.audio_lightrag.utils.lightrag_utils import merge_consecutive_speakers
from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker

logger = getLogger("audio_lightrag.pipelines.contextual_chunk_etl_pipeline")

class ContextualChunkETLPipeline:
    def __init__(self,
                 process_tracker:ProcessTracker,) -> None:
        
        self.conversation_history_num = AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM
        self.process_tracker = process_tracker
        self.api_base_url = API_BASE_URL

    def extract(self) -> None:pass 
    def transform(self) -> None:pass
    async def load(self) -> None:
        for conversation_id in self.process_tracker().conversation_id.unique():
            segment_li = ','.join(self.process_tracker().sort_values('timestamp')[self.process_tracker()['conversation_id']  == 
                                                         conversation_id].sort_values('timestamp'
                                                                                      ).segment).split(',')
            segment_li = [int(x) for x in list(dict.fromkeys(segment_li))]  # type: ignore
            project_id = self.process_tracker()[self.process_tracker()['conversation_id'] == conversation_id].project_id.unique()[0]
            event_text = '\n\n'.join([f"{k} : {v}" for k,v in self.process_tracker.get_project_df().loc[project_id].to_dict().items()])
            responses = {}
            for idx,segment_id in enumerate(segment_li):
                previous_conversation_text_li = []
                
                for previous_segment in segment_li[max(0,idx-int(self.conversation_history_num)):idx]:
                    try:
                        contextual_transcript = directus.get_item('conversation_segment', int(previous_segment))['contextual_transcript']
                        previous_conversation_text_li.append(contextual_transcript)
                    except Exception as e:
                        logger.exception(f"Error in getting contextual transcript : {e}")
                        continue
                previous_conversation_text = '\n\n'.join(previous_conversation_text_li)
                audio_model_prompt = Prompts.audio_model_system_prompt()

                try: 
                    response = directus.get_item('conversation_segment', int(segment_id))
                except Exception as e:
                    logger.exception(f"Error in getting conversation segment : {e}")
                    continue
                audio_stream = get_stream_from_s3(response['path'])
                if response['contextual_transcript'] is None:
                    try:
                        audio_stream_read = audio_stream.read()
                        wav_encoding = audio_base64 = base64.b64encode(audio_stream_read).decode('utf-8')
                        # Run diarization
                        session = DirectusSession(user_id="none", is_admin=True)#fake session
                        diarization_response = await diarization(DiarizationRequest(
                            audio_data=audio_base64,
                            file_type="wav"
                        ), session)
                        diarization_df = pd.DataFrame(diarization_response.diarization_dict_li)[['start', 'end', 'speaker']]
                        diarization_df = merge_consecutive_speakers(diarization_df)
                        speaker_diarization_report = format_diarization_df(diarization_df)
                        audio_model_prompt = audio_model_prompt.format(event_text = event_text,
                                                previous_conversation_text = previous_conversation_text,
                                                speaker_diarization_report = speaker_diarization_report)
                        # Run audio model
                        responses[segment_id] = get_json_dict_from_audio(wav_encoding = wav_encoding,
                                                                         audio_model_prompt=audio_model_prompt,
                                                                        )
                        # Update conversation segment
                        directus.update_item('conversation_segment', int(segment_id), 
                                            {'transcript': '\n\n'.join([' : '.join(list(d.values())) for d in responses[segment_id]['TRANSCRIPTS']]),
                                             'contextual_transcript': responses[segment_id]['CONTEXTUAL_TRANSCRIPT']})
                    except Exception as e:
                        logger.exception(f"Error in getting contextual transcript : {e}. Check LiteLLM API configs")
                        continue
                else:
                    responses[segment_id] = {'CONTEXTUAL_TRANSCRIPT': response['contextual_transcript'],
                                             'TRANSCRIPTS': response['transcript'].split('\n\n')}
                if response['lightrag_flag'] is False:
                    try:
                        payload = InsertRequest(
                            content=responses[segment_id]['CONTEXTUAL_TRANSCRIPT'],
                            echo_segment_id=str(segment_id),
                            transcripts=responses[segment_id]['TRANSCRIPTS']
                        )
                        #fake session
                        session = DirectusSession(user_id="none", is_admin=True)
                        response = await insert_item(payload, session)

                        if response.status == 'success':
                            directus.update_item('conversation_segment', int(segment_id), 
                                                {'lightrag_flag': True})
                        else:
                            logger.info(f"Error in inserting transcript into LightRAG for segment {segment_id}. Check API health : {response.status_code}")
                            
                    except Exception as e:
                        logger.exception(f"Error in inserting transcript into LightRAG : {e}")


    def run(self) -> None:
        self.extract()
        self.transform()
        asyncio.run(self.load())
            