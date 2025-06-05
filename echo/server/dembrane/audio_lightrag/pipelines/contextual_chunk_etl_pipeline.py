import asyncio
from io import BytesIO
from logging import getLogger

from pydub import AudioSegment

from dembrane.s3 import get_stream_from_s3
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
from dembrane.audio_lightrag.utils.audio_utils import wav_to_str
from dembrane.audio_lightrag.utils.litellm_utils import get_json_dict_from_audio
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
        # Trancribe and contextualize audio chunks
        for conversation_id in self.process_tracker().conversation_id.unique():
            load_tracker = self.process_tracker()[
                self.process_tracker()["conversation_id"] == conversation_id
            ]
            audio_load_tracker = load_tracker[load_tracker.path != "NO_AUDIO_FOUND"]
            segment_li = ",".join(audio_load_tracker.sort_values("timestamp").segment).split(",")
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
            for idx, segment_id in enumerate(segment_li):
                previous_contextual_transcript_li = []
                for previous_segment in segment_li[
                    max(0, idx - int(self.conversation_history_num)) : idx
                ]:
                    try:
                        contextual_transcript = directus.get_item(
                            "conversation_segment", int(previous_segment)
                        )["contextual_transcript"]
                        previous_contextual_transcript_li.append(contextual_transcript)
                    except Exception as e:
                        logger.exception(f"Error in getting contextual transcript : {e}")
                        continue
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
                    continue
                audio_stream = get_stream_from_s3(audio_segment_response["path"])
                if audio_segment_response["contextual_transcript"] is None:
                    try:
                        wav_encoding = wav_to_str(
                            AudioSegment.from_file(BytesIO(audio_stream.read()), format="wav")
                        )
                        responses[segment_id] = get_json_dict_from_audio(
                            wav_encoding=wav_encoding,
                            audio_model_prompt=audio_model_prompt,
                        )
                        directus.update_item(
                            "conversation_segment",
                            int(segment_id),
                            {
                                "transcript": "\n\n".join(responses[segment_id]["TRANSCRIPTS"]),
                                "contextual_transcript": responses[segment_id][
                                    "CONTEXTUAL_TRANSCRIPT"
                                ],
                            },
                        )
                    except Exception as e:
                        logger.exception(
                            f"Error in getting contextual transcript : {e}. Check LiteLLM API configs"
                        )
                        continue
                else:
                    responses[segment_id] = {
                        "CONTEXTUAL_TRANSCRIPT": audio_segment_response["contextual_transcript"],
                        "TRANSCRIPTS": audio_segment_response["transcript"].split("\n\n"),
                    }
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
                            directus.update_item(
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
                            directus.update_item(
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
                            directus.update_item(
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
                            directus.update_item(
                                "conversation_segment", int(segment_id), {"lightrag_flag": True}
                            )
                        else:
                            logger.info(
                                f"Error in inserting transcript into LightRAG for segment {segment_id}. Check API health : {non_audio_segment_response.status_code}"
                            )

                    except Exception as e:
                        logger.exception(f"Error in inserting transcript into LightRAG : {e}")

    def run(self) -> None:
        self.extract()
        self.transform()
        # Re-use a long-lived event loop instead of creating and closing a new
        # one for every pipeline run. Creating a fresh event loop each time
        # (as ``asyncio.run`` does) breaks objects such as the asyncpg
        # connection pool that are bound to the loop they were first created
        # on (inside ``LightRAG``).  The pool is then reused from a different
        # loop the next time the ETL pipeline is executed which results in
        # errors like "Task got Future attached to a different loop" or
        # "cannot perform operation: another operation is in progress".
        #
        # We therefore obtain (or create) the global event loop once and keep
        # it alive for the lifetime of the worker process.
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            # No current event loop – create one and set it as the default
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        if loop.is_closed():
            # Should never happen but guard against it – recreate the loop
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        if loop.is_running():
            # If we're somehow already inside an event loop (unlikely in the
            # dramatiq worker context) we schedule the coroutine and wait for
            # it to finish.
            fut = asyncio.run_coroutine_threadsafe(self.load(), loop)
            fut.result()
        else:
            loop.run_until_complete(self.load())
