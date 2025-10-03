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

from dembrane.s3 import (
    s3_client,
    delete_from_s3,
    get_signed_url,
    get_stream_from_s3,
    get_sanitized_s3_key,
    get_file_size_bytes_from_s3,
)
from dembrane.utils import generate_uuid
from dembrane.config import STORAGE_S3_BUCKET, STORAGE_S3_ENDPOINT
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

    total_size_bytes = 0

    # Process each file - probe format and convert if needed
    processed_keys: List[str] = []

    def _sanitize_key(path: str) -> str:
        return get_sanitized_s3_key(path)

    def _with_extension(path: str, ext: str) -> str:
        base = path.rsplit(".", 1)[0] if "." in path else path
        return f"{base}.{ext}"

    for i_name in input_file_names:
        sanitized_input_key = _sanitize_key(i_name)

        try:
            probe_result = probe_from_s3(sanitized_input_key, get_file_format_from_file_path(i_name))

            format_name = probe_result.get("format", {}).get("format_name", "").lower()
            is_output_format = output_format in format_name if format_name else False

            if not is_output_format:
                logger.info(
                    "Converting %s to %s before merge", sanitized_input_key, output_format
                )
                converted_key = _with_extension(sanitized_input_key, output_format)
                convert_and_save_to_s3(
                    sanitized_input_key,
                    converted_key,
                    output_format,
                )
                final_key = converted_key
            else:
                final_key = sanitized_input_key

            processed_keys.append(final_key)
            total_size_bytes += get_file_size_bytes_from_s3(final_key)

        except Exception as e:
            logger.error("Failed preparing %s for merge: %s", sanitized_input_key, e, exc_info=True)

    if not processed_keys:
        raise ValueError("No valid input files available for merge")

    # Build concat playlist using presigned URLs so ffmpeg streams directly from storage
    playlist_lines: List[str] = []
    for key in processed_keys:
        signed_url = get_signed_url(key, expires_in_seconds=15 * 60)
        safe_url = signed_url.replace("'", "'\\''")
        playlist_lines.append(f"file '{safe_url}'")

    playlist_bytes = ("\n".join(playlist_lines) + "\n").encode("utf-8")

    logger.info("Starting streaming merge via ffmpeg concat for %d files", len(processed_keys))

    output_kwargs = {
        "format": output_format,
    }

    if output_format == "ogg":
        output_kwargs.update({"acodec": "libvorbis", "q": "5"})
    elif output_format == "mp3":
        output_kwargs.update({"acodec": "libmp3lame", "q": "5", "preset": "veryfast"})
    else:
        raise ValueError(f"Not implemented for file format: {output_format}")

    process = (
        ffmpeg.input(
            "pipe:0",
            format="concat",
            safe=0,
            protocol_whitelist="file,pipe,data,http,https,tcp,tls,crypto",
        )
        .output("pipe:1", **output_kwargs)
        .global_args(
            "-hide_banner",
            "-loglevel",
            "warning",
        )
        .run_async(pipe_stdin=True, pipe_stdout=True, pipe_stderr=True)
    )

    output = None
    err = None

    try:
        output, err = process.communicate(input=playlist_bytes)
    finally:
        if process.stdin:
            process.stdin.close()

    if process.returncode != 0:
        error_message = err.decode() if err else "Unknown FFmpeg error"
        logger.error("FFmpeg concat failed: %s", error_message)
        raise FFmpegError(f"FFmpeg final processing failed: {error_message}")

    if not output:
        raise ConversionError("FFmpeg produced empty output during merge")

    logger.info("Saving merged audio to S3 as %s", output_file_name)
    s3_client.put_object(
        Bucket=STORAGE_S3_BUCKET,
        Key=get_sanitized_s3_key(output_file_name),
        Body=output,
        ACL="private",
    )

    info = s3_client.head_object(
        Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(output_file_name)
    )
    logger.debug("Head object from S3: %s", info)

    duration = time.time() - start_time

    logger.info(
        "Completed streaming merge of %d files in %.2fs. Total input size: %.1fMB",
        len(processed_keys),
        duration,
        total_size_bytes / (1024 * 1024),
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


# ============================================================================
# STREAMING AUDIO PROCESSING FUNCTIONS (Optimized)
# ============================================================================


def probe_audio_from_s3(s3_path: str) -> dict:
    """
    Probe audio file metadata without downloading entire file.
    Only reads first 8KB for format detection.
    
    Args:
        s3_path: S3 path (e.g. "conversation/123/chunks/456.mp3")
    
    Returns:
        dict with format, duration, bit_rate, etc.
    """
    try:
        # Download only first 8KB for probing
        stream = get_stream_from_s3(s3_path)
        header_bytes = stream.read(8192)
        
        # Use ffprobe on header bytes
        with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as temp:
            temp.write(header_bytes)
            temp_path = temp.name
        
        try:
            probe = ffmpeg.probe(temp_path)
            return probe['format']
        finally:
            os.unlink(temp_path)
            
    except Exception as e:
        logger.error(f"Failed to probe audio from S3: {s3_path}, error: {e}")
        raise


def should_split_chunk(chunk_id: str, max_size_mb: int = 20) -> bool:
    """
    Determine if chunk needs splitting based on file size.
    Uses HEAD request (no download).
    
    Args:
        chunk_id: Chunk ID to check
        max_size_mb: Maximum size before splitting
    
    Returns:
        True if chunk should be split
    """
    from dembrane.s3 import get_file_size_bytes_from_s3
    
    chunk = conversation_service.get_chunk_by_id_or_raise(chunk_id)
    s3_path = chunk["path"]
    
    try:
        file_size_bytes = get_file_size_bytes_from_s3(s3_path)
        file_size_mb = file_size_bytes / (1024 * 1024)
        
        logger.info(f"Chunk {chunk_id} size: {file_size_mb:.2f}MB")
        return file_size_mb > max_size_mb
        
    except Exception as e:
        logger.warning(f"Could not determine chunk size, assuming needs split: {e}")
        return True  # Conservative: split if unsure


def split_audio_chunk_streaming(
    original_chunk_id: str,
    output_format: str = "mp3",
    target_duration_seconds: int = 300,
    delete_original: bool = False,
) -> List[str]:
    """
    Split audio chunk using streaming operations (no temp files for download).
    
    Improvements over old split_audio_chunk():
    - Uses ffmpeg piping instead of always using temp files
    - Parallelizes chunk uploads
    - Better error handling
    
    Args:
        original_chunk_id: ID of chunk to split
        output_format: Target format (mp3, webm, etc.)
        target_duration_seconds: Target duration per split chunk
        delete_original: Whether to delete original after splitting
    
    Returns:
        List of new chunk IDs created
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    from dembrane.s3 import save_bytes_to_s3
    
    logger.info(f"Starting streaming split for chunk {original_chunk_id}")
    
    # Get chunk metadata
    chunk = conversation_service.get_chunk_by_id_or_raise(original_chunk_id)
    conversation_id = chunk["conversation_id"]
    original_path = chunk["path"]
    
    # Probe file to get duration
    try:
        probe_info = probe_from_s3(original_path, get_file_format_from_file_path(original_path))
        total_duration = float(probe_info['format']['duration'])
        logger.info(f"Chunk {original_chunk_id} duration: {total_duration}s")
    except Exception as e:
        logger.error(f"Failed to probe chunk {original_chunk_id}: {e}")
        raise
    
    # Calculate number of chunks needed
    num_chunks = math.ceil(total_duration / target_duration_seconds)
    
    if num_chunks <= 1:
        logger.info(f"Chunk {original_chunk_id} doesn't need splitting (duration: {total_duration}s)")
        return [original_chunk_id]
    
    logger.info(f"Splitting chunk {original_chunk_id} into {num_chunks} chunks")
    
    # Download original file once
    audio_stream = get_stream_from_s3(original_path)
    audio_data = audio_stream.read()
    
    # Process splits in parallel
    new_chunk_ids = []
    upload_tasks = []
    
    for i in range(num_chunks):
        start_time = i * target_duration_seconds
        duration = min(target_duration_seconds, total_duration - start_time)
        
        # Generate new chunk ID
        new_chunk_id = generate_uuid()
        new_chunk_ids.append(new_chunk_id)
        
        # Process with ffmpeg using pipes (no temp files)
        try:
            process = (
                ffmpeg
                .input('pipe:0')  # Read from stdin
                .output(
                    'pipe:1',  # Write to stdout
                    format=output_format,
                    ss=start_time,
                    t=duration,
                    **{"c:a": "libmp3lame", "b:a": "128k"} if output_format == "mp3" else {}
                )
                .run_async(
                    pipe_stdin=True,
                    pipe_stdout=True,
                    pipe_stderr=True,
                    quiet=True
                )
            )
            
            # Process audio (stream through ffmpeg)
            chunk_output, err = process.communicate(input=audio_data)
            
            if process.returncode != 0:
                logger.error(f"FFmpeg error for chunk {i}: {err.decode()}")
                raise Exception(f"FFmpeg failed: {err.decode()}")
            
            # Prepare S3 upload
            s3_key = f"conversation/{conversation_id}/chunks/{new_chunk_id}.{output_format}"
            upload_tasks.append((s3_key, chunk_output, new_chunk_id))
            
        except Exception as e:
            logger.error(f"Failed to process chunk {i}: {e}")
            raise
    
    # Upload all chunks in parallel (using threads)
    logger.info(f"Uploading {len(upload_tasks)} split chunks in parallel")
    
    def upload_chunk(s3_key: str, data: bytes, chunk_id: str):
        """Upload a single chunk to S3"""
        try:
            save_bytes_to_s3(data, s3_key, public=False)
            logger.info(f"Uploaded chunk {chunk_id} ({len(data)} bytes)")
            return True
        except Exception as e:
            logger.error(f"Failed to upload chunk {chunk_id}: {e}")
            raise
    
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [
            executor.submit(upload_chunk, s3_key, data, chunk_id)
            for s3_key, data, chunk_id in upload_tasks
        ]
        
        # Wait for all uploads to complete
        for future in as_completed(futures):
            future.result()  # Raises exception if upload failed
    
    # Create database records for new chunks
    logger.info(f"Creating database records for {len(new_chunk_ids)} split chunks")
    
    for i, new_chunk_id in enumerate(new_chunk_ids):
        s3_key = f"conversation/{conversation_id}/chunks/{new_chunk_id}.{output_format}"
        start_time_offset = i * target_duration_seconds
        
        # Calculate timestamp for this chunk
        original_timestamp = datetime.datetime.fromisoformat(chunk["timestamp"])
        new_timestamp = original_timestamp + timedelta(seconds=start_time_offset)
        
        # Create chunk record
        directus.create_item(
            "conversation_chunk",
            item_data={
                "id": new_chunk_id,
                "conversation_id": conversation_id,
                "timestamp": new_timestamp.isoformat(),
                "path": f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{s3_key}",
                "source": chunk["source"],
            },
        )
    
    # Delete original chunk if requested
    if delete_original:
        logger.info(f"Deleting original chunk {original_chunk_id}")
        try:
            delete_from_s3(original_path)
            directus.delete_item("conversation_chunk", original_chunk_id)
        except Exception as e:
            logger.warning(f"Failed to delete original chunk: {e}")
    
    logger.info(f"Split complete: {original_chunk_id} → {len(new_chunk_ids)} chunks")
    return new_chunk_ids
