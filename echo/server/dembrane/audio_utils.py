import json
import math
import time
import logging
import subprocess
from typing import List
from datetime import timedelta

import ffmpeg  # type: ignore

from dembrane.s3 import s3_client, delete_from_s3, get_stream_from_s3, get_sanitized_s3_key
from dembrane.utils import generate_uuid
from dembrane.config import STORAGE_S3_BUCKET, STORAGE_S3_ENDPOINT
from dembrane.directus import directus

logger = logging.getLogger("audio_utils")


def get_mime_type_from_file_path(file_path: str) -> str:
    if file_path.endswith(".wav"):
        return "audio/wav"
    elif file_path.endswith(".mp3"):
        return "audio/mp3"
    elif file_path.endswith(".ogg"):
        return "audio/ogg"
    elif file_path.endswith(".flac"):
        return "audio/flac"
    elif file_path.endswith(".webm"):
        return "audio/webm"
    elif file_path.endswith(".opus"):
        return "audio/opus"
    elif file_path.endswith(".m4a"):
        return "audio/m4a"
    elif file_path.endswith(".mp4"):
        return "video/mp4"
    elif file_path.endswith(".mpeg"):
        return "video/mpeg"
    else:
        raise ValueError(f"Unsupported file type: {file_path}")


class ConversionError(Exception):
    pass


class FFmpegError(Exception):
    """Custom exception for FFmpeg processing errors"""

    pass


# Update presets with AWS recommended settings
presets: dict[str, dict[str, str | int | None]] = {
    "to_mp3_high": {
        "f": "mp3",
        "acodec": "libmp3lame",
        "ab": "320k",  # High quality bitrate
        "ar": "44100",  # Standard sample rate
        "ac": "2",  # Stereo
    },
    "to_mp3_voice": {
        "f": "mp3",
        "acodec": "libmp3lame",
        "ab": "128k",  # Good enough for voice
        "ar": "22050",  # Lower sample rate for voice
        "ac": "1",  # Mono for voice
    },
    "to_ogg_voice": {
        "f": "ogg",
        "acodec": "libvorbis",
        "ab": "128k",  # Bitrate
        "ar": "22050",  # Sample rate
        "ac": "1",  # Mono
        "aq": "4",  # Quality level for vorbis (0-10)
        "compression_level": "10",  # Compression level
        "application": "voip",  # Optimize for voice
    },
    "to_wav_pcm": {
        "f": "wav",
        "acodec": "pcm_s16le",  # Standard PCM format
        "ar": "16000",  # Common for speech recognition
        "ac": "1",  # Mono
    },
    "compress_audio": {
        "f": "mp3",
        "acodec": "libmp3lame",
        "ab": "96k",  # Lower bitrate for compression
        "ar": "44100",
        "ac": "2",
        "compression_level": "5",  # Higher compression
    },
    "extract_audio": {
        "f": "mp3",
        "acodec": "libmp3lame",
        "vn": None,  # Remove video stream
        "ab": "192k",
        "ar": "44100",
        "ac": "2",
    },
    "fix_audio_sync": {
        "f": "mp3",
        "acodec": "libmp3lame",
        "af": "aresample=async=1:first_pts=0",  # Fix common UGC sync issues
        "ab": "192k",
        "ar": "44100",
        "ac": "2",
    },
    "fix_video_audio_sync": {
        "f": "mpegts",  # AWS recommended format for piping
        "c:v": "copy",  # Copy video stream as-is
        "af": "aresample=async=1:first_pts=0",  # Fix audio sync
        "acodec": "aac",
    },
    "normalize_audio": {
        "f": "mp3",
        "acodec": "libmp3lame",
        "af": "loudnorm",  # Normalize audio levels
        "ab": "192k",
        "ar": "44100",
        "ac": "2",
    },
}


def process_and_save_to_s3(
    input_file_name: str,
    output_file_name: str,
    preset_name: str,
    public: bool = False,
    max_size_mb: int = 2000,
    delete_original: bool = False,
) -> str:
    """Process a file from S3 through ffmpeg and save result back to S3.

    Args:
        input_file_name: Source file name in S3
        output_file_name: Destination file name in S3
        preset_name: Preset name from presets dictionary
        public: Whether the output file should be public
        max_size_mb: Maximum file size in MB to process
        delete_original: Whether to delete the original file after processing

    Returns:
        str: Public URL of the processed file

    Raises:
        FFmpegError: For FFmpeg-specific errors
        ValueError: For input validation errors
        Exception: For other processing errors
    """
    try:
        # Check file size before processing
        response = s3_client.head_object(
            Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(input_file_name)
        )
        file_size_mb = response["ContentLength"] / (1024 * 1024)

        # AWS recommendation: 2x file size + 140MB overhead
        estimated_memory_mb = (file_size_mb * 2) + 140

        if file_size_mb > max_size_mb:
            logger.warning(
                f"File size {file_size_mb:.1f}MB exceeds limit of {max_size_mb}MB. "
                f"Estimated memory required: {estimated_memory_mb:.1f}MB"
            )

        # less than 5kb
        if response["ContentLength"] < 5 * 1024:
            logger.warning(f"File size {response['ContentLength']} bytes is too small to process")
            return input_file_name

        # Log start of processing
        logger.info(f"Starting FFmpeg processing for {input_file_name}")
        start_time = time.time()

        # Get input stream from S3
        input_stream = get_stream_from_s3(input_file_name)

        # Process through ffmpeg
        process = (
            ffmpeg.input("pipe:0")
            .output("pipe:1", **presets[preset_name])
            .overwrite_output()
            .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
        )

        output, err = process.communicate(input=input_stream.read())

        if process.returncode != 0:
            error_message = err.decode() if err else "Unknown FFmpeg error"
            if "No such file or directory" in error_message:
                raise FFmpegError(f"Input file not found: {input_file_name}")
            elif "Invalid data found when processing input" in error_message:
                raise FFmpegError("Invalid or corrupted input file")
            elif "Memory allocation error" in error_message:
                raise FFmpegError(
                    f"Memory allocation failed - file too large. "
                    f"Required memory: {estimated_memory_mb:.1f}MB"
                )
            else:
                raise FFmpegError(f"FFmpeg processing failed: {error_message}")

        # Save to S3
        s3_client.put_object(
            Bucket=STORAGE_S3_BUCKET,
            Key=get_sanitized_s3_key(output_file_name),
            Body=output,
            ACL="public-read" if public else "private",
        )

        duration = time.time() - start_time
        logger.info(
            f"Completed processing {input_file_name} in {duration:.2f}s. "
            f"Input size: {file_size_mb:.1f}MB"
        )

        if delete_original:
            delete_from_s3(input_file_name)

        public_url = f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{output_file_name}"
        return public_url

    except Exception as e:
        logger.error(f"FFmpeg processing failed for {input_file_name}: {str(e)}")
        raise


def merge_multiple_audio_files_and_save_to_s3(
    input_file_names: List[str],
    output_file_name: str,
    public: bool = False,
    max_size_mb: int = 2000,
) -> str:
    """Merge multiple audio files and save the result back to S3.

    Args:
        input_file_names: List of input file names in S3
        output_file_name: Destination file name in S3
        public: Whether the output file should be public
        max_size_mb: Maximum file size in MB to process

    Returns:
        str: Public URL of the processed file

    Raises:
        FFmpegError: For FFmpeg-specific errors
        ValueError: For input validation errors
        Exception: For other processing errors
    """
    try:
        if not input_file_names:
            raise ValueError("No input files provided")

        # Log start of processing
        logger.info(f"Starting audio merge for {len(input_file_names)} files")
        start_time = time.time()

        # Check total size of all input files and load data
        total_size_mb = 0
        file_data = []

        for file_name in input_file_names:
            response = s3_client.head_object(
                Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(file_name)
            )
            file_size_mb = response["ContentLength"] / (1024 * 1024)
            total_size_mb += file_size_mb

            # Get stream from S3 and read into memory
            input_stream = get_stream_from_s3(file_name)
            file_data.append(input_stream.read())

        # AWS recommendation: 2x file size + 140MB overhead
        estimated_memory_mb = (total_size_mb * 2) + 140

        if total_size_mb > max_size_mb:
            logger.warning(
                f"Total file size {total_size_mb:.1f}MB exceeds limit of {max_size_mb}MB. "
                f"Estimated memory required: {estimated_memory_mb:.1f}MB"
            )

        # Process each file - probe format and convert if needed
        processed_data = []
        for i, data in enumerate(file_data):
            # Probe file to determine format
            try:
                probe_result = probe_from_bytes(data)

                # Check if format is OGG
                is_ogg = False
                if "format" in probe_result:
                    format_name = probe_result["format"].get("format_name", "").lower()
                    if "ogg" in format_name:
                        is_ogg = True
                        logger.info(f"File {input_file_names[i]} is already in OGG format")

                if not is_ogg:
                    logger.warning(f"File {input_file_names[i]} is not in OGG format, converting")
                    # Convert to OGG
                    process = (
                        ffmpeg.input("pipe:0")
                        .output("pipe:1", **presets["to_ogg_voice"])
                        .overwrite_output()
                        .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
                    )
                    stdout, stderr = process.communicate(input=data)

                    if process.returncode != 0:
                        error_message = stderr.decode() if stderr else "Unknown FFmpeg error"
                        raise FFmpegError(f"FFmpeg conversion failed: {error_message}")

                    processed_data.append(stdout)
                else:
                    # Already OGG, use as-is
                    processed_data.append(data)

            except Exception as e:
                logger.warning(
                    f"Error probing file {input_file_names[i]}: {str(e)}. Falling back to conversion."
                )
                # Fall back to conversion if probe fails
                process = (
                    ffmpeg.input("pipe:0")
                    .output("pipe:1", **presets["to_ogg_voice"])
                    .overwrite_output()
                    .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
                )
                stdout, stderr = process.communicate(input=data)

                if process.returncode != 0:
                    error_message = stderr.decode() if stderr else "Unknown FFmpeg error"
                    raise FFmpegError(f"FFmpeg conversion failed: {error_message}") from e

                processed_data.append(stdout)

        # Combine all processed files
        merged_data = bytearray()
        for data in processed_data:
            merged_data.extend(data)

        # Final processing to ensure consistent output
        process = (
            ffmpeg.input("pipe:0", format="ogg")
            .output("pipe:1", **presets["to_ogg_voice"])
            .overwrite_output()
            .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
        )

        output, err = process.communicate(input=bytes(merged_data))

        if process.returncode != 0:
            error_message = err.decode() if err else "Unknown FFmpeg error"
            raise FFmpegError(f"FFmpeg final processing failed: {error_message}")

        if not output_file_name.endswith(".ogg"):
            output_file_name = f"{output_file_name}.ogg"

        # Save to S3
        logger.info(
            f"Saving merged audio to S3 as {output_file_name}, acl: {'public-read' if public else 'private'}"
        )
        s3_client.put_object(
            Bucket=STORAGE_S3_BUCKET,
            Key=get_sanitized_s3_key(output_file_name),
            Body=output,
            ACL="public-read" if public else "private",
        )

        try:
            # get head object from S3 to test if it was saved correctly
            info = s3_client.head_object(
                Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(output_file_name)
            )
            logger.info(f"Head object from S3: {info}")
        except Exception as e:
            logger.error(f"Error getting head object from S3: {e}")
            raise e

        duration = time.time() - start_time
        logger.info(
            f"Completed merging {len(input_file_names)} files in {duration:.2f}s. "
            f"Total input size: {total_size_mb:.1f}MB"
        )

        public_url = f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{output_file_name}"
        return public_url

    except Exception as e:
        logger.error(f"Audio merge failed: {str(e)}")
        raise


MAX_CHUNK_SIZE = 20 * 1024 * 1024  # 20MB


def probe_from_bytes(file_bytes: bytes, input_format: str = "ogg") -> dict:
    # Build the ffprobe command using ffmpeg-python so it remains consistent.
    # Generate the command, then replace the executable with "ffprobe".
    cmd = (
        ffmpeg.input("pipe:0", format=input_format)
        .output("pipe:1", f="null")
        .global_args(
            "-hide_banner",
            "-loglevel",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        )
        .compile()
    )
    cmd[0] = "ffprobe"  # Replace with ffprobe
    process = subprocess.run(cmd, input=file_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if process.returncode != 0:
        error = process.stderr.decode().strip() or "Unknown error"
        raise Exception(f"ffprobe error: {error}")
    return json.loads(process.stdout.decode())


def split_audio_chunk(original_chunk_id: str) -> List[str]:
    logger = logging.getLogger("audio_utils.pre_process_audio")

    # Retrieve the original chunk details from Directus.
    original_chunks = directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"id": {"_eq": original_chunk_id}},
                "fields": [
                    "id",
                    "path",
                    "conversation_id",
                    "created_at",
                    "updated_at",
                    "timestamp",
                ],
            }
        },
    )
    if not original_chunks:
        logger.error(f"Chunk not found: {original_chunk_id}")
        raise ValueError(f"Chunk not found: {original_chunk_id}")
    original_chunk = original_chunks[0]

    logger.info(f"Processing chunk: {original_chunk['id']}")
    if not original_chunk["path"]:
        raise FileNotFoundError("File path is not found")

    # Convert file to ogg using the standard preset.
    try:
        chunk_file_format = original_chunk["path"].split(".")[-1].lower()
        logger.info(f"Input file format: {chunk_file_format}")
        updated_chunk_path = original_chunk["path"].replace(chunk_file_format, "ogg")
        logger.info("Converting file to OGG format using process_and_save_to_s3")
        process_and_save_to_s3(
            original_chunk["path"],
            updated_chunk_path,
            "to_ogg_voice",
            public=False,
            delete_original=False,
        )
        logger.info("Updating Directus with new file path")
        directus.update_item(
            collection_name="conversation_chunk",
            item_id=original_chunk["id"],
            item_data={"path": updated_chunk_path},
        )
    except Exception as e:
        logger.error(f"Error during conversion to OGG: {e}")
        raise e

    # Get file size from S3 with the updated file.
    try:
        s3_key = get_sanitized_s3_key(updated_chunk_path)
        logger.info(f"S3 key: {s3_key}")
        logger.info(f"Storage S3 Bucket: {STORAGE_S3_BUCKET}")
        logger.info("attempting to get file size from S3 for")
        response = s3_client.head_object(Bucket=STORAGE_S3_BUCKET, Key=s3_key)
        file_size = response["ContentLength"]
        logger.info(f"Converted file size from S3: {file_size} bytes")
    except Exception as e:
        logger.error(f"Error fetching file size from S3: {e}")
        raise e

    # If the file is too small, do not attempt splitting.
    if file_size < 5 * 1024:
        logger.info("File size too small to split. Returning single chunk.")
        return [original_chunk["id"]]

    # Calculate number of chunks based on MAX_CHUNK_SIZE (default 20 MB).
    number_chunks = math.ceil(file_size / MAX_CHUNK_SIZE)
    logger.info(f"Number of chunks to split into: {number_chunks}")

    if number_chunks == 1:
        logger.info("Single chunk file. No splitting necessary.")
        return [original_chunk["id"]]

    # Download the converted file fully into memory.
    try:
        logger.info("Downloading converted file from S3 into memory for probing.")
        stream = get_stream_from_s3(updated_chunk_path)
        file_bytes = stream.read()
    except Exception as e:
        logger.error(f"Error downloading file from S3: {e}")
        raise e

    # Use ffmpeg-python helper to probe the file (in OGG format).
    try:
        probe_data = probe_from_bytes(file_bytes, input_format="ogg")
        if "format" in probe_data and "duration" in probe_data["format"]:
            duration = float(probe_data["format"]["duration"])
            chunk_duration = duration / number_chunks
            logger.info(f"Total duration: {duration}s, Each chunk duration: {chunk_duration}s")
        else:
            raise ValueError("Duration not found in ffprobe output")
    except Exception as e:
        logger.error(f"Error during ffprobe processing: {e}")
        raise e

    # Split the file into chunks (all in OGG format) without writing to disk.
    split_chunk_items = []  # List of dictionaries representing new Directus items.
    new_chunk_ids = []  # List of new chunk IDs.
    for i in range(number_chunks):
        start_time = i * chunk_duration
        chunk_id = generate_uuid()
        # Define S3 path with .ogg extension.
        s3_chunk_path = (
            f"chunks/{original_chunk['conversation_id']}/{chunk_id}_{i}-of-{number_chunks}.ogg"
        )
        logger.info(f"Extracting chunk {i+1}/{number_chunks} starting at {start_time}s")

        try:
            process = (
                ffmpeg.input("pipe:0")
                .output("pipe:1", ss=start_time, t=chunk_duration, f="ogg")
                .overwrite_output()
                .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
            )
            chunk_output, err = process.communicate(input=file_bytes)
            if process.returncode != 0:
                raise FFmpegError(f"ffmpeg splitting failed: {err.decode().strip()}")
        except ffmpeg.Error as e:
            logger.error(f"ffmpeg error during splitting at chunk {i}: {e.stderr.decode()}")
            raise e

        try:
            s3_client.put_object(
                Bucket=STORAGE_S3_BUCKET,
                Key=s3_chunk_path,
                Body=chunk_output,
                ACL="private",
            )
        except Exception as e:
            logger.error(f"Error uploading chunk {i} to S3: {e}")
            raise e

        # Create a new item as a dictionary.
        new_item = {
            "id": chunk_id,
            "conversation_id": original_chunk["conversation_id"],
            "created_at": (
                original_chunk["created_at"] + timedelta(seconds=start_time)
            ).isoformat(),
            "updated_at": (
                original_chunk["updated_at"] + timedelta(seconds=start_time)
            ).isoformat(),
            "timestamp": (original_chunk["timestamp"] + timedelta(seconds=start_time)).isoformat(),
            "path": s3_chunk_path,
        }
        split_chunk_items.append(new_item)
        new_chunk_ids.append(chunk_id)

    # Create the new split chunk items in Directus and delete the original chunk.
    try:
        directus.create_items("conversation_chunk", split_chunk_items)
        logger.info("Created split chunks in Directus.")
        directus.delete_item("conversation_chunk", original_chunk["id"])
        logger.info("Deleted original chunk from Directus after splitting.")
    except Exception as e:
        logger.error(f"Error updating Directus with split chunks: {e}")
        raise e

    logger.info(f"Successfully split file into {number_chunks} chunks.")
    return new_chunk_ids
