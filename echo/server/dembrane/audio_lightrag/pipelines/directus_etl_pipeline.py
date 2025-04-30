import logging
from typing import Any, Dict, List, Tuple, Optional

import pandas as pd
from dotenv import load_dotenv

from dembrane.config import AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS
from dembrane.directus import directus
from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker

logger = logging.getLogger("dembrane.audio_lightrag.pipelines.directus_etl_pipeline")


class DirectusETLPipeline:
    """
    A class for extracting, transforming, and loading data from Directus.
    """
    def __init__(self) -> None:
        # Load environment variables from the .env file
        load_dotenv()
        self.directus = directus
        self.accepted_formats = ['wav', 'mp3', 'm4a', 'ogg']
        self.project_request = {"query": {"fields": 
                                                ["id", "name", "language", "context", 
                                                "default_conversation_title", 
                                                "default_conversation_description"], 
                                           "limit": 100000,
                                           "filter": {"id": {"_in": []}}}}
        self.conversation_request = {"query": 
                                     {"fields": ["id", "project_id", 
                                                 "chunks.id", "chunks.path", 
                                                 "chunks.timestamp"], 
                                           "limit": 100000,
                                           "deep": {"chunks": 
                                                    {"_limit": 100000, "_sort": "timestamp"}
                                                    }
                                                }
                                    }
        self.segment_request = {"query": {
                    "fields": 
                        ["id", "conversation_segments.conversation_segment_id"],
                    "filter": {
                        "id": {
                            "_in": []
                        }
                    }
                }
            }
        # Get all segment id related to a chunk id

    def extract(self, conversation_id_list: Optional[List[str]] = None) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Extract data from the 'conversation' and 'project' collections
        from Directus.
        """
        # Request for conversations with their chunks
        if conversation_id_list is not None:
            self.conversation_request['query']['filter'] = {'id': {'_in': conversation_id_list}}
        conversation = self.directus.get_items("conversation", self.conversation_request)
        project_id_list = list(set([conversation_request['project_id'] for conversation_request in conversation]))
        self.project_request['query']['filter'] = {'id': {'_in': project_id_list}}
        project = self.directus.get_items("project", self.project_request)
        return conversation, project

    def transform(self, conversation: List[Dict[str, Any]], 
                  project: List[Dict[str, Any]], 
                  run_timestamp: str | None = None) -> Tuple[pd.DataFrame, pd.DataFrame]:
        """
        Transform the extracted data into structured pandas DataFrames.
        """
        conversation_df = pd.DataFrame(conversation)
        conversation_df = conversation_df[conversation_df.chunks.apply(lambda x: len(x) != 0)]
        conversation_df['chunks_id_path_ts'] = conversation_df.chunks.apply(
            lambda chunks: [list(chunk.values()) for chunk in chunks]
        )
        conversation_df = conversation_df.explode('chunks_id_path_ts')
        conversation_df[['chunk_id', 'path', 'timestamp']] = pd.DataFrame(
            conversation_df['chunks_id_path_ts'].tolist(), index=conversation_df.index
        )
        conversation_df = conversation_df.reset_index(drop=True)
        conversation_df = conversation_df[['id', 'project_id', 'chunk_id', 'path', 'timestamp']]
        conversation_df.path = conversation_df.path.fillna('NO_AUDIO_FOUND')
        conversation_df['format'] = conversation_df.path.apply(lambda x: x.split('.')[-1])
        conversation_df = conversation_df[conversation_df.format.isin(self.accepted_formats + ['NO_AUDIO_FOUND'])]
        conversation_df.rename(columns = {"id": "conversation_id"}, inplace=True)
        conversation_df = conversation_df.sort_values(['project_id', 'conversation_id', 'timestamp'])
        project_df = pd.DataFrame(project)
        project_df.set_index('id', inplace=True)
        chunk_id_list = conversation_df.chunk_id.to_list()
        self.segment_request['query']['filter'] = {'id': {'_in': chunk_id_list}}
        segment = self.directus.get_items("conversation_chunk", self.segment_request)
        chunk_to_segments = {}
        for chunk in segment:
            chunk_id = chunk['id']
            segment_ids = [segment['conversation_segment_id'] for segment in chunk.get('conversation_segments')]
            chunk_to_segments[chunk_id] = [segment_id for segment_id in segment_ids if isinstance(segment_id, int)]
        chunk_to_segments = {k:','.join([str(x) for x in sorted(v)]) for k,v in chunk_to_segments.items() if len(v)!=0} # type: ignore
        conversation_df['segment'] = conversation_df.chunk_id.map(chunk_to_segments)
        if run_timestamp is not None:
            run_timestamp = pd.to_datetime(run_timestamp) # type: ignore
            # Check diff in timestamp and remove less than 1 min
            conversation_df['timestamp'] = pd.to_datetime(conversation_df['timestamp'])
            # take diff between current_timestamp and timestamp
            timestamp_diff = conversation_df['timestamp'].apply(lambda x: (run_timestamp - x).total_seconds())
            conversation_df = conversation_df[timestamp_diff > int(AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS)]

        if conversation_df.empty:
            logger.warning("No conversation data found")
        if project_df.empty:
            logger.warning("No project data found")
        
        return conversation_df, project_df

    def load_to_process_tracker(self, 
                                conversation_df: pd.DataFrame, 
                                project_df: pd.DataFrame) -> ProcessTracker:
        """
        Load the transformed data to a process tracker.
        """
        return ProcessTracker(conversation_df, project_df)

    def run(self, 
            conversation_id_list: Optional[List[str]] = None, 
            run_timestamp: str | None = None ) -> ProcessTracker:
        """Run the full ETL pipeline: extract, transform, and load."""
        conversation, project = self.extract(conversation_id_list=conversation_id_list)
        conversation_df, project_df = self.transform(conversation, project, run_timestamp)
        process_tracker = self.load_to_process_tracker(conversation_df, project_df)
        return process_tracker
