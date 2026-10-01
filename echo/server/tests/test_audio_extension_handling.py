import pytest

from dembrane import audio_utils
from dembrane.s3 import s3_client
from dembrane.service import conversation_service
from dembrane.directus import directus
from dembrane.audio_utils import (
    split_audio_chunk,
    get_mime_type_from_file_path,
    get_file_format_from_file_path,
)


@pytest.mark.parametrize(
    "file_path,expected_format",
    [
        ("IN685F~1.M4A", "m4a"),
        ("interview.WAV", "wav"),
        ("recording.MP3", "mp3"),
        ("audio.AAC", "aac"),
        ("sound.OGG", "ogg"),
        ("track.FLAC", "flac"),
        ("clip.WEBM", "webm"),
        ("speech.OPUS", "opus"),
        ("video.MP4", "mp4"),
        ("stream.MPEG", "mpeg"),
        ("http://example.com/audio.M4A?sig=12345", "m4a"),
        ("/deep/nested/path/to/FILE.WAV", "wav"),
    ],
)
def test_get_file_format_from_file_path_case_insensitivity(file_path, expected_format):
    assert get_file_format_from_file_path(file_path) == expected_format


def test_get_file_format_from_file_path_unsupported():
    with pytest.raises(ValueError, match="Unsupported file type"):
        get_file_format_from_file_path("document.PDF")


@pytest.mark.parametrize(
    "file_path,expected_mime",
    [
        ("IN685F~1.M4A", "audio/m4a"),
        ("interview.WAV", "audio/wav"),
        ("recording.MP3", "audio/mp3"),
        ("sound.OGG", "audio/ogg"),
        ("track.FLAC", "audio/flac"),
        ("clip.WEBM", "audio/webm"),
        ("speech.OPUS", "audio/opus"),
        ("video.MP4", "video/mp4"),
        ("stream.MPEG", "video/mpeg"),
        ("lower.m4a", "audio/m4a"),
        ("lower.wav", "audio/wav"),
    ],
)
def test_get_mime_type_from_file_path_case_insensitivity(file_path, expected_mime):
    assert get_mime_type_from_file_path(file_path) == expected_mime


def test_split_audio_chunk_preserves_path_and_converts_uppercase_extension(monkeypatch):
    chunk_id = "test-chunk-123"
    input_path = "https://storage.endpoint.com/bucket/uploads/m4a_interviews/IN685F~1.M4A"

    monkeypatch.setattr(
        conversation_service,
        "get_chunk_by_id_or_raise",
        lambda cid: {
            "id": cid,
            "path": input_path,
            "conversation_id": "conv-456",
        },
    )

    conversion_calls = []

    def fake_convert(input_file, output_file, output_format):
        conversion_calls.append(
            {
                "input_file": input_file,
                "output_file": output_file,
                "output_format": output_format,
            }
        )

    monkeypatch.setattr(audio_utils, "convert_and_save_to_s3", fake_convert)

    directus_updates = []
    monkeypatch.setattr(
        directus,
        "update_item",
        lambda collection_name, item_id, item_data: directus_updates.append(
            (collection_name, item_id, item_data)
        ),
    )

    # Return small file size (1000 bytes) so number_chunks == 1 and no ffmpeg probe is triggered
    monkeypatch.setattr(
        s3_client,
        "head_object",
        lambda **_kw: {"ContentLength": 1000},
    )

    result = split_audio_chunk(chunk_id, output_format="mp3")

    assert result == [chunk_id]
    assert len(conversion_calls) == 1
    call = conversion_calls[0]
    assert call["input_file"] == input_path
    # Output file extension is replaced with .mp3, but directory containing 'm4a' is preserved
    assert call["output_file"] == "uploads/m4a_interviews/IN685F~1.mp3"
    assert call["output_format"] == "mp3"

    assert len(directus_updates) == 1
    coll, updated_id, data = directus_updates[0]
    assert coll == "conversation_chunk"
    assert updated_id == chunk_id
    assert data["path"].endswith("/uploads/m4a_interviews/IN685F~1.mp3")
