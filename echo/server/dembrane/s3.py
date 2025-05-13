"""S3 Storage Interface Module

This module provides a simplified interface for interacting with S3-compatible storage services
(like AWS S3 or MinIO). It handles file uploads, downloads, and management operations.

Examples:
    Upload a file from a URL:
        >>> url = "https://example.com/image.jpg"
        >>> s3_url = save_to_s3_from_url(url)
        >>> print(s3_url)
        'http://localhost:9000/dembrane/abc123.jpg'

    Upload a file with custom name:
        >>> url = "https://example.com/image.jpg"
        >>> s3_url = save_to_s3_from_url(url, output_file_name="profile.jpg")
        >>> print(s3_url)
        'http://localhost:9000/dembrane/profile.jpg'

    Upload from FastAPI UploadFile:
        >>> file = UploadFile(...)
        >>> s3_url = save_to_s3_from_file_like(file, "document.pdf", public=True)
        >>> print(s3_url)
        'http://localhost:9000/dembrane/document.pdf'

    Generate temporary signed URL for private files:
        >>> signed_url = get_signed_url("private_doc.pdf", expires_in_seconds=3600)
        >>> print(signed_url)
        'http://localhost:9000/dembrane/private_doc.pdf?X-Amz-Algorithm=...'

    Stream file from S3:
        >>> stream = get_stream_from_s3("document.pdf")
        >>> content = stream.read()

    Delete a file:
        >>> delete_from_s3("document.pdf")

Note:
    - Files can be stored as public (accessible via direct URL) or private (requires signed URL)
    - File uploads from FastAPI have a default size limit of 100MB
    - The module automatically sanitizes file names and handles S3 key formatting
"""

import io
import logging
from urllib.parse import urlparse

import boto3
import requests
from pydub import AudioSegment
from fastapi import UploadFile
from botocore.response import StreamingBody

from dembrane.utils import generate_uuid
from dembrane.config import (
    STORAGE_S3_KEY,
    STORAGE_S3_BUCKET,
    STORAGE_S3_REGION,
    STORAGE_S3_SECRET,
    STORAGE_S3_ENDPOINT,
)

logger = logging.getLogger("s3")

session = boto3.session.Session()

INTERNAL_S3_ENDPOINT = STORAGE_S3_ENDPOINT

if STORAGE_S3_REGION is None:
    logger.warning("STORAGE_S3_REGION is not set, using 'None'")
    s3_client = session.client(
        "s3",
        endpoint_url=INTERNAL_S3_ENDPOINT,
        aws_access_key_id=STORAGE_S3_KEY,
        aws_secret_access_key=STORAGE_S3_SECRET,
    )
else:
    s3_client = session.client(
        "s3",
        region_name=STORAGE_S3_REGION,
        endpoint_url=INTERNAL_S3_ENDPOINT,
        aws_access_key_id=STORAGE_S3_KEY,
        aws_secret_access_key=STORAGE_S3_SECRET,
    )


def save_to_s3_from_url(
    input_url: str, output_file_name: str | None = None, public: bool = True
) -> str:
    response = requests.get(input_url)
    response.raise_for_status()

    parsed_url = urlparse(input_url)
    extension = parsed_url.path.split(".")[-1]

    if output_file_name is None:
        logger.info(f"Generating file name for {input_url}")
        file_name = f"{generate_uuid()}.{extension}"
    else:
        logger.info(f"Using provided file name: {output_file_name}")
        file_name = get_sanitized_s3_key(output_file_name)
        if "." not in file_name:
            logger.warning(
                f"File name {file_name} does not contain a dot, adding extension {extension}"
            )
            file_name = f"{file_name}.{extension}"

    s3_client.put_object(
        Bucket=STORAGE_S3_BUCKET,
        Key=get_sanitized_s3_key(file_name),
        Body=response.content,
        ACL="public-read" if public else "private",
    )

    public_url = f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{file_name}"

    return public_url


def save_to_s3_from_file_like(
    file_obj: UploadFile, file_name: str, public: bool, size_limit_mb: int = 100
) -> str:
    file_obj.file.seek(0, 2)
    file_size = file_obj.file.tell()
    file_obj.file.seek(0)

    if file_size > size_limit_mb * 1024 * 1024:
        raise ValueError(f"File size exceeds {size_limit_mb}MB limit")

    file_name = get_sanitized_s3_key(file_name)

    s3_client.upload_fileobj(
        Fileobj=file_obj.file,
        Bucket=STORAGE_S3_BUCKET,
        Key=get_sanitized_s3_key(file_name),
        ExtraArgs={"ACL": "public-read" if public else "private"},
    )

    public_url = f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{file_name}"

    return public_url


def get_signed_url(file_name: str, expires_in_seconds: int = 3600) -> str:
    return s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": STORAGE_S3_BUCKET, "Key": get_sanitized_s3_key(file_name)},
        ExpiresIn=expires_in_seconds,
    )


def get_sanitized_s3_key(file_name: str) -> str:
    if not file_name:
        raise ValueError("Empty file name provided to get_sanitized_s3_key")

    file_name = file_name.strip().split("?")[0]

    # Check if it's a full URL and extract the path
    if file_name.startswith(f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/"):
        key = file_name.split(f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/")[1]
        return key
    # Handle URLs with any endpoint but correct format (http://endpoint/bucket/key)
    elif file_name.startswith("http://") or file_name.startswith("https://"):
        parts = file_name.split("/")
        if len(parts) >= 5:  # http:// + domain + bucket + rest of path
            # Skip http(s):// + domain + bucket
            key = "/".join(parts[4:])
            return key
    # Also handle cases with forward slashes at the beginning
    elif file_name.startswith("/"):
        # Remove any leading slashes
        return file_name.lstrip("/")

    return file_name


def get_stream_from_s3(file_name: str) -> StreamingBody:
    file_name = get_sanitized_s3_key(file_name)

    f = s3_client.get_object(Bucket=STORAGE_S3_BUCKET, Key=file_name)
    return f["Body"]


def delete_from_s3(file_name: str) -> None:
    file_name = get_sanitized_s3_key(file_name)
    s3_client.delete_object(Bucket=STORAGE_S3_BUCKET, Key=file_name)


def get_file_size_from_s3_mb(file_name: str) -> float:
    file_name = get_sanitized_s3_key(file_name)

    response = s3_client.head_object(Bucket=STORAGE_S3_BUCKET, Key=file_name)

    return response["ContentLength"] / (1024 * 1024)


def save_audio_to_s3(audio: AudioSegment, file_name: str, public: bool = False) -> str:
    """
    Save an AudioSegment object directly to S3.

    Args:
        audio (AudioSegment): The audio segment to save.
        file_name (str): The name of the file to save in S3.
        public (bool): Whether the file should be publicly accessible.

    Returns:
        str: The URL of the saved file in S3.
    """
    audio_buffer = io.BytesIO()
    audio.export(audio_buffer, format="wav")
    audio_buffer.seek(0)
    file_like = UploadFile(filename=file_name, file=audio_buffer)
    s3_url = save_to_s3_from_file_like(file_like, file_name, public)
    return s3_url

def get_uncompressed_audio_file_size_from_s3_mb(uri: str, format: str = "mp3") -> float:
    """
    Calculate the size of an audio file stored in S3 when converted to MP3 format.
    This is useful for estimating the memory usage when loading audio files for processing.
    
    Args:
        uri (str): The URI of the audio file in S3
        format (str): The format of the stored audio file (default: "mp3")
        
    Returns:
        float: The size of the audio in MP3 format in MB
    """
    audio_stream = get_stream_from_s3(uri)
    
    try:
        # Load the audio file from S3 into an AudioSegment
        audio = AudioSegment.from_file(io.BytesIO(audio_stream.read()), format=format)
        
        # Export to WAV to calculate uncompressed size
        wav_buffer = io.BytesIO()
        audio.export(wav_buffer, format="wav")

        # Calculate size in MB
        wav_size_mb = len(wav_buffer.getvalue()) / (1024 * 1024)

        return wav_size_mb

    except Exception as e:
        logger.warning(f"Error calculating MP3 audio size for {uri}: {str(e)}")
        # Fallback to the compressed size with a small multiplier as estimation
        return get_file_size_from_s3_mb(uri) * 1.5

