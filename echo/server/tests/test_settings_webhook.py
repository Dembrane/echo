import pytest

from dembrane.settings import TranscriptionSettings


def test_dembrane_webhook_url_requires_secret() -> None:
    settings = TranscriptionSettings(
        provider="Dembrane-25-09",
        gcp_sa_json={"type": "service_account"},
    )
    settings.assemblyai_webhook_url = "https://api.example.com/api/webhooks/assemblyai"
    settings.assemblyai_webhook_secret = None

    with pytest.raises(
        ValueError,
        match="ASSEMBLYAI_WEBHOOK_SECRET must be set when ASSEMBLYAI_WEBHOOK_URL is configured",
    ):
        settings.ensure_valid()


def test_dembrane_webhook_url_with_secret_is_valid() -> None:
    settings = TranscriptionSettings(
        provider="Dembrane-25-09",
        gcp_sa_json={"type": "service_account"},
    )
    settings.assemblyai_webhook_url = "https://api.example.com/api/webhooks/assemblyai"
    settings.assemblyai_webhook_secret = "secret"

    settings.ensure_valid()
