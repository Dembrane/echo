import logging
from typing import BinaryIO
from urllib.parse import urlparse

import boto3  # type: ignore
import requests
from fastapi import UploadFile

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

s3_client = session.client(
    "s3",
    region_name=STORAGE_S3_REGION,
    endpoint_url=STORAGE_S3_ENDPOINT,
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
        Params={"Bucket": STORAGE_S3_BUCKET, "Key": file_name},
        ExpiresIn=expires_in_seconds,
    )


def get_sanitized_s3_key(file_name: str) -> str:
    if file_name.startswith(f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/"):
        return file_name.split(f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/")[1]
    return file_name


def get_stream_from_s3(file_name: str) -> BinaryIO:
    file_name = get_sanitized_s3_key(file_name)

    f = s3_client.get_object(Bucket=STORAGE_S3_BUCKET, Key=file_name)
    return f["Body"]


def delete_from_s3(file_name: str) -> None:
    file_name = get_sanitized_s3_key(file_name)
    s3_client.delete_object(Bucket=STORAGE_S3_BUCKET, Key=file_name)
