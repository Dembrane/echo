import logging
from typing import Any, Dict, List, Tuple, Optional

import pandas as pd

from dembrane.config import AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS
from dembrane.directus import directus
from dembrane.processing_status_utils import add_processing_status
from dembrane.audio_lightrag.utils.echo_utils import finish_conversation
from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker

logger = logging.getLogger("dembrane.audio_lightrag.pipelines.directus_etl_pipeline")


class DirectusException(Exception):
    pass


class DirectusETLPipeline:
    """
    A class for extracting, transforming, and loading data from Directus.
    """

    def validate_directus_response(self, response_list: List[Dict[str, Any]]) -> bool:
        if response_list is None or len(response_list) == 0:
            logger.warning("No response from Directus")
            return False
        for response in response_list:
            if "error" in response.keys():
                logger.warning(f"Directus Error: {response['error']}")
                return False
            # Note: Empty chunks (len == 0) is valid - conversation has no data yet
            # We'll handle this gracefully in transform() by returning empty dataframes
        return True

    def __init__(self) -> None:
        # Load environment variables from the .env file
        self.directus = directus
        self.accepted_formats = ["wav", "mp3", "m4a", "ogg"]
        self.project_request = {
            "query": {
                "fields": [
                    "id",
                    "name",
                    "language",
                    "context",
                    "default_conversation_title",
                    "default_conversation_description",
                ],
                "limit": -1,
                "filter": {"id": {"_in": []}},
            }
        }
        self.conversation_request = {
            "query": {
                "fields": ["id", "project_id", "chunks.id", "chunks.path", "chunks.timestamp"],
                "limit": -1,
                "deep": {"chunks": {"_limit": -1, "_sort": "timestamp"}},
            }
        }
        self.segment_request = {
            "query": {
                "fields": ["id", "conversation_segments.conversation_segment_id"],
                "filter": {"id": {"_in": []}},
            }
        }
        # Get all segment id related to a chunk id

    def extract(
        self, conversation_id_list: Optional[List[str]] = None
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Extract data from the 'conversation' and 'project' collections
        from Directus.
        """
        # Request for conversations with their chunks
        if conversation_id_list is not None:
            self.conversation_request["query"]["filter"] = {"id": {"_in": conversation_id_list}}
        else:
            logger.warning("No conversation id list provided, getting all conversations")
            raise DirectusException("No conversation id list provided")
        conversation = self.directus.get_items("conversation", self.conversation_request)
        project_id_list = list(
            set([conversation_request["project_id"] for conversation_request in conversation])
        )
        self.project_request["query"]["filter"] = {"id": {"_in": project_id_list}}
        project = self.directus.get_items("project", self.project_request)
        return conversation, project

    def _safe_extract_chunk_values(self, chunks: Any) -> List[List[Any]]:
        """
        Safely extract chunk values, handling various data types from Directus.
        
        This prevents errors like "string indices must be integers, not 'str'"
        when Directus returns unexpected data formats.
        """
        try:
            # Handle None or empty
            if not chunks:
                return []
            
            # Handle string (sometimes Directus returns serialized JSON)
            if isinstance(chunks, str):
                logger.warning(f"Got string instead of dict for chunks: {chunks[:100]}")
                return []
            
            # Handle list of dicts (expected case)
            if isinstance(chunks, list):
                result = []
                for chunk in chunks:
                    if isinstance(chunk, dict):
                        # Extract values safely
                        result.append(list(chunk.values()))
                    else:
                        logger.warning(f"Skipping non-dict chunk: {type(chunk)}")
                return result
            
            # Unexpected type
            logger.warning(f"Unexpected chunks type: {type(chunks)}")
            return []
            
        except Exception as e:
            logger.error(f"Error extracting chunk values: {e}")
            return []

    def transform(
        self,
        conversations: List[Dict[str, Any]],
        projects: List[Dict[str, Any]],
        run_timestamp: str | None = None,
    ) -> Tuple[pd.DataFrame, pd.DataFrame]:
        """
        Transform the extracted data into structured pandas DataFrames.
        """
        if not (
            self.validate_directus_response(conversations)
            and self.validate_directus_response(projects)
        ):
            logger.error("Directus response validation failed")
            self.directus_failure(conversations)
            raise DirectusException("Directus response validation failed")

        conversation_df = pd.DataFrame(conversations)
        
        # Safe filtering of conversations with chunks
        try:
            conversation_df = conversation_df[
                conversation_df.chunks.apply(lambda x: isinstance(x, list) and len(x) > 0)
            ]
        except Exception as e:
            logger.error(f"Error filtering conversations by chunks: {e}")
            conversation_df = conversation_df[conversation_df.chunks.apply(lambda x: bool(x))]
        
        # Safe extraction of chunk values
        conversation_df["chunks_id_path_ts"] = conversation_df.chunks.apply(
            self._safe_extract_chunk_values
        )
        # Filter out empty chunk lists before exploding
        conversation_df = conversation_df[
            conversation_df["chunks_id_path_ts"].apply(lambda x: len(x) > 0)
        ]
        
        if conversation_df.empty:
            logger.warning("No valid conversations with chunks after filtering")
            # Return empty dataframes but with correct structure
            empty_conv_df = pd.DataFrame(
                columns=["conversation_id", "project_id", "chunk_id", "path", "timestamp", "format", "segment"]
            )
            empty_proj_df = pd.DataFrame(projects)
            if not empty_proj_df.empty:
                empty_proj_df.set_index("id", inplace=True)
            return empty_conv_df, empty_proj_df
        
        conversation_df = conversation_df.explode("chunks_id_path_ts")
        
        try:
            conversation_df[["chunk_id", "path", "timestamp"]] = pd.DataFrame(
                conversation_df["chunks_id_path_ts"].tolist(), index=conversation_df.index
            )
        except Exception as e:
            logger.error(f"Error creating chunk columns: {e}")
            # Try salvaging partial data
            valid_rows = []
            for idx, row in conversation_df.iterrows():
                try:
                    chunk_values = row["chunks_id_path_ts"]
                    if isinstance(chunk_values, list) and len(chunk_values) >= 3:
                        valid_rows.append({
                            "id": row["id"],
                            "project_id": row["project_id"],
                            "chunk_id": chunk_values[0],
                            "path": chunk_values[1],
                            "timestamp": chunk_values[2]
                        })
                except Exception as row_error:
                    logger.debug(f"Skipping row {idx}: {row_error}")
                    continue
            
            if not valid_rows:
                logger.error("Could not salvage any conversation data")
                raise DirectusException("Failed to parse conversation chunks") from e
            
            conversation_df = pd.DataFrame(valid_rows)
            logger.warning(f"Salvaged {len(valid_rows)} rows from {len(conversation_df)} total")
        
        conversation_df = conversation_df.reset_index(drop=True)
        conversation_df = conversation_df[["id", "project_id", "chunk_id", "path", "timestamp"]]
        
        # Safe path handling
        conversation_df.path = conversation_df.path.fillna("NO_AUDIO_FOUND")
        conversation_df.path = conversation_df.path.astype(str)  # Ensure string type
        
        conversation_df["format"] = conversation_df.path.apply(
            lambda x: x.split(".")[-1] if isinstance(x, str) and "." in x else "unknown"
        )
        conversation_df = conversation_df[
            conversation_df.format.isin(self.accepted_formats + ["NO_AUDIO_FOUND"])
        ]
        conversation_df.rename(columns={"id": "conversation_id"}, inplace=True)
        conversation_df = conversation_df.sort_values(
            ["project_id", "conversation_id", "timestamp"]
        )
        project_df = pd.DataFrame(projects)
        project_df.set_index("id", inplace=True)
        chunk_id_list = conversation_df.chunk_id.to_list()
        self.segment_request["query"]["filter"] = {"id": {"_in": chunk_id_list}}
        
        try:
            segment = self.directus.get_items("conversation_chunk", self.segment_request)
        except Exception as e:
            logger.error(f"Error fetching segments from Directus: {e}")
            segment = []
        
        chunk_to_segments = {}
        for chunk in segment:
            try:
                chunk_id = chunk.get("id") if isinstance(chunk, dict) else None
                if not chunk_id:
                    continue
                
                conversation_segments = chunk.get("conversation_segments", [])
                if not isinstance(conversation_segments, list):
                    logger.warning(f"Unexpected conversation_segments type for chunk {chunk_id}: {type(conversation_segments)}")
                    continue
                
                segment_ids = []
                for seg in conversation_segments:
                    if isinstance(seg, dict):
                        seg_id = seg.get("conversation_segment_id")
                        if isinstance(seg_id, int):
                            segment_ids.append(seg_id)
                
                if segment_ids:
                    chunk_to_segments[chunk_id] = [
                        segment_id for segment_id in segment_ids if isinstance(segment_id, int)
                    ]
            except Exception as e:
                logger.warning(f"Error processing chunk {chunk.get('id', 'unknown')}: {e}")
                continue
        
        chunk_to_segments = {
            k: ",".join([str(x) for x in sorted(v)])  # type: ignore
            for k, v in chunk_to_segments.items()
            if len(v) != 0
        }
        conversation_df["segment"] = conversation_df.chunk_id.map(chunk_to_segments)
        if run_timestamp is not None:
            run_timestamp = pd.to_datetime(run_timestamp)  # type: ignore
            # Check diff in timestamp and remove less than 1 min
            conversation_df["timestamp"] = pd.to_datetime(conversation_df["timestamp"])
            # take diff between current_timestamp and timestamp
            timestamp_diff = conversation_df["timestamp"].apply(
                lambda x: (run_timestamp - x).total_seconds()
            )
            conversation_df = conversation_df[
                timestamp_diff > int(AUDIO_LIGHTRAG_COOL_OFF_TIME_SECONDS)
            ]

        if conversation_df.empty:
            logger.warning("No conversation data found")
        if project_df.empty:
            logger.warning("No project data found")

        return conversation_df, project_df

    def load_to_process_tracker(
        self, conversation_df: pd.DataFrame, project_df: pd.DataFrame
    ) -> ProcessTracker:
        """
        Load the transformed data to a process tracker.
        """
        return ProcessTracker(conversation_df, project_df)

    def run(
        self, conversation_id_list: Optional[List[str]] = None, run_timestamp: str | None = None
    ) -> ProcessTracker:
        """Run the full ETL pipeline: extract, transform, and load."""
        conversation, project = self.extract(conversation_id_list=conversation_id_list)
        conversation_df, project_df = self.transform(conversation, project, run_timestamp)
        process_tracker = self.load_to_process_tracker(conversation_df, project_df)
        return process_tracker

    def directus_failure(self, conversations: List[Dict[str, Any]]) -> None:
        for conversation in conversations:
            conversation_id = conversation["id"]
            finish_conversation(conversation_id)
            add_processing_status(
                conversation_id=conversation_id,
                event="directus_etl_pipeline.failed",
                message=f"Directus ETL pipeline failed for conversation due to directus error: {conversation_id}",
            )
