from typing import Generator
from logging import getLogger
from contextlib import contextmanager

import requests
from directus_py_sdk import DirectusClient

from dembrane.settings import get_settings

logger = getLogger("directus")

settings = get_settings()
directus_token = settings.directus_token
if directus_token:
    logger.debug("Directus token retrieved from settings")

directus = DirectusClient(url=settings.directus_base_url, token=directus_token)


class DirectusGenericException(Exception):
    pass


class DirectusServerError(DirectusGenericException):
    pass


class DirectusBadRequest(DirectusGenericException):
    pass


@contextmanager
def directus_client_context() -> Generator[DirectusClient, None, None]:
    try:
        yield directus
    except Exception as e:
        if isinstance(e, requests.exceptions.ConnectionError):
            raise DirectusServerError(e) from e
        if isinstance(e, AssertionError):
            raise DirectusBadRequest(e) from e
        raise DirectusGenericException(e) from e


# def verify_static_token(static_token: str) -> str, bool:
#     client = DirectusClient(url=DIRECTUS_BASE_URL, token=static_token)
#     try:
#         response: dict = client.get(path="/users/me", output_type="json")
#         logger.debug(f"verify_static_token: {response}")

#         id = response.get("id", None)
#         is_admin = response.get("role", {}).get("name") == "admin"

#         if not id:
#             raise DirectusServerError(response.get("message", "Something went wrong"))

#         return id

#     except Exception as e:
#         raise DirectusBadRequest(e) from e
