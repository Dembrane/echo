from io import BytesIO
from logging import getLogger

import requests
from pydub import AudioSegment

from dembrane.s3 import get_stream_from_s3
from dembrane.config import (
    API_BASE_URL,
    AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM,
)
from dembrane.directus import directus
from dembrane.audio_lightrag.utils.prompts import Prompts
from dembrane.audio_lightrag.utils.audio_utils import wav_to_str
from dembrane.audio_lightrag.utils.litellm_utils import get_json_dict_from_audio
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
    def load(self) -> None:

        for conversation_id in self.process_tracker().conversation_id.unique():
            segment_li = ','.join(self.process_tracker().sort_values('timestamp')[self.process_tracker()['conversation_id']  == 
                                                         conversation_id].sort_values('timestamp'
                                                                                      ).segment).split(',')
            segment_li = [int(x) for x in list(dict.fromkeys(segment_li))]  # type: ignore
            project_id = self.process_tracker()[self.process_tracker()['conversation_id'] == conversation_id].project_id.unique()[0]
            event_text = '\n\n'.join([f"{k} : {v}" for k,v in self.process_tracker.get_project_df().loc[project_id].to_dict().items()])
            responses = {}
            for idx,segment_id in enumerate(segment_li):
                previous_contextual_transcript_li = []
                for previous_segment in segment_li[max(0,idx-int(self.conversation_history_num)):idx]:
                    contextual_transcript = directus.get_item('conversation_segment', int(previous_segment))['contextual_transcript']
                    previous_contextual_transcript_li.append(contextual_transcript)
                previous_contextual_transcript = '\n\n'.join(previous_contextual_transcript_li)
                audio_model_prompt = Prompts.audio_model_system_prompt()
                audio_model_prompt = audio_model_prompt.format(event_text = event_text, 
                                        previous_conversation_text = previous_contextual_transcript)
                response = directus.get_item('conversation_segment', int(segment_id))
                audio_stream = get_stream_from_s3(response['path'])
                wav_encoding = wav_to_str(
                    AudioSegment.from_file(BytesIO(audio_stream.read()), 
                                           format="wav")
                                           )
                if response['contextual_transcript'] is None:
                    try:  
                        responses[segment_id] = get_json_dict_from_audio(wav_encoding = wav_encoding,
                                                                         audio_model_prompt=audio_model_prompt,
                                                                        )
                        directus.update_item('conversation_segment', int(segment_id), 
                                            {'transcript': '\n\n'.join(responses[segment_id]['TRANSCRIPTS']),
                                             'contextual_transcript': responses[segment_id]['CONTEXTUAL_TRANSCRIPT']})
                    except Exception as e:
                        logger.exception(f"Error in getting contextual transcript : {e}")
                        continue
            
                    try:
                        response = requests.post(
                            f"{self.api_base_url}/api/stateless/rag/insert",
                            json={"content": responses[segment_id]['CONTEXTUAL_TRANSCRIPT'],
                                    "id": str(segment_id),
                                    "transcripts": responses[segment_id]['TRANSCRIPTS']}
                        )
                        # lightrag_flag is a boolean field in the conversation_segment table
                        directus.update_item('conversation_segment', int(segment_id), 
                                            {'lightrag_flag': True})
                        if response.status_code != 200:
                            logger.info(f"Error in inserting transcript into LightRAG for segment {segment_id}. Check API health : {response.status_code}")
                            
                    except Exception as e:
                        logger.exception(f"Error in inserting transcript into LightRAG : {e}")


    def run(self) -> None:
        self.extract()
        self.transform()
        self.load()
            