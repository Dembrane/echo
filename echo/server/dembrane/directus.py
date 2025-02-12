from logging import getLogger

from directus_sdk_py import DirectusClient  # type: ignore

from dembrane.config import DIRECTUS_TOKEN, DIRECTUS_BASE_URL

logger = getLogger(__name__)

directus_token = "admin"

if DIRECTUS_TOKEN:
    directus_token = DIRECTUS_TOKEN

directus = DirectusClient(url=DIRECTUS_BASE_URL, token=DIRECTUS_TOKEN)
