import os
import json
import math
import time
import logging
import datetime
import tempfile
import subprocess
from typing import List
from datetime import timedelta

import ffmpeg

from dembrane.s3 import s3_client, delete_from_s3, get_stream_from_s3, get_sanitized_s3_key
from dembrane.utils import generate_uuid
from dembrane.settings import get_settings
from dembrane.service import conversation_service
from dembrane.directus import directus

logger = logging.getLogger("audio_utils")


def sanitize_filename_component(val: str) -> str:
    # Only allow alphanumeric, dash, and underscore. Remove other chars.
    return "".join(c for c in val if c.isalnum() or c in ("-", "_"))


ACCEPTED_AUDIO_FORMATS = ["aac", "wav", "mp3", "ogg", "flac", "webm", "opus", "m4a", "mp4", "mpeg"]

FFPROBE_FORMAT_MAP = {
    "aac": "aac",
    "wav": "wav",
    "mp3": "mp3",
    "ogg": "ogg",
    "flac": "flac",
    "webm": "webm",
    "opus": "opus",
    "m4a": "m4a",
    "mp4": "mp4",
    "mpeg": "mpeg",
}


def get_file_format_from_file_path(file_path: str) -> str:
    extension = file_path.lower().split(".")[-1].split("?")[0]
    if extension in ACCEPTED_AUDIO_FORMATS:
        return extension
    else:
        raise ValueError(f"Unsupported file type: {file_path}")


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


class FileTooLargeError(Exception):
    """Custom exception for files that are too large to process"""

    pass


class FileTooSmallError(Exception):
    """Custom exception for files that are too small to process"""

    pass


settings = get_settings()
STORAGE_S3_BUCKET = settings.storage.bucket
STORAGE_S3_ENDPOINT = settings.storage.endpoint


def convert_and_save_to_s3(
    input_file_name: str,
    output_file_name: str,
    output_format: str,
    max_size_mb: int = 1000,
    delete_original: bool = False,
) -> str:
    """Process a file from S3 through ffmpeg and save result back to S3.
    The file is converted to OGG format.

    Args:
        input_file_name: Source file name in S3
        output_file_name: Destination file name in S3
        output_format: Format to convert to (default: ogg)
        max_size_mb: Maximum file size in MB to process
        delete_original: Whether to delete the original file after processing

    Returns:
        str: Public URL of the processed file

    Raises:
        FFmpegError: For FFmpeg-specific errors
        ValueError: For input validation errors
        Exception: For other processing errors
    """
    inferred_output_file_format = get_file_format_from_file_path(output_file_name)
    if inferred_output_file_format != output_format:
        raise ValueError(
            f"Output file format {output_format} does not match requested output file format {inferred_output_file_format}"
        )

    # Check file size before processing
    response = s3_client.head_object(
        Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(input_file_name)
    )
    file_size_mb = response["ContentLength"] / (1024 * 1024)

    # raise if the file is too large
    if file_size_mb > max_size_mb:
        # AWS recommendation: 2x file size + 140MB overhead
        estimated_memory_mb = (file_size_mb * 2) + 140
        logger.error(
            f"File size {file_size_mb:.1f}MB exceeds limit of {max_size_mb}MB. "
            f"Estimated memory required: {estimated_memory_mb:.1f}MB"
        )
        raise FileTooLargeError(
            f"File size {file_size_mb:.1f}MB exceeds limit of {max_size_mb}MB. "
            f"Estimated memory required: {estimated_memory_mb:.1f}MB"
        )

    if response["ContentLength"] < 1 * 1024:
        raise FileTooSmallError(
            f"File size {response['ContentLength']} bytes is too small to process"
        )

    # Log start of processing
    logger.info(f"Starting FFmpeg processing for {input_file_name}")
    start_time = time.monotonic()

    # Get input stream from S3
    input_stream = get_stream_from_s3(input_file_name)
    input_data = input_stream.read()

    if not input_data:
        raise ValueError(f"Input file {input_file_name} is empty")

    logger.debug(f"Read {len(input_data)} bytes from input file")

    file_format = get_file_format_from_file_path(input_file_name)
    logger.debug(f"Input format: {file_format}, output format: {output_format}")

    # Determine if this might be an Apple Voice Memos file
    if file_format.lower() in ["m4a", "mp4"] and len(input_data) > 100:
        # Check for signature patterns found in Apple Voice Memos
        if b"ftypM4A" in input_data[:50] or b"moov" in input_data[:200]:
            logger.info("Detected possible Apple Voice Memo signature")

    # Process through ffmpeg
    with tempfile.NamedTemporaryFile(suffix=f".{file_format}") as input_temp_file:
        input_temp_file.write(input_data)
        input_temp_file.flush()
        if output_format == "ogg":
            if file_format.lower() in ["m4a", "mp4"]:
                logger.debug("Special handling for M4A files")
                process = (
                    ffmpeg.input(input_temp_file.name, f=file_format)
                    .output(
                        "pipe:1",
                        f="ogg",
                        acodec="libvorbis",
                        q="5",
                        max_error_rate="0.5",
                        strict="-2",
                    )
                    .global_args(
                        "-hide_banner",
                        "-loglevel",
                        "warning",
                        "-err_detect",
                        "ignore_err",
                    )
                    .overwrite_output()
                    .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
                )
            else:
                process = (
                    ffmpeg.input(input_temp_file.name, f=file_format)
                    .output("pipe:1", f="ogg", acodec="libvorbis", q="5")
                    .global_args("-hide_banner", "-loglevel", "warning")
                    .overwrite_output()
                    .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
                )
        elif output_format == "mp3":
            process = (
                ffmpeg.input(input_temp_file.name, f=file_format)
                .output(
                    "pipe:1",
                    f="mp3",
                    acodec="libmp3lame",
                    q="5",
                    strict="-2",
                    preset="veryfast",
                )
                .global_args("-hide_banner", "-loglevel", "warning")
                .overwrite_output()
                .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
            )
        else:
            raise ValueError(f"Not implemented for file format: {output_format}")

        output, err = process.communicate(input=None)

    # Log the stderr output for debugging
    err_text = err.decode() if err else ""
    if err_text:
        logger.debug(f"FFmpeg stderr: {err_text}")

    if process.returncode != 0:
        error_message = err_text or "Unknown FFmpeg error"
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

    # Verify we got valid output
    if not output:
        raise ConversionError("FFmpeg produced empty output")

    output_size = len(output)
    logger.debug(f"FFmpeg produced {output_size} bytes of output")

    # Verify OGG header
    if output_format == "ogg" and not output.startswith(b"OggS"):
        logger.warning("Output file does not have OGG header signature")
        if output_size < 100:
            logger.error(f"Output too small ({output_size} bytes) and missing OGG header")
            raise ConversionError(f"Invalid OGG output (only {output_size} bytes)")

    # Save to S3
    s3_client.put_object(
        Bucket=STORAGE_S3_BUCKET,
        Key=get_sanitized_s3_key(output_file_name),
        Body=output,
        ACL="private",
    )

    duration = time.monotonic() - start_time
    logger.debug(
        f"Completed processing {input_file_name} in {duration:.2f}s. "
        f"Input size: {file_size_mb:.1f}MB, Output size: {len(output) / (1024 * 1024):.1f}MB"
    )

    if delete_original:
        delete_from_s3(input_file_name)

    sanitized_output_file_name = sanitize_filename_component(output_file_name)
    public_url = f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{sanitized_output_file_name}"
    return public_url


def merge_multiple_audio_files_and_save_to_s3(
    input_file_names: List[str],
    output_file_name: str,
    output_format: str,
) -> str:
    """Merge multiple audio files and save the result back to S3.

    Args:
        input_file_names: List of input file names in S3
        output_file_name: Destination file name in S3
        output_format: Format to convert to

    Returns:
        str: Public URL of the processed file

    Raises:
        FFmpegError: For FFmpeg-specific errors
        ValueError: For input validation errors
        Exception: For other processing errors
    """
    if not input_file_names:
        raise ValueError("No input files provided")

    if not output_file_name.endswith(f".{output_format}"):
        raise ValueError(f"Output file name {output_file_name} does not end with {output_format}")

    for i_name in input_file_names:
        if get_file_format_from_file_path(i_name) not in ACCEPTED_AUDIO_FORMATS:
            raise ValueError(f"Input file {i_name} is not in {ACCEPTED_AUDIO_FORMATS} format")

    # Log start of processing
    logger.info(f"Starting audio merge for {len(input_file_names)} files")
    start_time = time.time()

    # Check total size of all input files and load data
    total_size_mb = 0

    # Process each file - probe format and convert if needed
    processed_data_streams = []
    for i_name in input_file_names:
        # Probe file to determine format
        try:
            probe_result = probe_from_s3(i_name, get_file_format_from_file_path(i_name))

            # Check if format is output_format
            is_output_format = False
            if "format" in probe_result:
                format_name = probe_result["format"].get("format_name", "").lower()
                if output_format in format_name:
                    is_output_format = True
                    logger.info(f"File {i_name} is already in {output_format} format")

            if not is_output_format:
                logger.warning(f"File {i_name} is not in {output_format} format, converting")
                converted_file_name = i_name + f".{output_format}"
                convert_and_save_to_s3(i_name, converted_file_name, output_format)
                # Get the stream from S3
                processed_data_streams.append(get_stream_from_s3(converted_file_name))

            else:
                # Already output_format, use as-is
                processed_data_streams.append(get_stream_from_s3(i_name))

        except Exception as e:
            logger.error(f"Error probing file {i_name}: {str(e)} - Moving on to next file")

    if not processed_data_streams:
        raise ValueError("No processed data streams")

    with tempfile.NamedTemporaryFile(suffix=f".{output_format}") as temp_file:
        for data_stream in processed_data_streams:
            temp_file.write(data_stream.read())

        temp_file.flush()

        if output_format == "ogg":
            # Final processing to ensure consistent output
            process = (
                ffmpeg.input(temp_file.name, format=output_format)
                .output("pipe:1", f="ogg", acodec="libvorbis", q="5")
                .global_args("-hide_banner", "-loglevel", "warning")
                .overwrite_output()
                .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
            )
        elif output_format == "mp3":
            process = (
                ffmpeg.input(temp_file.name, format=output_format)
                .output(
                    "pipe:1",
                    f="mp3",
                    acodec="libmp3lame",
                    q="5",
                    preset="veryfast",
                )
                .global_args("-hide_banner", "-loglevel", "warning")
                .overwrite_output()
                .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
            )
        else:
            raise ValueError(f"Not implemented for file format: {output_format}")

        output, err = process.communicate(input=None)

    if process.returncode != 0:
        error_message = err.decode() if err else "Unknown FFmpeg error"
        raise FFmpegError(f"FFmpeg final processing failed: {error_message}")

    # Save to S3
    logger.info(f"Saving merged audio to S3 as {output_file_name}")
    s3_client.put_object(
        Bucket=STORAGE_S3_BUCKET,
        Key=get_sanitized_s3_key(output_file_name),
        Body=output,
        ACL="private",
    )

    info = s3_client.head_object(
        Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(output_file_name)
    )
    logger.debug(f"Head object from S3: {info}")

    duration = time.time() - start_time

    logger.info(
        f"Completed merging {len(input_file_names)} files in {duration:.2f}s. "
        f"Total input size: {total_size_mb:.1f}MB"
    )

    public_url = f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{output_file_name}"
    return public_url


def probe_from_bytes(file_bytes: bytes, input_format: str) -> dict:
    """Probe audio/video bytes using ffprobe.

    Args:
        file_bytes: Raw bytes of the audio/video file
        input_format: Format hint (optional, detected from file if using tempfile approach)

    Returns:
        Dict containing the ffprobe output

    Raises:
        ValueError: If input validation fails
        Exception: If ffprobe fails or returns invalid data
    """
    # Validate input_format against allowed formats
    if input_format not in ACCEPTED_AUDIO_FORMATS:
        raise ValueError(
            f"Unsupported or invalid input format '{input_format}'. Must be one of: {ACCEPTED_AUDIO_FORMATS}"
        )

    # Make sure we have valid input
    if not file_bytes:
        raise ValueError("Empty file content provided to probe_from_bytes")

    if len(file_bytes) < 100:
        logger.warning(f"Very small file content ({len(file_bytes)} bytes) for ffprobe")

    # Check if the file appears to be valid OGG
    if input_format == "ogg" and not file_bytes.startswith(b"OggS"):
        logger.warning("File content does not start with OGG header signature")

    # Use a temporary file approach for more reliable probing
    # Using whitelisted input_format for temp file suffix is safe due to prior validation.
    with tempfile.NamedTemporaryFile(suffix=f".{input_format}", delete=False) as temp_file:
        try:
            # Write the bytes to a temporary file
            temp_file.write(file_bytes)
            temp_file.flush()
            temp_file_path = temp_file.name

            # Close the file to ensure all data is written and file handle is released
            temp_file.close()

            # Verify file was created and contains data
            if not os.path.exists(temp_file_path):
                raise Exception(f"Temp file {temp_file_path} was not created")

            file_size = os.path.getsize(temp_file_path)
            if file_size == 0:
                raise Exception(f"Temp file {temp_file_path} is empty")

            if file_size != len(file_bytes):
                logger.warning(
                    f"Temp file size ({file_size}) doesn't match input size ({len(file_bytes)})"
                )

            # Try ffprobe with auto-detection first (no format specifier)
            cmd = [
                "ffprobe",
                "-hide_banner",
                "-loglevel",
                "warning",  # Use warning level to see more info
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                temp_file_path,
            ]

            logger.debug(f"Running ffprobe on temp file ({file_size} bytes)")
            process = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            # Log the stderr output for debugging
            stderr_output = process.stderr.decode().strip()
            if stderr_output:
                logger.debug(f"ffprobe stderr: {stderr_output}")

            if process.returncode != 0:
                # If auto-detection fails, try explicitly specifying the format
                logger.warning(
                    f"Auto format detection failed, trying with explicit format: {input_format}"
                )
                # Map input_format to a hard-coded allowlist value for ffprobe
                if input_format not in FFPROBE_FORMAT_MAP:
                    raise ValueError(
                        f"Unsupported or invalid input format '{input_format}' for ffprobe mapping."
                    )
                mapped_format = FFPROBE_FORMAT_MAP[input_format]
                cmd = [
                    "ffprobe",
                    "-hide_banner",
                    "-loglevel",
                    "warning",
                    "-print_format",
                    "json",
                    "-show_format",
                    "-show_streams",
                    "-f",
                    mapped_format,
                    temp_file_path,
                ]

                process = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                stderr_output = process.stderr.decode().strip()
                if stderr_output:
                    logger.debug(f"ffprobe stderr (with format): {stderr_output}")

                if process.returncode != 0:
                    error = stderr_output or "Unknown error"
                    logger.error(f"ffprobe error: {error}")
                    raise Exception(f"ffprobe error: {error}")

            output = process.stdout.decode()
            if not output:
                logger.error("ffprobe returned empty output")
                raise Exception("ffprobe returned empty output")

            # Check the output for valid structure
            probe_data = json.loads(output)
            if "streams" not in probe_data or not probe_data["streams"]:
                logger.warning("No streams found in probe result")

            return probe_data
        except Exception as e:
            logger.error(f"Error in probe_from_bytes: {str(e)}")
            raise
        finally:
            # Clean up the temporary file
            if os.path.exists(temp_file_path):
                try:
                    os.unlink(temp_file_path)
                except Exception as e:
                    logger.warning(f"Failed to delete temporary file {temp_file_path}: {e}")


def probe_from_s3(file_name: str, input_format: str) -> dict:
    return probe_from_bytes(get_stream_from_s3(file_name).read(), input_format)


def get_duration_from_s3(file_name: str) -> float:
    probe_data = probe_from_s3(file_name, get_file_format_from_file_path(file_name))
    if "format" in probe_data and "duration" in probe_data["format"]:
        return float(probe_data["format"]["duration"])
    else:
        raise ValueError("Duration not found in ffprobe output")


MAX_CHUNK_SIZE = 15 * 1024 * 1024


def split_audio_chunk(
    original_chunk_id: str,
    output_format: str,
    chunk_size_bytes: int = MAX_CHUNK_SIZE,
    delete_original: bool = True,
) -> List[str]:
    logger = logging.getLogger("audio_utils.pre_process_audio")

    original_chunk = conversation_service.get_chunk_by_id_or_raise(original_chunk_id)

    logger.debug(f"Processing chunk: {original_chunk['id']}")

    if not original_chunk["path"]:
        raise FileNotFoundError("File path is not found")

    chunk_file_format = get_file_format_from_file_path(original_chunk["path"])
    logger.debug(f"Output format: {output_format}")
    logger.debug(f"Input file format: {chunk_file_format}")
    logger.debug(f"Input file name: {original_chunk['path']}")

    if chunk_file_format == output_format:
        logger.debug("File is already in the desired format. No conversion needed.")
        updated_chunk_path = original_chunk["path"]
    else:
        logger.debug(f"Converting file to {output_format} format using process_and_save_to_s3")

        # Extract just the filename part from the URL path
        original_file_path = get_sanitized_s3_key(original_chunk["path"])
        # Create new output path with changed extension
        output_file_path = original_file_path.replace(chunk_file_format, output_format)

        # Do the conversion
        convert_and_save_to_s3(
            original_chunk["path"],
            output_file_path,
            output_format,
        )

        # Construct the updated path without duplication
        updated_chunk_path = f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{output_file_path}"

        logger.debug("Updating Directus with new file path")

        directus.update_item(
            collection_name="conversation_chunk",
            item_id=original_chunk["id"],
            item_data={"path": updated_chunk_path},
        )

    # Get file size from S3 with the updated file.
    logger.debug(f"Updated chunk path: {updated_chunk_path}")
    s3_key = get_sanitized_s3_key(updated_chunk_path)
    logger.debug(f"S3 key: {s3_key}")
    logger.debug(f"Storage S3 Bucket: {STORAGE_S3_BUCKET}")
    logger.debug("attempting to get file size from S3 for the converted file")
    response = s3_client.head_object(Bucket=STORAGE_S3_BUCKET, Key=s3_key)
    file_size = response["ContentLength"]
    logger.debug(f"Converted file size from S3: {file_size} bytes")

    number_chunks = math.ceil(file_size / chunk_size_bytes)
    logger.debug(f"Number of chunks to split into: {number_chunks}")

    if number_chunks == 1:
        logger.debug("Single chunk file. No splitting necessary.")
        return [original_chunk["id"]]

    probe_data = probe_from_s3(
        updated_chunk_path, input_format=get_file_format_from_file_path(updated_chunk_path)
    )
    if "format" in probe_data and "duration" in probe_data["format"]:
        duration = float(probe_data["format"]["duration"])
        chunk_duration = duration / number_chunks
        logger.debug(f"Total duration: {duration}s, Each chunk duration: {chunk_duration}s")
    else:
        raise ValueError("Duration not found in ffprobe output")

    split_chunk_items = []
    new_chunk_ids = []

    with tempfile.NamedTemporaryFile(suffix=f".{output_format}") as temp_file:
        temp_file.write(get_stream_from_s3(updated_chunk_path).read())
        temp_file.flush()

        for i in range(number_chunks):
            start_time = i * chunk_duration
            chunk_id = generate_uuid()

            s3_chunk_path = get_sanitized_s3_key(
                f"chunks/{original_chunk['conversation_id']}/{chunk_id}_{i}-of-{number_chunks}."
                + output_format
            )
            logger.debug(f"Extracting chunk {i + 1}/{number_chunks} starting at {start_time}s")

            process = (
                ffmpeg.input(temp_file.name)
                .output(
                    "pipe:1",
                    ss=start_time,
                    t=chunk_duration,
                    f=output_format,
                    preset="veryfast",
                )
                .overwrite_output()
                .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
            )

            chunk_output, err = process.communicate(input=None)

            if process.returncode != 0:
                raise FFmpegError(f"ffmpeg splitting failed: {err.decode().strip()}")

            s3_client.put_object(
                Bucket=STORAGE_S3_BUCKET,
                Key=s3_chunk_path,
                Body=chunk_output,
                ACL="private",
            )

            new_item = {
                "conversation_id": original_chunk["conversation_id"],
                "created_at": (
                    datetime.datetime.fromisoformat(original_chunk["created_at"])
                    + timedelta(seconds=start_time)
                ).isoformat(),
                "timestamp": (
                    datetime.datetime.fromisoformat(original_chunk["timestamp"])
                    + timedelta(seconds=start_time)
                ).isoformat(),
                "path": f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{s3_chunk_path}",
                "source": original_chunk["source"],
                "id": chunk_id,
            }
            split_chunk_items.append(new_item)
            new_chunk_ids.append(chunk_id)

    new_ids = []
    for item in split_chunk_items:
        c = directus.create_item("conversation_chunk", item_data=item)
        new_ids.append(c["data"]["id"])

    logger.debug("Created split chunks in Directus.")

    if delete_original:
        directus.delete_item("conversation_chunk", original_chunk["id"])
        logger.debug("Deleted original chunk from Directus after splitting.")

    logger.debug(f"Successfully split file into {number_chunks} chunks.")
    return new_ids
