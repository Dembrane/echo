import logging
from io import BytesIO

import pytest
import requests
from fastapi import UploadFile

from dembrane.utils import generate_uuid
from dembrane.service.file import S3FileService, FileServiceException

logger = logging.getLogger(__name__)


class TestS3FileService:
    """Test S3FileService implementation."""

    def test_save_from_url(self):
        """Test saving file from URL."""
        service = S3FileService()

        key = f"test/{generate_uuid()}.aac"

        result = service.save_from_url(
            url="https://github.com/NicolasCARPi/example-files/raw/refs/heads/master/example.aac",
            key=key,
            public=True,
        )

        assert result is not None
        assert result.startswith("https://")
        assert result.endswith(".aac")

        service.delete(key=key)

    def test_get_size(self):
        """Test getting file size."""
        service = S3FileService()

        key = f"test/{generate_uuid()}.aac"

        result = service.save_from_url(
            url="https://github.com/NicolasCARPi/example-files/raw/refs/heads/master/example.aac",
            key=key,
            public=True,
        )

        size = service.get_size(result)

        assert size is not None
        assert size > 0

        # file is 48.7KB
        logger.info(f"size: {size}")
        assert pytest.approx(size, 48.7 * 1024) == 48.7 * 1024

        service.delete(key=key)

    def test_delete(self):
        """Test deleting file."""
        service = S3FileService()

        key = f"test/{generate_uuid()}.aac"

        service.save_from_url(
            url="https://github.com/NicolasCARPi/example-files/raw/refs/heads/master/example.aac",
            key=key,
            public=True,
        )

        service.delete(key=key)

        with pytest.raises(FileServiceException):
            service.get_size(key=key)

    def test_get_access_url(self):
        """Test getting access URL."""
        service = S3FileService()

        key = f"test/{generate_uuid()}.aac"

        result = service.save_from_url(
            url="https://github.com/NicolasCARPi/example-files/raw/refs/heads/master/example.aac",
            key=key,
            public=True,
        )

        assert result is not None

        response = requests.get(result)

        assert response.status_code == 200
        assert response.content is not None

        service.delete(key=key)

    def test_get_stream(self):
        """Test getting file stream."""
        service = S3FileService()

        key = f"test/{generate_uuid()}.aac"

        result = service.save_from_url(
            url="https://github.com/NicolasCARPi/example-files/raw/refs/heads/master/example.aac",
            key=key,
            public=True,
        )

        assert result is not None

        stream = service.get_stream(key=key)

        assert stream is not None
        assert stream.read(8) is not None

        logger.info(f"stream: {stream.read(8)}")

        service.delete(key=key)

    def test_save_with_file_upload(self):
        service = S3FileService()

        file_content = b"Test content"
        file_obj = UploadFile(filename="test.txt", file=BytesIO(file_content))

        key = f"test/{generate_uuid()}.txt"

        result = service.save(file=file_obj, key=key, public=True)

        assert result is not None
        assert result.startswith("https://")
        assert result.endswith(".txt")

        service.delete(key=key)
