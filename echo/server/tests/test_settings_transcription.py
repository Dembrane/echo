import pytest

from dembrane.settings import TranscriptionSettings


def test_dembrane_26_07_requires_gcp_sa_json() -> None:
    settings = TranscriptionSettings()
    settings.provider = "Dembrane-26-07"
    settings.gcp_sa_json = None
    with pytest.raises(ValueError, match="GCP_SA_JSON must be provided"):
        settings.ensure_valid()


def test_dembrane_26_07_valid_with_gcp_sa_json() -> None:
    settings = TranscriptionSettings()
    settings.provider = "Dembrane-26-07"
    settings.gcp_sa_json = {"type": "service_account"}
    settings.ensure_valid()
