import logging

from dembrane.config import LIGHTRAG_CONFIG_ID, AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB
from dembrane.directus import directus
from dembrane.audio_lightrag.utils.audio_utils import (
    process_audio_files,
    create_directus_segment,
)
from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


class AudioETLPipeline:
    def __init__(self, process_tracker: ProcessTracker) -> None:
        """
        Initialize the AudioETLPipeline.

        Args:
        - process_tracker (ProcessTracker): Instance to track the process.

        Returns:
        - None
        """
        self.process_tracker = process_tracker
        self.process_tracker_df = process_tracker()
        self.max_size_mb = AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB
        self.configid = LIGHTRAG_CONFIG_ID

    def extract(self) -> None:
        pass

    def transform(self) -> None:
        transform_process_tracker_df = self.process_tracker.get_unprocesssed_process_tracker_df(
            "segment"
        )
        transform_audio_process_tracker_df = transform_process_tracker_df[
            transform_process_tracker_df.path != "NO_AUDIO_FOUND"
        ]
        transform_non_audio_process_tracker_df = transform_process_tracker_df[
            transform_process_tracker_df.path == "NO_AUDIO_FOUND"
        ]

        zip_unique_audio = list(
            set(
                zip(
                    transform_audio_process_tracker_df.project_id,
                    transform_audio_process_tracker_df.conversation_id,
                    strict=True,
                )
            )
        )

        # Process audio files
        for project_id, conversation_id in zip_unique_audio:
            unprocessed_chunk_file_uri_li = transform_audio_process_tracker_df.loc[
                (transform_audio_process_tracker_df.project_id == project_id)
                & (transform_audio_process_tracker_df.conversation_id == conversation_id)
            ].path.to_list()
            counter = 0
            chunk_id_2_segment = []
            while len(unprocessed_chunk_file_uri_li) != 0:
                try:
                    logger.info(
                        f"Processing {len(unprocessed_chunk_file_uri_li)} files for project_id={project_id}, conversation_id={conversation_id}"
                    )
                    logger.debug(
                        f"Counter value: {counter}, Max size: {self.max_size_mb}MB, Config ID: {self.configid}"
                    )
                    unprocessed_chunk_file_uri_li, chunk_id_2_segment_temp, counter = (
                        process_audio_files(
                            unprocessed_chunk_file_uri_li,
                            configid=str(self.configid),
                            max_size_mb=float(self.max_size_mb),
                            counter=counter,
                            process_tracker_df=transform_audio_process_tracker_df,
                        )
                    )

                    for chunk_id, segment_id in chunk_id_2_segment_temp:
                        mapping_data = {
                            "conversation_segment_id": segment_id,
                            "conversation_chunk_id": chunk_id,
                        }
                        directus.create_item(
                            "conversation_segment_conversation_chunk", mapping_data
                        )

                    chunk_id_2_segment.extend(chunk_id_2_segment_temp)
                except Exception as e:
                    logger.error(
                        f"Error processing files for project_id={project_id}, conversation_id={conversation_id}: {str(e)}"
                    )
                    raise e

            chunk_id_2_segment_dict: dict[str, list[int]] = {}
            for chunk_id, segment_id in chunk_id_2_segment:
                if chunk_id not in chunk_id_2_segment_dict.keys():
                    chunk_id_2_segment_dict[chunk_id] = [int(segment_id)]
                else:
                    chunk_id_2_segment_dict[chunk_id].append(int(segment_id))
            for chunk_id, segment_id_li in chunk_id_2_segment_dict.items():
                self.process_tracker.update_value_for_chunk_id(
                    chunk_id=chunk_id,
                    column_name="segment",
                    value=",".join([str(segment_id) for segment_id in segment_id_li]),
                )
        # Process non-audio files
        if transform_non_audio_process_tracker_df.empty is not True:
            conversation_id = transform_non_audio_process_tracker_df.conversation_id.iloc[0]
            full_transcript = ""
            segment_id = str(create_directus_segment(self.configid, -1, conversation_id))

            chunk_ids = transform_non_audio_process_tracker_df.chunk_id.to_list()
            chunk_records = directus.get_items(
                "conversation_chunk",
                {
                    "query": {
                        "filter": {"id": {"_in": chunk_ids}},
                        "fields": ["id", "transcript"],
                        "limit": len(chunk_ids),
                    }
                },
            )
            id2transcript = {rec["id"]: rec.get("transcript", "") for rec in chunk_records}
            for chunk_id in chunk_ids:
                transcript = id2transcript.get(chunk_id, "")
                full_transcript += transcript + "\n\n"
                self.process_tracker.update_value_for_chunk_id(
                    chunk_id=chunk_id, column_name="segment", value=segment_id
                )
                mapping_data = {
                    "conversation_segment_id": segment_id,
                    "conversation_chunk_id": chunk_id,
                }
                directus.create_item("conversation_segment_conversation_chunk", mapping_data)

            directus.update_item(
                "conversation_segment",
                segment_id,
                {"transcript": full_transcript, "contextual_transcript": full_transcript},
            )

    def load(self) -> None:
        pass

    def run(self) -> None:
        self.extract()
        self.transform()
        self.load()
