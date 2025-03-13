import os
import logging

# import yaml
from dembrane.config import (
    AUDIO_LIGHTRAG_SEGMENT_DIR,
    AUDIO_LIGHTRAG_DOWNLOAD_DIR,
    AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB,
)
from dembrane.audio_lightrag.utils.audio_utils import (
    process_ogg_files,
    process_wav_files,
    download_chunk_audio_file_as_wav,
)
from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker


class AudioETLPipeline:
    def __init__(
        self,
        process_tracker: ProcessTracker,
        # config_path: str = "server/dembrane/audio_lightrag/configs/audio_etl_pipeline_config.yaml",
        # config_path: str = os.path.join(BASE_DIR, "dembrane/audio_lightrag/configs/audio_etl_pipeline_config.yaml"),
    ) -> None:
        """
        Initialize the AudioETLPipeline.

        Args:
        - process_tracker (ProcessTracker): Instance to track the process.
        - config_path (str): Path to the configuration file.

        Returns:
        - None
        """
        self.process_tracker = process_tracker
        self.process_tracker_df = process_tracker()
        # self.config = self.load_config(config_path)
        self.download_root_dir = AUDIO_LIGHTRAG_DOWNLOAD_DIR
        self.segment_root_dir = AUDIO_LIGHTRAG_SEGMENT_DIR
        self.max_size_mb = AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB

    def extract(self) -> None: pass
        # # Get unique project and conversation IDs
        # zip_unique = list(
        #     set(zip(self.process_tracker_df.project_id, self.process_tracker_df.conversation_id))
        # )

        # for project_id, conversation_id in zip_unique:
        #     # Get unique chunk IDs for each project and conversation
        #     chunk_li = self.process_tracker_df.loc[
        #         (self.process_tracker_df.project_id == project_id)
        #         & (self.process_tracker_df.conversation_id == conversation_id)
        #     ].chunk_id.unique()



        #     for chunk_id in chunk_li:
        #         file_extension = self.process_tracker()[
        #             self.process_tracker().chunk_id == chunk_id
        #         ].format.unique()[0]

        #         # Download audio file for each chunk as a WAV file
        #         download_file_path = 

        #         if file_extension == "mp4":
        #             pass  # TODO: implement mp4 to wav

        #         # Update process tracker with download status
        #         if download_file_path is not None:
        #             self.process_tracker.update_download_status(conversation_id, chunk_id, "pass")
        #         else:
        #             self.process_tracker.update_download_status(conversation_id, chunk_id, "fail")

    def transform(self) -> None:
        transform_process_tracker_df = self.process_tracker_df[
            (self.process_tracker_df.segment.isna() == True)
        ]
        zip_unique = list(
            set(
                zip(
                    transform_process_tracker_df.project_id,
                    transform_process_tracker_df.conversation_id,
                    strict=True
                )
            )
        )
        for project_id, conversation_id in zip_unique:
            unprocessed_chunk_file_path_li = transform_process_tracker_df.loc[
                (transform_process_tracker_df.project_id == project_id)
                & (transform_process_tracker_df.conversation_id == conversation_id)
            ].path.to_list()
            counter = (
                max(
                    -1,
                    self.process_tracker_df[
                        self.process_tracker_df.conversation_id == conversation_id
                    ].segment.max(),
                )
                + 1
            )
            while len(unprocessed_chunk_file_path_li) != 0:
                state_chunk_file_path_li = unprocessed_chunk_file_path_li
                output_filepath = os.path.join(
                    self.segment_root_dir, conversation_id + "_" + str(counter) + ".ogg"
                )
                unprocessed_chunk_file_path_li = process_ogg_files(
                    unprocessed_chunk_file_path_li,
                    output_filepath,
                    max_size_mb=float(self.max_size_mb),
                    counter=counter,
                    conversation_id=conversation_id,
                )
                processed_chunk_file_path_li = [
                    x for x in state_chunk_file_path_li if x not in unprocessed_chunk_file_path_li
                ]
                # No processed chunk file case
                if len(processed_chunk_file_path_li) == 0:
                    error_file = unprocessed_chunk_file_path_li[0]
                    segment_dict = {error_file.split("/")[-1][37:73]: -1}
                    unprocessed_chunk_file_path_li = unprocessed_chunk_file_path_li[1:]
                    self.process_tracker.update_segment(segment_dict)
                    logging.error(f"Error processing ogg file: {error_file}")
                else:
                    segment_dict = {
                        file_path.split('/')[-1][37:73]: counter
                        for file_path in processed_chunk_file_path_li
                    }  # chunk to counter
                    self.process_tracker.update_segment(segment_dict)
                    counter = counter + 1

    def load(self) -> None:
        pass

    def run(self) -> None:
        self.extract()
        self.transform()
        self.load()


# if __name__ == "__main__":
#     import pandas as pd
#     from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker
#     process_tracker = ProcessTracker(pd.read_csv(
#         'server/dembrane/audio_lightrag/data/directus_etl_data/sample_conversation.csv'))
#     pipeline = AudioETLPipeline(process_tracker)
#     pipeline.run()
