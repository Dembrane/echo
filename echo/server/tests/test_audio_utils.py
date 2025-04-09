import os
import logging
import datetime

import pytest

from dembrane.s3 import s3_client, get_sanitized_s3_key
from dembrane.utils import generate_uuid
from dembrane.config import BASE_DIR, STORAGE_S3_BUCKET, STORAGE_S3_ENDPOINT
from dembrane.directus import directus
from dembrane.audio_utils import (
    probe_from_s3,
    probe_from_bytes,
    split_audio_chunk,
    get_duration_from_s3,
    convert_and_save_to_s3,
    get_file_format_from_file_path,
    merge_multiple_audio_files_and_save_to_s3,
)

logger = logging.getLogger(__name__)


AUDIO_FILES = [
    "wav.wav",
    "mp3.mp3",
    "webm.webm",
    "aac.aac",
    "test.m4a",
    "m4a.m4a",
]

LARGE_AUDIO_SET = ["mp3.mp3", "big.m4a"]

OUTPUT_FORMATS = ["mp3"]  # Could add "ogg" or other formats


@pytest.mark.parametrize("file_name", AUDIO_FILES)
@pytest.mark.parametrize("output_format", OUTPUT_FORMATS)
def test_convert_and_save_to_s3(file_name, output_format):
    # save to s3
    logger.info(f"\n\n\n------- TESTING {file_name} TO {output_format} -------\n\n\n")

    input_file_key = "tests/" + generate_uuid() + "." + get_file_format_from_file_path(file_name)

    output_file_key = (
        "tests/" + generate_uuid() + f"-{file_name.split('.')[0]}" + "." + output_format
    )

    with open(os.path.join(BASE_DIR, "tests", "data", "audio", file_name), "rb") as f:
        file_bytes = f.read()
        logger.info(f"Uploading {file_name} with size {len(file_bytes)} bytes")

        s3_client.put_object(
            Bucket=STORAGE_S3_BUCKET,
            Key=get_sanitized_s3_key(input_file_key),
            Body=file_bytes,
        )

        output_url = convert_and_save_to_s3(input_file_key, output_file_key, output_format)

        assert output_url is not None, "output_url is None"
        assert output_url.startswith(STORAGE_S3_ENDPOINT), (
            "output_url does not start with STORAGE_S3_ENDPOINT"
        )
        assert output_url.startswith("http"), "output_url does not start with http"
        assert output_url.endswith(f".{output_format}"), (
            f"output_url does not end with .{output_format}"
        )

        # Verify the file exists and has content
        head_response = s3_client.head_object(
            Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(output_file_key)
        )
        assert head_response is not None, "head_response is None"
        file_size = head_response["ContentLength"]
        assert file_size > 0, "head_response['ContentLength'] is not greater than 0"
        logger.info(f"Output file size: {file_size} bytes")

        # Download the file for probing
        response = s3_client.get_object(
            Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(output_file_key)
        )
        file_content = response["Body"].read()

        # Verify we have data
        content_length = len(file_content)
        assert content_length > 0, "Downloaded file content is empty"
        logger.info(f"Downloaded content length: {content_length} bytes")

        # Use the improved probe_from_bytes function
        logger.info("Running probe_from_bytes on file content")
        probe = probe_from_bytes(file_content, output_format)

        # Verify the audio properties
        assert probe is not None, "probe is None"
        assert probe["streams"] is not None, "probe['streams'] is None"
        assert len(probe["streams"]) > 0, "No streams in probe result"
        assert probe["streams"][0]["codec_type"] == "audio", "Not an audio stream"
        # assert probe["streams"][0]["codec_name"].endswith("vorbis"), "Not libvorbis codec"
        assert float(probe["streams"][0]["duration"]) > 0, "Duration not positive"

        logger.info(f"\n\n\n------- VALID FOR {file_name} TO {output_format} -------\n\n\n")

        # delete the input file
        s3_client.delete_object(Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(input_file_key))
        # delete the output file
        s3_client.delete_object(Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(output_file_key))


@pytest.mark.parametrize("output_format", OUTPUT_FORMATS)
def test_merge_multiple_audio_files_and_save_to_s3(output_format):
    new_file_names = []

    # load files to s3
    for file_name in AUDIO_FILES:
        with open(os.path.join(BASE_DIR, "tests", "data", "audio", file_name), "rb") as f:
            file_bytes = f.read()
            output_file_key = (
                "tests/" + generate_uuid() + "." + get_file_format_from_file_path(file_name)
            )
            s3_client.put_object(
                Bucket=STORAGE_S3_BUCKET,
                Key=get_sanitized_s3_key(output_file_key),
                Body=file_bytes,
            )
            new_file_names.append(output_file_key)

    # merge files
    merged_file_key = "tests/" + generate_uuid() + "." + output_format
    merged_file_url = merge_multiple_audio_files_and_save_to_s3(
        new_file_names, merged_file_key, output_format
    )

    assert merged_file_url is not None, "merged_file_url is None"
    assert merged_file_url.startswith(STORAGE_S3_ENDPOINT), (
        "merged_file_url does not start with STORAGE_S3_ENDPOINT"
    )
    assert merged_file_url.endswith(f".{output_format}"), (
        f"merged_file_url does not end with .{output_format}"
    )

    response = s3_client.get_object(
        Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(merged_file_key)
    )
    file_content = response["Body"].read()

    # Verify we have data
    content_length = len(file_content)
    assert content_length > 0, "Downloaded file content is empty"

    # Use the improved probe_from_bytes function
    logger.info("Running probe_from_bytes on file content")
    probe = probe_from_bytes(file_content, output_format)

    # Verify the audio properties
    assert probe is not None, "probe is None"
    assert probe["streams"] is not None, "probe['streams'] is None"
    assert len(probe["streams"]) > 0, "No streams in probe result"
    assert probe["streams"][0]["codec_type"] == "audio", "Not an audio stream"
    assert float(probe["streams"][0]["duration"]) > 0, "Duration not positive"

    for file_name in new_file_names:
        s3_client.delete_object(Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(file_name))

    s3_client.delete_object(Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(merged_file_key))


@pytest.mark.slow
@pytest.mark.parametrize("file_name", LARGE_AUDIO_SET)
@pytest.mark.parametrize("output_format", OUTPUT_FORMATS)
def test_split_audio_chunk(file_name, output_format):
    logger = logging.getLogger("test_split_audio_chunk")

    project = directus.create_item(
        "project",
        item_data={
            "is_conversation_allowed": True,
            "image_generation_model": "PLACEHOLDER",
        },
    )["data"]

    conversation = directus.create_item(
        "conversation",
        item_data={
            "project_id": project["id"],
        },
    )["data"]

    # Load the audio file
    with open(os.path.join(BASE_DIR, "tests", "data", "audio", file_name), "rb") as f:
        file_bytes = f.read()

        # Create S3 path for the audio file
        output_file_key = (
            f"tests/conversation-chunks/{generate_uuid()}."
            + get_file_format_from_file_path(file_name)
        )

        # Upload the file to S3
        s3_client.put_object(
            Bucket=STORAGE_S3_BUCKET,
            Key=get_sanitized_s3_key(output_file_key),
            Body=file_bytes,
        )

        # Create the S3 URL path
        s3_url = f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{output_file_key}"

        # Create a conversation chunk in directus
        chunk_id = generate_uuid()
        chunk_created = directus.create_item(
            "conversation_chunk",
            item_data={
                "id": chunk_id,
                "timestamp": datetime.datetime.utcnow().isoformat(),
                "path": s3_url,
                "source": "TEST",
                "conversation_id": conversation["id"],
            },
        )["data"]

        assert chunk_created["id"] == chunk_id, "Chunk creation failed"
        logger.info(f"Created conversation_chunk with ID: {chunk_id}")

    # Test splitting this chunk
    split_chunks = []
    logger.info(f"Splitting conversation chunk: {chunk_id} to {output_format}")
    split_chunks = split_audio_chunk(chunk_id, output_format)

    logger.info(f"Split chunks: {split_chunks}")

    assert split_chunks is not None, f"Failed to split chunk {chunk_id}"

    for split_chunk in split_chunks:
        item = directus.get_item(
            "conversation_chunk",
            split_chunk,
        )
        assert item is not None, f"Failed to get split chunk {item['id']}"
        assert item["path"].startswith("http"), (
            f"Split chunk {item['path']} does not start with http"
        )
        assert item["path"].startswith(STORAGE_S3_ENDPOINT), (
            f"Split chunk {item['path']} does not start with STORAGE_S3_ENDPOINT"
        )

        data = s3_client.get_object(
            Bucket=STORAGE_S3_BUCKET,
            Key=get_sanitized_s3_key(item["path"]),
        )["Body"].read()
        assert data is not None, f"Failed to get split chunk {item['path']}"
        assert len(data) > 0, f"Split chunk {item['path']} is empty"

        probe = probe_from_s3(item["path"], output_format)
        assert probe is not None, f"Failed to probe split chunk {item['path']}"
        assert probe["streams"] is not None, f"Probe result for {item['path']} has no streams"
        assert len(probe["streams"]) > 0, f"Probe result for {item['path']} has no streams"
        assert probe["streams"][0]["codec_type"] == "audio", (
            f"Probe result for {item['path']} is not an audio stream"
        )
        assert float(probe["streams"][0]["duration"]) > 0, (
            f"Probe result for {item['path']} has no duration"
        )

    # delete the conversation chunk
    directus.delete_item("conversation_chunk", chunk_id)

    # delete the conversation
    directus.delete_item("conversation", conversation["id"])

    # delete the project
    directus.delete_item("project", project["id"])


@pytest.mark.parametrize("file_name", AUDIO_FILES)
def test_get_duration_from_s3(file_name: str):
    # load
    with open(os.path.join(BASE_DIR, "tests", "data", "audio", file_name), "rb") as f:
        file_bytes = f.read()

        # Create S3 path for the audio file
        output_file_key = (
            f"tests/conversation-chunks/{generate_uuid()}."
            + get_file_format_from_file_path(file_name)
        )

        # Upload the file to S3
        s3_client.put_object(
            Bucket=STORAGE_S3_BUCKET,
            Key=get_sanitized_s3_key(output_file_key),
            Body=file_bytes,
        )

        # Get the duration of the file
        duration = get_duration_from_s3(output_file_key)
        assert duration is not None, f"Failed to get duration for {output_file_key}"
        assert duration > 0, f"Duration for {output_file_key} is not positive"

        # delete the file from S3
        s3_client.delete_object(Bucket=STORAGE_S3_BUCKET, Key=get_sanitized_s3_key(output_file_key))
