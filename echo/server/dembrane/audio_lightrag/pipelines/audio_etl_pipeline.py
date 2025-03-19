
from dembrane.config import (
    AUDIO_LIGHTRAG_SEGMENT_DIR,
    AUDIO_LIGHTRAG_DOWNLOAD_DIR,
    AUDIO_LIGHTRAG_MAX_AUDIO_FILE_SIZE_MB,
)
from dembrane.directus import directus
from dembrane.audio_lightrag.utils.audio_utils import (
    process_ogg_files,
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
        self.configid = f'{float(self.max_size_mb):.4f}mb'

    def extract(self) -> None: pass

    def transform(self) -> None:
        transform_process_tracker_df = self.process_tracker.get_unprocesssed_process_tracker_df(
            'segment')
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
            unprocessed_chunk_file_uri_li = transform_process_tracker_df.loc[
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
            # Create a new segment by counter every loop
            chunk_id_2_segment = []
            while len(unprocessed_chunk_file_uri_li) != 0:
                unprocessed_chunk_file_uri_li, chunk_id_2_segment_temp, counter = process_ogg_files(
                    unprocessed_chunk_file_uri_li,
                    configid=self.configid,
                    max_size_mb=float(self.max_size_mb),
                    counter=counter,
                )
                # Update the conversation_segment with the chunk_id in directus
                [directus.update_item("conversation_segment", segment_id, item_data={"chunks": [
                    {"conversation_chunk_id": chunk_id}
                    ]}) for chunk_id, segment_id in chunk_id_2_segment_temp]

                chunk_id_2_segment.extend(chunk_id_2_segment_temp)
                
            chunk_id_2_segment_dict: dict[str, list[int]] = {}
            # Please make a dictionary of chunk_id to list of segment_id
            for chunk_id, segment_id in chunk_id_2_segment:
                if chunk_id not in chunk_id_2_segment_dict.keys():
                    chunk_id_2_segment_dict[chunk_id] = [int(segment_id)]
                else:
                    chunk_id_2_segment_dict[chunk_id].append(int(segment_id))
            for chunk_id, segment_id_li in chunk_id_2_segment_dict.items():
                self.process_tracker.update_value_for_chunk_id(
                    chunk_id=chunk_id,
                    column_name='segment',
                    value=','.join([str(segment_id) for segment_id in segment_id_li])
                )

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
