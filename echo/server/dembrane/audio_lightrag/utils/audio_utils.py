import io
import os
import base64
from io import BytesIO
from typing import Optional
from logging import getLogger

import pandas as pd
import requests
from pydub import AudioSegment

from dembrane.s3 import (
    save_audio_to_s3,
    get_stream_from_s3,
)
from dembrane.directus import directus
from dembrane.audio_lightrag.utils.s3_cache import get_cached_s3_stream

logger = getLogger(__name__)


def validate_audio_file(chunk_uri: str, min_size_bytes: int = 1000) -> tuple[bool, str]:
    """
    Validate audio file before processing to prevent ffmpeg failures.
    
    This prevents common errors like:
    - FileNotFoundError (404s)
    - FileTooSmallError (incomplete uploads)
    - Decoding failures (corrupted files)
    
    Args:
        chunk_uri: S3 URI of the audio file
        min_size_bytes: Minimum file size in bytes (default 1KB)
        
    Returns:
        tuple: (is_valid, error_message)
        - is_valid: True if file is valid, False otherwise
        - error_message: Empty string if valid, error description if invalid
    """
    try:
        # Check if file exists and get metadata
        response = requests.head(chunk_uri, timeout=5)
        
        if response.status_code == 404:
            return (False, "File not found (404)")
        
        if response.status_code >= 400:
            return (False, f"HTTP error {response.status_code}")
        
        # Check file size when header is available
        content_length_header = response.headers.get("Content-Length")
        if content_length_header:
            try:
                content_length = int(content_length_header)
                if content_length < min_size_bytes:
                    return (
                        False,
                        f"File too small: {content_length} bytes (minimum {min_size_bytes})",
                    )
            except ValueError:
                logger.warning(
                    f"Invalid Content-Length header for {chunk_uri}: {content_length_header}"
                )
        
        # Check content type (some S3 buckets don't set this, so it's optional)
        content_type = response.headers.get("Content-Type", "").lower()
        if content_type and "audio" not in content_type and content_type not in ["application/octet-stream", ""]:
            logger.warning(f"Unexpected content type: {content_type}")
        
        return (True, "")
        
    except requests.exceptions.Timeout:
        return (False, "Request timeout")
    except Exception as e:
        return (False, f"Validation error: {str(e)}")


def safe_audio_decode(
    chunk_uri: str, 
    primary_format: str = "mp3",
    fallback_formats: Optional[list[str]] = None,
    use_cache: bool = True
) -> Optional[AudioSegment]:
    """
    Safely decode audio with fallback formats to handle ffmpeg decoding failures.
    
    This handles errors like:
    - "Decoding failed. ffmpeg returned error"
    - Unsupported codec/format
    - Corrupted audio files
    
    Args:
        chunk_uri: S3 URI of the audio file
        primary_format: Primary format to try first
        fallback_formats: List of fallback formats to try if primary fails
        use_cache: If True, use S3 stream caching to avoid redundant downloads
        
    Returns:
        AudioSegment if successful, None if all formats fail
    """
    if fallback_formats is None:
        fallback_formats = ["wav", "ogg", "mp3", "flac", "m4a"]
    
    # Remove primary format from fallbacks to avoid duplicate attempts
    fallback_formats = [f for f in fallback_formats if f != primary_format]
    
    # Try primary format first (with caching if enabled)
    try:
        if use_cache:
            stream = get_cached_s3_stream(chunk_uri)
        else:
            stream = get_stream_from_s3(chunk_uri)
        
        if stream is None:
            logger.error(f"Failed to download {chunk_uri}")
            return None
            
        audio = AudioSegment.from_file(stream, format=primary_format)
        logger.debug(f"Successfully decoded {chunk_uri} as {primary_format}")
        return audio
        
    except Exception as e:
        logger.warning(f"Failed to decode {chunk_uri} as {primary_format}: {e}")
        
        # Try fallback formats (reuse cached stream if available)
        for fallback_format in fallback_formats:
            try:
                if use_cache:
                    stream = get_cached_s3_stream(chunk_uri)
                else:
                    stream = get_stream_from_s3(chunk_uri)
                
                if stream is None:
                    continue
                    
                audio = AudioSegment.from_file(stream, format=fallback_format)
                logger.info(f"Successfully decoded {chunk_uri} as {fallback_format} (fallback)")
                return audio
                
            except Exception as fallback_error:
                logger.debug(f"Fallback format {fallback_format} also failed: {fallback_error}")
                continue
        
        # All formats failed
        logger.error(f"All decoding formats failed for {chunk_uri}")
        return None


def _read_mp3_from_s3_and_get_wav_file_size(uri: str, format: str = "mp3") -> float:
    """
    Calculate the size of an audio file stored in S3 when converted to WAV format.
    This is useful for estimating the memory usage when loading audio files for processing.

    Args:
        uri (str): The URI of the audio file in S3
        format (str): The format of the stored audio file (default: "mp3")

    Returns:
        float: The size of the audio in WAV format in MB
        
    Raises:
        Exception: If audio file cannot be decoded or size cannot be calculated
    """
    try:
        # Use safe_audio_decode with format fallbacks
        audio = safe_audio_decode(uri, primary_format=format)
        
        if audio is None:
            raise Exception(f"Failed to decode audio file {uri} in any supported format")

        # Export to WAV to calculate uncompressed size
        wav_buffer = io.BytesIO()
        audio.export(wav_buffer, format="wav")

        # Calculate size in MB
        wav_size_mb = len(wav_buffer.getvalue()) / (1024 * 1024)

        return wav_size_mb

    except Exception as e:
        raise Exception(f"Error calculating WAV size for {uri}: {str(e)}") from e


def get_audio_file_size(path: str) -> float:
    size_mb = os.path.getsize(path) / (1024 * 1024)  # Convert bytes to MB
    return size_mb


def wav_to_str(wav_input: AudioSegment) -> str:
    buffer = BytesIO()
    wav_input.export(buffer, format="wav")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def process_audio_files(
    unprocessed_chunk_file_uri_li: list[str],
    max_size_mb: float,
    configid: str,
    counter: int,
    process_tracker_df: pd.DataFrame,
    format: str = "mp3",
) -> tuple[list[str], list[tuple[str, str]], int]:
    """
    Creates segments from chunks in ogg format.
    A segment is maximum mb permitted in the model being used.
    Ensures all files are segmented close to max_size_mb.
    **** File might be a little larger than max_size_mb
    Args:
        unprocessed_chunk_file_uri_li (list[str]):
            List of unprocessed chunk file uris in order of processing
        max_size_mb (float):
            Maximum size of a segment in MB
        configid (str):
            The config id of the segment
        counter (int):
            The counter for the next segment id
        process_tracker_df (pd.DataFrame):
            The process tracker dataframe
        format (str):
            The format of the audio file
    Returns:
        unprocessed_chunk_file_uri_li: list[str]:
            List of unprocessed chunk file uris
        chunk_id_2_segment: list[tuple[str, str]]:
            List of chunk ids and segment ids
        counter: int:
            Counter for the next segment id

    """
    process_tracker_df = process_tracker_df[
        process_tracker_df["path"].isin(unprocessed_chunk_file_uri_li)
    ]
    process_tracker_df = process_tracker_df.sort_values(by="timestamp")
    chunk_id_2_uri = dict(process_tracker_df[["chunk_id", "path"]].values)
    
    # Validate and calculate sizes, skipping invalid files
    chunk_id_2_size = {}
    for chunk_id, uri in chunk_id_2_uri.items():
        # Validate before processing
        is_valid, error_msg = validate_audio_file(uri)
        if not is_valid:
            logger.warning(f"Skipping invalid audio file {chunk_id} ({uri}): {error_msg}")
            continue
        
        try:
            chunk_id_2_size[chunk_id] = _read_mp3_from_s3_and_get_wav_file_size(uri, format)
        except Exception as e:
            logger.error(f"Error calculating size for {chunk_id} ({uri}): {e}")
            continue
    
    # If no valid chunks, return early
    if not chunk_id_2_size:
        logger.warning("No valid audio chunks to process after validation")
        return ([], [], counter)
    chunk_id = list(chunk_id_2_size.keys())[0]
    chunk_id_2_segment: list[tuple[str, str]] = []
    segment_2_path: dict[str, str] = {}
    # One chunk to many segments
    if chunk_id_2_size[chunk_id] > max_size_mb:
        conversation_id = process_tracker_df[process_tracker_df["chunk_id"] == chunk_id].iloc[0][
            "conversation_id"
        ]
        n_sub_chunks = int((chunk_id_2_size[chunk_id] // max_size_mb) + 1)
        audio_stream = get_stream_from_s3(chunk_id_2_uri[chunk_id])
        audio = AudioSegment.from_file(BytesIO(audio_stream.read()), format=format)
        chunk_length = len(audio) // n_sub_chunks
        for i in range(n_sub_chunks):
            segment_id = create_directus_segment(configid, counter, conversation_id)
            chunk_id_2_segment.append((chunk_id, str(segment_id)))
            start_time = i * chunk_length
            end_time = (i + 1) * chunk_length if i != n_sub_chunks - 1 else len(audio)
            chunk = audio[start_time:end_time]
            segment_uri = save_audio_to_s3(
                chunk,
                f"conversation_id/{conversation_id}/segment_id/{str(segment_id)}.wav",
                public=False,
            )
            directus.update_item(
                "conversation_segment",
                item_id=segment_id,
                item_data={"path": segment_uri},
            )
            segment_2_path[str(segment_id)] = segment_uri
            counter += 1
        return unprocessed_chunk_file_uri_li[1:], chunk_id_2_segment, counter
    # Many chunks to one segment
    else:
        processed_chunk_li = []
        combined_size = 0
        combined_audio = AudioSegment.empty()
        conversation_id = process_tracker_df[process_tracker_df["chunk_id"] == chunk_id].iloc[0][
            "conversation_id"
        ]
        segment_id = create_directus_segment(configid, counter, conversation_id)
        for chunk_id, size in chunk_id_2_size.items():
            combined_size = combined_size + size  # type: ignore
            if combined_size <= max_size_mb:
                chunk_id_2_segment.append((chunk_id, str(segment_id)))
                audio_stream = get_stream_from_s3(chunk_id_2_uri[chunk_id])
                audio = AudioSegment.from_file(BytesIO(audio_stream.read()), format=format)
                processed_chunk_li.append(chunk_id)
                combined_audio += audio
        segment_uri = save_audio_to_s3(
            combined_audio,
            f"conversation_id/{conversation_id}/segment_id/{str(segment_id)}.wav",
            public=False,
        )
        segment_2_path[str(segment_id)] = segment_uri
        directus.update_item(
            "conversation_segment",
            item_id=segment_id,
            item_data={"path": segment_uri},
        )
        counter += 1
        return unprocessed_chunk_file_uri_li[len(processed_chunk_li) :], chunk_id_2_segment, counter


def ogg_to_str(ogg_file_path: str) -> str:
    with open(ogg_file_path, "rb") as file:
        return base64.b64encode(file.read()).decode("utf-8")


def create_directus_segment(configid: str, counter: float, conversation_id: str) -> int:
    """
    Create a new segment in Directus.
    
    Args:
        configid (str): The config id to associate with the segment
        counter (float): The counter value for the segment
        conversation_id (str): The conversation id to associate with the segment
        
    Returns:
        int: The id of the created segment
    """
    response = directus.create_item(
        "conversation_segment",
        item_data={
            "config_id": configid,
            "counter": counter,
            "conversation_id": conversation_id,
        },
    )
    directus_id = response["data"]["id"]
    return int(directus_id)

def delete_directus_segment(segment_id: str) -> None:
    directus.delete_item("conversation_segment", segment_id)


def get_conversation_by_segment(conversation_id: str, segment_id: str) -> dict:
    response = directus.read_item(
        "conversation", conversation_id, fields=["*"], filter={"segment": segment_id}
    )
    return response["data"]
