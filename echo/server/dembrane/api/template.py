from typing import List, Literal, Optional
from logging import getLogger

from fastapi import Query, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.app_user import resolve_app_user
from dembrane.directus import directus
from dembrane.async_helpers import run_in_thread_pool
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = getLogger("api.template")

TemplateRouter = APIRouter()


# ── Schemas ──


class PromptTemplateOut(BaseModel):
    id: str
    title: str
    content: str
    icon: Optional[str] = None
    sort: Optional[int] = None
    is_public: bool = False
    description: Optional[str] = None
    tags: Optional[List[str]] = None
    language: Optional[str] = None
    author_display_name: Optional[str] = None
    use_count: int = 0
    star_count: int = 0
    copied_from: Optional[str] = None
    date_created: Optional[str] = None
    date_updated: Optional[str] = None
    # Workspace-scope fields (matrix v1.1). scope='user' keeps the
    # legacy private-template behavior; scope='workspace' means the
    # row is shared with every workspace member.
    scope: str = "user"
    workspace_id: Optional[str] = None
    can_edit: bool = True


class PromptTemplateCreateIn(BaseModel):
    title: str = Field(max_length=200)
    content: str
    icon: Optional[str] = Field(default=None, max_length=50)
    # Optional — omit or 'user' for personal (legacy) templates.
    scope: Literal["user", "workspace"] = "user"
    workspace_id: Optional[str] = None


class PromptTemplateUpdateIn(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    content: Optional[str] = None
    icon: Optional[str] = Field(default=None, max_length=50)


class QuickAccessItemIn(BaseModel):
    type: Literal["static", "user"]
    id: str


class AiSuggestionsToggleIn(BaseModel):
    hide_ai_suggestions: bool


# ── Helpers ──


async def _get_workspace_membership(
    app_user_id: str, workspace_id: str
) -> Optional[dict]:
    """Return the user's non-deleted workspace_membership row, or None."""
    mems = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role", "is_external"],
                "limit": 1,
            }
        },
    )
    if not isinstance(mems, list) or len(mems) == 0:
        return None
    return mems[0]


# ── Prompt Templates CRUD ──


@TemplateRouter.get("/prompt-templates")
async def list_prompt_templates(
    auth: DependencyDirectusSession,
    workspace_id: Optional[str] = Query(
        default=None,
        description=(
            "If provided, response includes the workspace's shared "
            "(scope='workspace') templates in addition to the user's "
            "own scope='user' templates."
        ),
    ),
) -> List[PromptTemplateOut]:
    """List templates visible to the authenticated user.

    Always includes the caller's scope='user' templates (legacy
    behavior). When workspace_id is provided AND the caller belongs to
    that workspace, also includes the workspace's scope='workspace'
    templates — even for guests (is_external=true) who get read-only
    access.
    """
    try:
        # Personal templates — always owned-only.
        personal_filter = {
            "user_created": {"_eq": auth.user_id},
            "scope": {"_eq": "user"},
        }
        personal = directus.get_items(
            "prompt_template",
            {
                "query": {
                    "filter": personal_filter,
                    "sort": ["sort"],
                    "fields": ["*", "user_created.id", "user_created.first_name"],
                }
            },
        )
        if not isinstance(personal, list):
            personal = []

        # Workspace templates — only when caller is a member.
        workspace_rows: list = []
        is_external_in_ws = False
        if workspace_id:
            app_user = await resolve_app_user(auth.user_id)
            if app_user:
                mem = await _get_workspace_membership(app_user["id"], workspace_id)
                if mem is not None:
                    is_external_in_ws = bool(mem.get("is_external"))
                    workspace_rows_raw = directus.get_items(
                        "prompt_template",
                        {
                            "query": {
                                "filter": {
                                    "workspace_id": {"_eq": workspace_id},
                                    "scope": {"_eq": "workspace"},
                                },
                                "sort": ["sort"],
                                "fields": [
                                    "*",
                                    "user_created.id",
                                    "user_created.first_name",
                                ],
                            }
                        },
                    )
                    if isinstance(workspace_rows_raw, list):
                        workspace_rows = workspace_rows_raw

        results: list[PromptTemplateOut] = []
        for item in [*personal, *workspace_rows]:
            user_created = item.get("user_created") or {}
            is_anonymous = item.get("is_anonymous", False)
            if item.get("is_public"):
                if is_anonymous:
                    resolved_name = None
                else:
                    resolved_name = (
                        user_created.get("first_name")
                        if isinstance(user_created, dict)
                        else None
                    )
            else:
                resolved_name = item.get("author_display_name")

            item_data = {**item}
            item_data["author_display_name"] = resolved_name
            creator_id = (
                user_created.get("id") if isinstance(user_created, dict) else user_created
            )
            item_data["user_created"] = creator_id
            item_data.pop("is_anonymous", None)

            scope = item.get("scope") or "user"
            # Workspace templates editable by any non-external member;
            # personal templates editable only by their creator.
            if scope == "workspace":
                can_edit = not is_external_in_ws
            else:
                can_edit = creator_id == auth.user_id

            item_data["scope"] = scope
            item_data["can_edit"] = can_edit
            results.append(PromptTemplateOut(**item_data))
        return results
    except Exception:
        logger.exception("Failed to list prompt templates")
        raise HTTPException(status_code=500, detail="Failed to list templates") from None


@TemplateRouter.post("/prompt-templates")
async def create_prompt_template(
    body: PromptTemplateCreateIn,
    auth: DependencyDirectusSession,
) -> PromptTemplateOut:
    """Create a template.

    Personal templates (scope='user') — always allowed. Workspace
    templates (scope='workspace') require workspace membership and a
    non-external role (is_external=false); guests are blocked.
    """
    # Validate workspace-scope requests
    if body.scope == "workspace":
        if not body.workspace_id:
            raise HTTPException(
                status_code=400,
                detail="workspace_id is required for scope='workspace'",
            )
        app_user = await resolve_app_user(auth.user_id)
        if not app_user:
            raise HTTPException(status_code=403, detail="Not a workspace member")
        mem = await _get_workspace_membership(app_user["id"], body.workspace_id)
        if mem is None:
            raise HTTPException(status_code=403, detail="Not a workspace member")
        if mem.get("is_external"):
            raise HTTPException(
                status_code=403,
                detail="Guests cannot create workspace templates",
            )

    payload: dict = {
        "title": body.title,
        "content": body.content,
        "icon": body.icon,
        "scope": body.scope,
    }
    if body.scope == "workspace":
        payload["workspace_id"] = body.workspace_id

    try:
        result = directus.create_item("prompt_template", payload)["data"]
        directus.update_item(
            "prompt_template", result["id"], {"user_created": auth.user_id}
        )
        result["user_created"] = auth.user_id
        result["scope"] = body.scope
        result["workspace_id"] = body.workspace_id
        result["can_edit"] = True
        return PromptTemplateOut(**result)
    except Exception:
        logger.exception("Failed to create prompt template")
        raise HTTPException(status_code=500, detail="Failed to create template") from None


@TemplateRouter.patch("/prompt-templates/{template_id}")
async def update_prompt_template(
    template_id: str,
    body: PromptTemplateUpdateIn,
    auth: DependencyDirectusSession,
) -> PromptTemplateOut:
    """Update a template.

    Personal templates — only the creator. Workspace templates — any
    non-external member of the template's workspace.
    """
    try:
        existing = directus.get_item("prompt_template", template_id)
    except Exception:
        logger.exception("Failed to fetch template for update")
        raise HTTPException(status_code=500, detail="Failed to update template") from None
    if not existing:
        raise HTTPException(status_code=404, detail="Template not found")

    scope = existing.get("scope") or "user"
    if scope == "workspace":
        ws_id = existing.get("workspace_id")
        if not ws_id:
            # Shouldn't happen, but guard anyway.
            raise HTTPException(status_code=404, detail="Template not found")
        app_user = await resolve_app_user(auth.user_id)
        if not app_user:
            raise HTTPException(status_code=403, detail="Not a workspace member")
        mem = await _get_workspace_membership(app_user["id"], ws_id)
        if mem is None or mem.get("is_external"):
            raise HTTPException(status_code=403, detail="Not allowed to edit this template")
    else:
        if existing.get("user_created") != auth.user_id:
            raise HTTPException(status_code=404, detail="Template not found")

    update_data = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    try:
        result = directus.update_item("prompt_template", template_id, update_data)["data"]
        result["scope"] = scope
        result["can_edit"] = True
        return PromptTemplateOut(**result)
    except Exception:
        logger.exception("Failed to update prompt template")
        raise HTTPException(status_code=500, detail="Failed to update template") from None


@TemplateRouter.delete("/prompt-templates/{template_id}")
async def delete_prompt_template(
    template_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Delete a template. Same role rules as update."""
    try:
        existing = directus.get_item("prompt_template", template_id)
    except Exception:
        logger.exception("Failed to fetch template for delete")
        raise HTTPException(status_code=500, detail="Failed to delete template") from None
    if not existing:
        raise HTTPException(status_code=404, detail="Template not found")

    scope = existing.get("scope") or "user"
    if scope == "workspace":
        ws_id = existing.get("workspace_id")
        if not ws_id:
            raise HTTPException(status_code=404, detail="Template not found")
        app_user = await resolve_app_user(auth.user_id)
        if not app_user:
            raise HTTPException(status_code=403, detail="Not a workspace member")
        mem = await _get_workspace_membership(app_user["id"], ws_id)
        if mem is None or mem.get("is_external"):
            raise HTTPException(status_code=403, detail="Not allowed to delete this template")
    else:
        if existing.get("user_created") != auth.user_id:
            raise HTTPException(status_code=404, detail="Template not found")

    try:
        directus.delete_item("prompt_template", template_id)
        return {"status": "ok"}
    except Exception:
        logger.exception("Failed to delete prompt template")
        raise HTTPException(status_code=500, detail="Failed to delete template") from None


# ── Quick-Access Preferences ──


@TemplateRouter.get("/quick-access")
async def get_quick_access(
    auth: DependencyDirectusSession,
) -> list:
    """Get the user's quick access preferences as a JSON array."""
    try:
        users = await run_in_thread_pool(
            directus.get_users,
            {
                "query": {
                    "filter": {"id": {"_eq": auth.user_id}},
                    "fields": ["quick_access_preferences"],
                    "limit": 1,
                }
            },
        )
        if not isinstance(users, list) or len(users) == 0:
            return []
        prefs = users[0].get("quick_access_preferences")
        if not isinstance(prefs, list):
            return []
        return prefs
    except Exception:
        logger.exception("Failed to get quick access preferences")
        raise HTTPException(status_code=500, detail="Failed to get preferences") from None


@TemplateRouter.put("/quick-access")
async def save_quick_access(
    body: List[QuickAccessItemIn],
    auth: DependencyDirectusSession,
) -> list:
    """Save the user's quick access preferences as a JSON array."""
    if len(body) > 5:
        raise HTTPException(status_code=400, detail="Maximum 5 quick access items")

    seen = set()
    for item in body:
        key = (item.type, item.id)
        if key in seen:
            raise HTTPException(status_code=400, detail=f"Duplicate item: {item.type}:{item.id}")
        seen.add(key)

    # Validate user templates exist and are visible to the caller
    # (owned by them, OR workspace-shared with a workspace they belong to).
    for item in body:
        if item.type == "user":
            try:
                template = await run_in_thread_pool(
                    directus.get_item, "prompt_template", item.id
                )
                if not template:
                    raise HTTPException(
                        status_code=400, detail=f"Template not found: {item.id}"
                    )
                scope = template.get("scope") or "user"
                if scope == "workspace":
                    ws_id = template.get("workspace_id")
                    if not ws_id:
                        raise HTTPException(
                            status_code=400, detail=f"Template not found: {item.id}"
                        )
                    app_user = await resolve_app_user(auth.user_id)
                    if not app_user:
                        raise HTTPException(
                            status_code=400, detail=f"Template not found: {item.id}"
                        )
                    mem = await _get_workspace_membership(app_user["id"], ws_id)
                    if mem is None:
                        raise HTTPException(
                            status_code=400, detail=f"Template not found: {item.id}"
                        )
                else:
                    if template.get("user_created") != auth.user_id:
                        raise HTTPException(
                            status_code=400, detail=f"Template not found: {item.id}"
                        )
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(
                    status_code=400, detail=f"Template not found: {item.id}"
                ) from None

    prefs = [{"type": item.type, "id": item.id} for item in body]

    try:
        await run_in_thread_pool(
            directus.update_user, auth.user_id, {"quick_access_preferences": prefs}
        )
        return prefs
    except Exception:
        logger.exception("Failed to save quick access preferences")
        raise HTTPException(status_code=500, detail="Failed to save preferences") from None


# ── AI Suggestions Toggle ──


@TemplateRouter.patch("/ai-suggestions")
async def toggle_ai_suggestions(
    body: AiSuggestionsToggleIn,
    auth: DependencyDirectusSession,
) -> dict:
    try:
        await run_in_thread_pool(
            directus.update_user, auth.user_id, {"hide_ai_suggestions": body.hide_ai_suggestions}
        )
        return {"status": "ok", "hide_ai_suggestions": body.hide_ai_suggestions}
    except Exception:
        logger.exception("Failed to toggle AI suggestions")
        raise HTTPException(status_code=500, detail="Failed to update setting") from None
