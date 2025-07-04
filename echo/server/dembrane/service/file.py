from io import IOBase
from abc import ABC, abstractmethod

from fastapi import UploadFile

from dembrane.s3 import (
    delete_from_s3,
    get_signed_url,
    get_stream_from_s3,
    save_to_s3_from_url,
    save_to_s3_from_file_like,
    get_file_size_bytes_from_s3,
)


class FileServiceException(Exception):
    """Exception raised by the FileService."""

    pass


class FileService(ABC):
    """Abstract base class for file storage services."""

    # Defaults
    FILE_SIZE_LIMIT_MB = 2048

    @abstractmethod
    def save(
        self,
        file: UploadFile,
        key: str,
        public: bool,
    ) -> str:
        """
        Save a file and return an URL to access it.

        Args:
            file: The file to save. (FastAPI.UploadFile)
            key: The key/path for the file. (str)
            public: Whether the url can be accessed publicly. (bool)

        Returns:
            The URL to access the file. (str)
        """
        pass

    @abstractmethod
    def save_from_url(
        self,
        url: str,
        key: str,
        public: bool,
    ) -> str:
        """
        Save a file from a URL and return an URL to access it.

        Args:
            url: The URL of the file to save. (str)
            key: The key/path for the file. (str)
            public: Whether the url can be accessed publicly. (bool)

        Returns:
            The URL to access the file. (str)
        """
        pass

    @abstractmethod
    def get_size(
        self,
        key: str,
    ) -> int:
        """
        Get the size of a file.

        Args:
            key: The key/path of the file. (str)

        Returns:
            The size of the file in bytes. (int)
        """
        pass

    @abstractmethod
    def delete(
        self,
        key: str,
    ) -> None:
        """
        Delete a file.

        Args:
            key: The key/path of the file to delete. (str)
        """
        pass

    @abstractmethod
    def get_access_url(
        self,
        key: str,
    ) -> str:
        """
        Get the URL of a file.

        Args:
            key: The key/path of the file. (str)

        Returns:
            The URL to access the file. (str)
        """
        pass

    @abstractmethod
    def get_stream(
        self,
        key: str,
    ) -> IOBase:
        """
        Get the stream of a file.

        Args:
            key: The key/path of the file. (str)

        Returns:
            The file stream. (IOBase)
        """
        pass


class S3FileService(FileService):
    """S3 implementation of the FileService."""

    def save(
        self,
        file: UploadFile,
        key: str,
        public: bool,
    ) -> str:
        try:
            return save_to_s3_from_file_like(
                file, key, public, size_limit_mb=self.FILE_SIZE_LIMIT_MB
            )
        except Exception as e:
            raise FileServiceException(f"Failed to save file: {e}") from e

    def save_from_url(
        self,
        url: str,
        key: str,
        public: bool,
    ) -> str:
        try:
            return save_to_s3_from_url(url, key, public)
        except Exception as e:
            raise FileServiceException(f"Failed to save file from URL: {e}") from e

    def get_size(
        self,
        key: str,
    ) -> int:
        try:
            return get_file_size_bytes_from_s3(key)
        except Exception as e:
            raise FileServiceException(f"Failed to get file size: {e}") from e

    def delete(
        self,
        key: str,
    ) -> None:
        try:
            delete_from_s3(key)
        except Exception as e:
            raise FileServiceException(f"Failed to delete file: {e}") from e

    def get_access_url(
        self,
        key: str,
    ) -> str:
        try:
            return get_signed_url(key)
        except Exception as e:
            raise FileServiceException(f"Failed to get access URL: {e}") from e

    def get_stream(
        self,
        key: str,
    ) -> IOBase:
        try:
            return get_stream_from_s3(key)
        except Exception as e:
            raise FileServiceException(f"Failed to get stream: {e}") from e


def get_file_service() -> FileService:
    return S3FileService()
