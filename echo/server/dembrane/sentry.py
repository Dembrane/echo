from logging import getLogger

import sentry_sdk
from sentry_dramatiq import DramatiqIntegration

from dembrane.settings import get_settings

logger = getLogger("sentry")

ATTEMPTED_SENTRY_INIT = False
settings = get_settings()
ENVIRONMENT = settings.environment
BUILD_VERSION = settings.build.build_version
DISABLE_SENTRY = settings.feature_flags.disable_sentry


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
                DramatiqIntegration(),
            ],
        )
    else:
        logger.info("sentry is disabled by DISABLE_SENTRY")
