import os
import pytest


@pytest.fixture(scope="session")
def api_url():
    """Base API URL for smoke tests"""
    return os.getenv("TEST_API_URL", "https://api.echo-testing.dembrane.com")


@pytest.fixture(scope="session")
def directus_url():
    """Directus URL for smoke tests"""
    return os.getenv("TEST_DIRECTUS_URL", "https://directus.echo-testing.dembrane.com")

