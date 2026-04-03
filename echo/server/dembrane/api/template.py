from typing import List, Literal, Optional
from logging import getLogger

from fastapi import APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.directus import directus
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


class PromptTemplateCreateIn(BaseModel):
    title: str = Field(max_length=200)
    content: str
    icon: Optional[str] = Field(default=None, max_length=50)


class PromptTemplateUpdateIn(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    content: Optional[str] = None
    icon: Optional[str] = Field(default=None, max_length=50)


class PromptTemplatePreferenceOut(BaseModel):
    id: str
    template_type: str
    static_template_id: Optional[str] = None
    prompt_template_id: Optional[str] = None
    sort: int


class QuickAccessPreferenceIn(BaseModel):
    template_type: Literal["static", "user"]
    static_template_id: Optional[str] = None
    prompt_template_id: Optional[str] = None
    sort: int


class AiSuggestionsToggleIn(BaseModel):
    hide_ai_suggestions: bool


# ── Prompt Templates CRUD ──


@TemplateRouter.get("/prompt-templates")
async def list_prompt_templates(
    auth: DependencyDirectusSession,
) -> List[PromptTemplateOut]:
    try:
        items = directus.get_items(
            "prompt_template",
            {
                "query": {
                    "filter": {"user_created": {"_eq": auth.user_id}},
                    "sort": ["sort"],
                    "fields": ["*", "user_created.id", "user_created.first_name"],
                }
            },
        )
        if not isinstance(items, list):
            items = []

        results = []
        for item in items:
            user_created = item.get("user_created") or {}
            is_anonymous = item.get("is_anonymous", False)
            # For own templates: compute author_display_name dynamically if public,
            # but keep stored author_display_name for copied_from attribution
            if item.get("is_public"):
                if is_anonymous:
                    resolved_name = None
                else:
                    resolved_name = user_created.get("first_name") if isinstance(user_created, dict) else None
            else:
                # Private template: use stored author_display_name (for "from {author}" on copies)
                resolved_name = item.get("author_display_name")

            item_data = {**item}
            item_data["author_display_name"] = resolved_name
            item_data["user_created"] = user_created.get("id") if isinstance(user_created, dict) else user_created
            item_data.pop("is_anonymous", None)
            results.append(PromptTemplateOut(**item_data))
        return results
    except Exception as e:
        logger.exception(f"Failed to list prompt templates: {e}")
        raise HTTPException(status_code=500, detail="Failed to list templates") from None


@TemplateRouter.post("/prompt-templates")
async def create_prompt_template(
    body: PromptTemplateCreateIn,
    auth: DependencyDirectusSession,
) -> PromptTemplateOut:
    try:
        result = directus.create_item(
            "prompt_template",
            {
                "title": body.title,
                "content": body.content,
                "icon": body.icon,
            },
        )["data"]
        # Set ownership to the authenticated user (admin client sets user_created to admin)
        directus.update_item("prompt_template", result["id"], {"user_created": auth.user_id})
        result["user_created"] = auth.user_id
        return PromptTemplateOut(**result)
    except Exception as e:
        logger.error(f"Failed to create prompt template: {e}")
        raise HTTPException(status_code=500, detail="Failed to create template") from None


@TemplateRouter.patch("/prompt-templates/{template_id}")
async def update_prompt_template(
    template_id: str,
    body: PromptTemplateUpdateIn,
    auth: DependencyDirectusSession,
) -> PromptTemplateOut:
    # Verify ownership
    try:
        existing = directus.get_item("prompt_template", template_id)
        if not existing or existing.get("user_created") != auth.user_id:
            raise HTTPException(status_code=404, detail="Template not found")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to verify template ownership: {e}")
        raise HTTPException(status_code=500, detail="Failed to update template") from None

    update_data = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    try:
        result = directus.update_item("prompt_template", template_id, update_data)["data"]
        return PromptTemplateOut(**result)
    except Exception as e:
        logger.error(f"Failed to update prompt template: {e}")
        raise HTTPException(status_code=500, detail="Failed to update template") from None


@TemplateRouter.delete("/prompt-templates/{template_id}")
async def delete_prompt_template(
    template_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    # Verify ownership
    try:
        existing = directus.get_item("prompt_template", template_id)
        if not existing or existing.get("user_created") != auth.user_id:
            raise HTTPException(status_code=404, detail="Template not found")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to verify template ownership: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete template") from None

    try:
        directus.delete_item("prompt_template", template_id)
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Failed to delete prompt template: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete template") from None


# ── Quick-Access Preferences ──


@TemplateRouter.get("/quick-access")
async def list_quick_access(
    auth: DependencyDirectusSession,
) -> List[PromptTemplatePreferenceOut]:
    try:
        items = directus.get_items(
            "prompt_template_preference",
            {
                "query": {
                    "filter": {"user_created": {"_eq": auth.user_id}},
                    "sort": ["sort"],
                    "fields": [
                        "id",
                        "template_type",
                        "static_template_id",
                        "prompt_template_id",
                        "sort",
                    ],
                }
            },
        )
        if not isinstance(items, list):
            items = []
        return [PromptTemplatePreferenceOut(**item) for item in items]
    except Exception as e:
        logger.error(f"Failed to list quick access preferences: {e}")
        raise HTTPException(status_code=500, detail="Failed to list preferences") from None


@TemplateRouter.put("/quick-access")
async def save_quick_access(
    body: List[QuickAccessPreferenceIn],
    auth: DependencyDirectusSession,
) -> List[PromptTemplatePreferenceOut]:
    if len(body) > 5:
        raise HTTPException(status_code=400, detail="Maximum 5 quick access items")

    try:
        # Delete existing preferences
        existing = directus.get_items(
            "prompt_template_preference",
            {
                "query": {
                    "filter": {"user_created": {"_eq": auth.user_id}},
                    "fields": ["id"],
                }
            },
        )
        if isinstance(existing, list):
            for pref in existing:
                directus.delete_item("prompt_template_preference", pref["id"])

        # Create new preferences
        results = []
        for pref in body:
            result = directus.create_item(
                "prompt_template_preference",
                {
                    "template_type": pref.template_type,
                    "static_template_id": pref.static_template_id,
                    "prompt_template_id": pref.prompt_template_id,
                    "sort": pref.sort,
                },
            )["data"]
            directus.update_item("prompt_template_preference", result["id"], {"user_created": auth.user_id})
            results.append(PromptTemplatePreferenceOut(**result))

        return results
    except Exception as e:
        logger.error(f"Failed to save quick access preferences: {e}")
        raise HTTPException(status_code=500, detail="Failed to save preferences") from None


# ── AI Suggestions Toggle ──


@TemplateRouter.patch("/ai-suggestions")
async def toggle_ai_suggestions(
    body: AiSuggestionsToggleIn,
    auth: DependencyDirectusSession,
) -> dict:
    try:
        directus.update_user(auth.user_id, {"hide_ai_suggestions": body.hide_ai_suggestions})
        return {"status": "ok", "hide_ai_suggestions": body.hide_ai_suggestions}
    except Exception as e:
        logger.error(f"Failed to toggle AI suggestions: {e}")
        raise HTTPException(status_code=500, detail="Failed to update setting") from None
