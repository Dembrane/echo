"""Legal basis cascade: project override -> workspace -> legacy owner ->
client-managed. Basis and privacy URL always resolve as a pair from one level."""

from typing import Any, Optional
from logging import getLogger
from dataclasses import dataclass

from fastapi import HTTPException

from dembrane.directus_async import async_directus
from dembrane.billing_account import workspace_is_external_client

logger = getLogger("legal_basis")

LEGAL_BASIS_VALUES = ("client-managed", "consent", "dembrane-events")
DEFAULT_LEGAL_BASIS = "client-managed"

SOURCE_PROJECT = "project"
SOURCE_WORKSPACE = "workspace"
SOURCE_LEGACY_USER = "legacy_user"
SOURCE_DEFAULT = "default"

# 255 = varchar cap on every privacy_policy_url column
_URL_SCHEMES = ("http://", "https://")
_MAX_URL_LENGTH = 255


@dataclass(frozen=True)
class EffectiveLegalBasis:
    legal_basis: str
    privacy_policy_url: Optional[str]
    source: str


def resolve_effective_legal_basis(
    project: Optional[dict[str, Any]] = None,
    workspace: Optional[dict[str, Any]] = None,
    owner: Optional[dict[str, Any]] = None,
) -> EffectiveLegalBasis:
    """First level with a legal_basis wins; its URL comes along as a pair."""
    if project and project.get("legal_basis"):
        return EffectiveLegalBasis(
            project["legal_basis"], project.get("privacy_policy_url"), SOURCE_PROJECT
        )
    if workspace and workspace.get("legal_basis"):
        return EffectiveLegalBasis(
            workspace["legal_basis"], workspace.get("privacy_policy_url"), SOURCE_WORKSPACE
        )
    if owner and owner.get("legal_basis"):
        return EffectiveLegalBasis(
            owner["legal_basis"], owner.get("privacy_policy_url"), SOURCE_LEGACY_USER
        )
    return EffectiveLegalBasis(DEFAULT_LEGAL_BASIS, None, SOURCE_DEFAULT)


def resolve_organiser_name(
    workspace: Optional[dict[str, Any]],
    org: Optional[dict[str, Any]],
) -> Optional[str]:
    """Consent-card name: data owner, else org name. External workspaces never
    fall back to the org name (the org is not the controller of client data)."""
    if workspace and workspace.get("data_owner_org_name"):
        return workspace["data_owner_org_name"]
    if workspace is not None and workspace_is_external_client(workspace):
        return None
    if org and org.get("name"):
        return org["name"]
    return None


def validate_privacy_policy_url(value: str) -> str:
    cleaned = value.strip()
    if len(cleaned) > _MAX_URL_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Privacy policy URL must be {_MAX_URL_LENGTH} characters or fewer",
        )
    if not cleaned.lower().startswith(_URL_SCHEMES):
        raise HTTPException(
            status_code=400,
            detail="Privacy policy URL must start with http:// or https://",
        )
    return cleaned


@dataclass(frozen=True)
class LegalBasisWrite:
    payload: dict[str, Any]
    # Only when dembrane-events is NEWLY set; an unchanged echo must never 403
    requires_dembrane_email_check: bool


def build_legal_basis_write(
    *,
    fields_set: set[str],
    legal_basis: Optional[str],
    privacy_policy_url: Optional[str],
    stored_legal_basis: Optional[str],
    stored_privacy_policy_url: Optional[str],
) -> Optional[LegalBasisWrite]:
    """Validate a legal edit against the merged state of one level. Returns None
    when no legal field is in the payload, so stale rows never block other PATCHes."""
    basis_sent = "legal_basis" in fields_set
    url_sent = "privacy_policy_url" in fields_set
    if not basis_sent and not url_sent:
        return None

    if basis_sent and legal_basis is not None and legal_basis not in LEGAL_BASIS_VALUES:
        raise HTTPException(status_code=400, detail="Invalid legal basis")

    new_basis = legal_basis if basis_sent else stored_legal_basis
    new_url = privacy_policy_url if url_sent else stored_privacy_policy_url

    if new_basis == "consent":
        if not new_url or not new_url.strip():
            raise HTTPException(
                status_code=400,
                detail="A privacy policy link is required for consent-based processing",
            )
        new_url = validate_privacy_policy_url(new_url)
    else:
        new_url = None

    return LegalBasisWrite(
        payload={"legal_basis": new_basis, "privacy_policy_url": new_url},
        requires_dembrane_email_check=(
            new_basis == "dembrane-events" and stored_legal_basis != "dembrane-events"
        ),
    )


async def require_dembrane_email(
    directus_user_id: Optional[str] = None,
    app_user_id: Optional[str] = None,
) -> None:
    """403 unless the acting user has a @dembrane.com email."""
    try:
        email = ""
        if directus_user_id:
            users = await async_directus.get_users(
                {
                    "query": {
                        "filter": {"id": {"_eq": directus_user_id}},
                        "fields": ["email"],
                    }
                }
            )
            email = users[0].get("email", "") if users else ""
        elif app_user_id:
            app_user = await async_directus.get_item("app_user", app_user_id)
            email = (app_user or {}).get("email", "")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to verify user email: {e}")
        raise HTTPException(status_code=500, detail="Failed to verify user") from None
    if not email or not email.lower().endswith("@dembrane.com"):
        raise HTTPException(
            status_code=403,
            detail="dembrane-events is only available for dembrane accounts",
        )


@dataclass(frozen=True)
class CascadeRows:
    workspace: Optional[dict[str, Any]]
    org: Optional[dict[str, Any]]
    owner: Optional[dict[str, Any]]


async def fetch_cascade_rows(project: dict[str, Any]) -> CascadeRows:
    """Fetch the cascade rows for a project. Best-effort: a Directus hiccup on
    one level degrades to the next instead of failing the request."""
    workspace: Optional[dict[str, Any]] = None
    org: Optional[dict[str, Any]] = None
    owner: Optional[dict[str, Any]] = None

    workspace_id = project.get("workspace_id")
    if workspace_id:
        try:
            rows = await async_directus.get_items(
                "workspace",
                {
                    "query": {
                        "filter": {"id": {"_eq": workspace_id}, "deleted_at": {"_null": True}},
                        "fields": [
                            "logo_url",
                            "legal_basis",
                            "privacy_policy_url",
                            "usage_context",
                            "data_owner_org_name",
                            "data_owner_email",
                            "billed_to_team_id",
                            "org_id.id",
                            "org_id.name",
                            "org_id.deleted_at",
                        ],
                        "limit": 1,
                    }
                },
            )
            if isinstance(rows, list) and rows:
                workspace = rows[0]
                org_row = workspace.get("org_id")
                if isinstance(org_row, dict):
                    # raw id back on the row so workspace_is_external_client works
                    workspace["org_id"] = org_row.get("id")
                    if not org_row.get("deleted_at"):
                        org = org_row
        except Exception as e:
            logger.warning(f"Failed to resolve workspace for project {project.get('id')}: {e}")

    # Skip the owner lookup when nothing can need it. The project override
    # doesn't count: the inherited pair (sans override) may still reach the owner.
    basis_resolved = bool(workspace and workspace.get("legal_basis"))
    logo_resolved = bool(workspace and workspace.get("logo_url"))

    directus_user_id = project.get("directus_user_id")
    if directus_user_id and not (basis_resolved and logo_resolved):
        try:
            users = await async_directus.get_users(
                {
                    "query": {
                        "filter": {"id": {"_eq": directus_user_id}},
                        "fields": ["whitelabel_logo", "legal_basis", "privacy_policy_url"],
                    }
                }
            )
            if users:
                owner = users[0]
        except Exception as e:
            logger.warning(f"Failed to resolve owner for project {project.get('id')}: {e}")

    return CascadeRows(workspace=workspace, org=org, owner=owner)
