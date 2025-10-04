from logging import getLogger

from dembrane.config import (
    API_BASE_URL,
    AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM,
)
from dembrane.directus import directus
from dembrane.api.stateless import (
    InsertRequest,
    insert_item,
)
from dembrane.api.dependency_auth import DirectusSession
from dembrane.audio_lightrag.utils.prompts import Prompts
from dembrane.audio_lightrag.utils.echo_utils import renew_redis_lock
from dembrane.audio_lightrag.utils.async_utils import run_async_in_new_loop
from dembrane.audio_lightrag.utils.audio_utils import wav_to_str, safe_audio_decode
from dembrane.audio_lightrag.utils.parallel_llm import parallel_llm_calls
from dembrane.audio_lightrag.utils.litellm_utils import get_json_dict_from_audio
from dembrane.audio_lightrag.utils.batch_directus import BatchDirectusWriter
from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker

logger = getLogger("audio_lightrag.pipelines.contextual_chunk_etl_pipeline")


class ContextualChunkETLPipeline:
    def __init__(
        self,
        process_tracker: ProcessTracker,
    ) -> None:
        self.conversation_history_num = AUDIO_LIGHTRAG_CONVERSATION_HISTORY_NUM
        self.process_tracker = process_tracker
        # FIXME: Why do we need this? @Arindam
        self.api_base_url = API_BASE_URL

    def extract(self) -> None:
        pass

    def transform(self) -> None:
        pass

    async def load(self) -> None:
        # Trancribe and contextualize audio chunks with batched Directus writes
        batch_writer = BatchDirectusWriter(auto_flush_size=20)
        
        for conversation_id in self.process_tracker().conversation_id.unique():
            load_tracker = self.process_tracker()[
                self.process_tracker()["conversation_id"] == conversation_id
            ]
            audio_load_tracker = load_tracker[load_tracker.path != "NO_AUDIO_FOUND"]
            segment_li = ",".join(audio_load_tracker.sort_values("timestamp").segment.astype(str)).split(",")
            segment_li = [int(x) for x in list(dict.fromkeys(segment_li)) if x != ""]  # type: ignore
            project_id = self.process_tracker()[
                self.process_tracker()["conversation_id"] == conversation_id
            ].project_id.unique()[0]
            event_text = "\n\n".join(
                [
                    f"{k} : {v}"
                    for k, v in self.process_tracker.get_project_df()
                    .loc[project_id]
                    .to_dict()
                    .items()
                ]
            )
            
            responses = {}

            # Define async function to process a single segment
            async def process_segment(idx_and_segment):
                idx, segment_id = idx_and_segment
                renew_redis_lock(conversation_id)
                try:
                    segment_ids = segment_li[max(0, idx - int(self.conversation_history_num)) : idx]
                    if len(segment_ids) != 0:
                        previous_segments = directus.get_items(
                            "conversation_segment",
                            {
                                "query": {
                                    "fields": ["contextual_transcript"],
                                    "sort": ["id"],
                                    "filter": {
                                        "id": {"_in": segment_ids},
                                    },
                                }
                            },
                        )
                        previous_contextual_transcript_li = [
                            x["contextual_transcript"] for x in previous_segments
                        ]
                    else:
                        previous_contextual_transcript_li = []
                except Exception as e:
                    logger.warning(f"Warning: Error in getting previous segments : {e}")
                    return None

                previous_contextual_transcript = "\n\n".join(previous_contextual_transcript_li)
                audio_model_prompt = Prompts.audio_model_system_prompt(
                    event_text, previous_contextual_transcript
                )
                try:
                    audio_segment_response = directus.get_item(
                        "conversation_segment", int(segment_id)
                    )
                except Exception as e:
                    logger.exception(f"Error in getting conversation segment : {e}")
                    return None
                
                if audio_segment_response["contextual_transcript"] is None:
                    try:
                        # Use safe_audio_decode to handle decoding failures gracefully
                        audio = safe_audio_decode(audio_segment_response["path"], primary_format="wav")
                        
                        if audio is None:
                            logger.warning(
                                f"Failed to decode audio for segment {segment_id}. Skipping..."
                            )
                            return None
                        
                        wav_encoding = wav_to_str(audio)
                        response = get_json_dict_from_audio(
                            wav_encoding=wav_encoding,
                            audio_model_prompt=audio_model_prompt,
                        )
                        # Use batch writer for updates (will be flushed at end of conversation)
                        batch_writer.queue_update(
                            "conversation_segment",
                            int(segment_id),
                            {
                                "transcript": "\n\n".join(response["TRANSCRIPTS"]),
                                "contextual_transcript": response["CONTEXTUAL_TRANSCRIPT"],
                            },
                        )
                        return (segment_id, response)
                    except Exception as e:
                        logger.exception(
                            f"Error in getting contextual transcript : {e}. Segment ID: {segment_id}"
                        )
                        return None
                else:
                    response = {
                        "CONTEXTUAL_TRANSCRIPT": audio_segment_response["contextual_transcript"],
                        "TRANSCRIPTS": audio_segment_response["transcript"].split("\n\n"),
                    }
                    return (segment_id, response)
            
            # Process all segments in parallel with rate limiting
            logger.info(f"Processing {len(segment_li)} segments in parallel (max_concurrent=10)")
            segment_pairs = list(enumerate(segment_li))
            results = await parallel_llm_calls(
                segment_pairs,
                process_segment,
                max_concurrent=10,
                requests_per_minute=1000  # Adjust based on your LLM provider's rate limits
            )
            
            # Collect successful responses
            for result in results:
                if result is not None and not isinstance(result, Exception):
                    segment_id, response = result
                    responses[segment_id] = response
            
            # Insert into LightRAG for all processed segments
            for segment_id in responses.keys():
                renew_redis_lock(conversation_id)
                try:
                    audio_segment_response = directus.get_item(
                        "conversation_segment", int(segment_id)
                    )
                except Exception as e:
                    logger.exception(f"Error in getting conversation segment for LightRAG: {e}")
                    continue
                    
                if audio_segment_response["lightrag_flag"] is not True:
                    try:
                        session = DirectusSession(user_id="none", is_admin=True)
                        if (
                            not responses[segment_id]["TRANSCRIPTS"]
                            or len(responses[segment_id]["TRANSCRIPTS"]) == 0
                            or not responses[segment_id]["CONTEXTUAL_TRANSCRIPT"]
                            or len(responses[segment_id]["CONTEXTUAL_TRANSCRIPT"]) == 0
                        ):
                            logger.info(
                                f"No transcript found for segment {segment_id}. Skipping..."
                            )
                            batch_writer.queue_update(
                                "conversation_segment", int(segment_id), {"lightrag_flag": True}
                            )
                            continue

                        payload = InsertRequest(
                            content=responses[segment_id]["CONTEXTUAL_TRANSCRIPT"],
                            echo_segment_id=str(segment_id),
                            transcripts=responses[segment_id]["TRANSCRIPTS"],
                        )
                        # fake session
                        audio_segment_insert_response = await insert_item(payload, session)

                        if audio_segment_insert_response.status == "success":
                            batch_writer.queue_update(
                                "conversation_segment", int(segment_id), {"lightrag_flag": True}
                            )
                        else:
                            logger.info(
                                f"Error in inserting transcript into LightRAG for segment {segment_id}. Check API health : {audio_segment_response.status_code}"
                            )

                    except Exception as e:
                        logger.exception(f"Error in inserting transcript into LightRAG : {e}")

            non_audio_load_tracker = load_tracker[load_tracker.path == "NO_AUDIO_FOUND"]
            for segment_id in set(non_audio_load_tracker.segment):
                renew_redis_lock(conversation_id)
                non_audio_segment_response = directus.get_item(
                    "conversation_segment", int(segment_id)
                )
                if non_audio_segment_response["lightrag_flag"] is not True:
                    try:
                        session = DirectusSession(user_id="none", is_admin=True)
                        if (
                            not non_audio_segment_response["transcript"]
                            or len(non_audio_segment_response["transcript"]) == 0
                            or not non_audio_segment_response["contextual_transcript"]
                            or len(non_audio_segment_response["contextual_transcript"]) == 0
                        ):
                            logger.info(
                                f"No transcript found for segment {segment_id}. Skipping..."
                            )
                            batch_writer.queue_update(
                                "conversation_segment", int(segment_id), {"lightrag_flag": True}
                            )
                            continue

                        payload = InsertRequest(
                            content=non_audio_segment_response["contextual_transcript"],
                            echo_segment_id=str(segment_id),
                            transcripts=[non_audio_segment_response["transcript"]],
                        )
                        # fake session
                        non_audio_segment_insert_response = await insert_item(payload, session)

                        if non_audio_segment_insert_response.status == "success":
                            batch_writer.queue_update(
                                "conversation_segment", int(segment_id), {"lightrag_flag": True}
                            )
                        else:
                            logger.info(
                                f"Error in inserting transcript into LightRAG for segment {segment_id}. Check API health : {non_audio_segment_response.status_code}"
                            )

                    except Exception as e:
                        logger.exception(f"Error in inserting transcript into LightRAG : {e}")
        
        # Flush all batched writes at the end
        logger.info("Flushing batched Directus writes...")
        batch_writer.flush()
        logger.info("All batched writes completed")

    def run(self) -> None:
        self.extract()
        self.transform()
        # Use a fresh event loop for each task to avoid "Future attached to
        # different loop" errors. This creates a completely isolated async
        # context that won't interfere with other Dramatiq workers or tasks.
        run_async_in_new_loop(self.load())
