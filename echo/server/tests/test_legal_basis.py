import pytest
from fastapi import HTTPException

from dembrane.legal_basis import (
    SOURCE_DEFAULT,
    SOURCE_PROJECT,
    SOURCE_WORKSPACE,
    SOURCE_LEGACY_USER,
    resolve_organiser_name,
    build_legal_basis_write,
    validate_privacy_policy_url,
    resolve_effective_legal_basis,
)


class TestResolveEffectiveLegalBasis:
    def test_project_override_wins(self) -> None:
        result = resolve_effective_legal_basis(
            project={"legal_basis": "consent", "privacy_policy_url": "https://p.example"},
            workspace={"legal_basis": "client-managed", "privacy_policy_url": None},
        )
        assert result.legal_basis == "consent"
        assert result.privacy_policy_url == "https://p.example"
        assert result.source == SOURCE_PROJECT

    def test_workspace_beats_owner(self) -> None:
        result = resolve_effective_legal_basis(
            project={"legal_basis": None},
            workspace={"legal_basis": "consent", "privacy_policy_url": "https://ws.example"},
            owner={"legal_basis": "dembrane-events"},
        )
        assert result.legal_basis == "consent"
        assert result.source == SOURCE_WORKSPACE

    def test_legacy_owner_fallback(self) -> None:
        result = resolve_effective_legal_basis(
            owner={"legal_basis": "consent", "privacy_policy_url": "https://owner.example"}
        )
        assert result.source == SOURCE_LEGACY_USER
        assert result.privacy_policy_url == "https://owner.example"

    def test_default(self) -> None:
        result = resolve_effective_legal_basis()
        assert result.legal_basis == "client-managed"
        assert result.privacy_policy_url is None
        assert result.source == SOURCE_DEFAULT

    def test_pair_coherence_workspace_url_without_basis_is_not_mixed(self) -> None:
        # A workspace URL without a workspace basis must not leak into a
        # value resolved from another level.
        result = resolve_effective_legal_basis(
            workspace={"legal_basis": None, "privacy_policy_url": "https://ws.example"},
            owner={"legal_basis": "client-managed", "privacy_policy_url": None},
        )
        assert result.source == SOURCE_LEGACY_USER
        assert result.privacy_policy_url is None


class TestResolveOrganiserName:
    def test_data_owner_first(self) -> None:
        assert (
            resolve_organiser_name(
                {"data_owner_org_name": "Client B.V."}, {"name": "Partner"}
            )
            == "Client B.V."
        )

    def test_org_name_fallback(self) -> None:
        assert resolve_organiser_name({"data_owner_org_name": None}, {"name": "Partner"}) == "Partner"

    def test_none_when_nothing_available(self) -> None:
        assert resolve_organiser_name(None, None) is None

    def test_external_workspace_never_names_hosting_org(self) -> None:
        # The agency's name must not appear as controller of a client's data.
        assert (
            resolve_organiser_name(
                {"data_owner_org_name": None, "usage_context": "external"},
                {"name": "Agency"},
            )
            is None
        )

    def test_internal_workspace_falls_back_to_org_name(self) -> None:
        assert (
            resolve_organiser_name(
                {"data_owner_org_name": None, "usage_context": "internal"},
                {"name": "Company"},
            )
            == "Company"
        )


class TestValidatePrivacyPolicyUrl:
    def test_accepts_https_and_strips(self) -> None:
        assert validate_privacy_policy_url("  https://a.example/p  ") == "https://a.example/p"

    def test_rejects_bad_scheme(self) -> None:
        with pytest.raises(HTTPException) as exc:
            validate_privacy_policy_url("javascript:alert(1)")
        assert exc.value.status_code == 400

    def test_rejects_over_255_chars(self) -> None:
        with pytest.raises(HTTPException) as exc:
            validate_privacy_policy_url("https://a.example/" + "x" * 255)
        assert exc.value.status_code == 400


class TestBuildLegalBasisWrite:
    def test_returns_none_when_no_legal_fields_sent(self) -> None:
        # Stored consent-without-URL legacy rows must not block unrelated PATCHes.
        result = build_legal_basis_write(
            fields_set={"name"},
            legal_basis=None,
            privacy_policy_url=None,
            stored_legal_basis="consent",
            stored_privacy_policy_url=None,
        )
        assert result is None

    def test_consent_without_url_rejected(self) -> None:
        with pytest.raises(HTTPException) as exc:
            build_legal_basis_write(
                fields_set={"legal_basis"},
                legal_basis="consent",
                privacy_policy_url=None,
                stored_legal_basis=None,
                stored_privacy_policy_url=None,
            )
        assert exc.value.status_code == 400

    def test_consent_with_stored_url_merges(self) -> None:
        result = build_legal_basis_write(
            fields_set={"legal_basis"},
            legal_basis="consent",
            privacy_policy_url=None,
            stored_legal_basis="client-managed",
            stored_privacy_policy_url="https://kept.example",
        )
        assert result is not None
        assert result.payload == {
            "legal_basis": "consent",
            "privacy_policy_url": "https://kept.example",
        }

    def test_url_only_update_validated_against_stored_consent(self) -> None:
        with pytest.raises(HTTPException):
            build_legal_basis_write(
                fields_set={"privacy_policy_url"},
                legal_basis=None,
                privacy_policy_url="",
                stored_legal_basis="consent",
                stored_privacy_policy_url="https://old.example",
            )

    def test_non_consent_nulls_url(self) -> None:
        result = build_legal_basis_write(
            fields_set={"legal_basis", "privacy_policy_url"},
            legal_basis="client-managed",
            privacy_policy_url="https://ignored.example",
            stored_legal_basis="consent",
            stored_privacy_policy_url="https://old.example",
        )
        assert result is not None
        assert result.payload == {"legal_basis": "client-managed", "privacy_policy_url": None}

    def test_clearing_basis_with_null(self) -> None:
        result = build_legal_basis_write(
            fields_set={"legal_basis"},
            legal_basis=None,
            privacy_policy_url=None,
            stored_legal_basis="consent",
            stored_privacy_policy_url="https://old.example",
        )
        assert result is not None
        assert result.payload == {"legal_basis": None, "privacy_policy_url": None}

    def test_invalid_basis_rejected(self) -> None:
        with pytest.raises(HTTPException):
            build_legal_basis_write(
                fields_set={"legal_basis"},
                legal_basis="legitimate-interest",
                privacy_policy_url=None,
                stored_legal_basis=None,
                stored_privacy_policy_url=None,
            )

    def test_dembrane_events_change_requires_email_check(self) -> None:
        result = build_legal_basis_write(
            fields_set={"legal_basis"},
            legal_basis="dembrane-events",
            privacy_policy_url=None,
            stored_legal_basis="client-managed",
            stored_privacy_policy_url=None,
        )
        assert result is not None
        assert result.requires_dembrane_email_check is True

    def test_unchanged_dembrane_events_echo_needs_no_email_check(self) -> None:
        result = build_legal_basis_write(
            fields_set={"legal_basis"},
            legal_basis="dembrane-events",
            privacy_policy_url=None,
            stored_legal_basis="dembrane-events",
            stored_privacy_policy_url=None,
        )
        assert result is not None
        assert result.requires_dembrane_email_check is False
