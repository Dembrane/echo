from logging import getLogger

import sentry_sdk
from sentry_sdk.integrations.openai import OpenAIIntegration
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from dembrane.config import (
    ENVIRONMENT,
    BUILD_VERSION,
    DISABLE_SENTRY,
)

logger = getLogger("sentry")

ATTEMPTED_SENTRY_INIT = False


def init_sentry() -> None:
    global ATTEMPTED_SENTRY_INIT
    if ATTEMPTED_SENTRY_INIT:
        logger.info("sentry already initialized")
        return

    logger.info("attempting to initializing sentry")
    ATTEMPTED_SENTRY_INIT = True

    if not DISABLE_SENTRY:
        logger.info("initializing sentry")
        sentry_sdk.init(
            dsn="https://0037fa05e4f0e472dffaecbb7d25be3a@o4507107162652672.ingest.de.sentry.io/4507107472703568",
            environment=ENVIRONMENT,
            release=BUILD_VERSION,
            traces_sample_rate=0.5,
            profiles_sample_rate=0.5,
            enable_tracing=True,
            integrations=[
                StarletteIntegration(
                    transaction_style="endpoint",
                    failed_request_status_codes={*range(400, 499), *range(500, 599)},
                ),
                FastApiIntegration(
                    transaction_style="endpoint",
                    failed_request_status_codes={*range(400, 499), *range(500, 599)},
                ),
                # TODO: finish the impl https://docs.sentry.io/platforms/python/integrations/openai/
                # https://docs.sentry.io/platforms/python/integrations/anthropic/
                OpenAIIntegration(
                    include_prompts=False,  # LLM/tokenizer inputs/outputs will be not sent to Sentry, despite send_default_pii=True
                    tiktoken_encoding_name="cl100k_base",
                ),
            ],
        )
    else:
        logger.info("sentry is disabled by DISABLE_SENTRY")
