import logging

from openai import OpenAI

from dembrane.config import OPENAI_API_KEY, OPENAI_API_BASE_URL

client = OpenAI(base_url=OPENAI_API_BASE_URL, api_key=OPENAI_API_KEY)

# set openai logger to warn
logging.getLogger("openai").setLevel(logging.WARNING)
