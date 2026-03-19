from typing import List, Literal, Optional
from logging import getLogger

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

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


class PromptTemplateRatingIn(BaseModel):
    prompt_template_id: str
    rating: Literal[1, 2]  # 1 = thumbs down, 2 = thumbs up
    chat_message_id: Optional[str] = None


class PromptTemplateRatingOut(BaseModel):
    id: str
    prompt_template_id: str
    rating: int
    chat_message_id: Optional[str] = None
    date_created: Optional[str] = None


ALLOWED_TAGS = ["Workshop", "Interview", "Focus Group", "Meeting", "Research", "Community", "Education", "Analysis"]


class CommunityTemplateOut(BaseModel):
    id: str
    title: str
    description: Optional[str] = None
    content: str
    tags: Optional[List[str]] = None
    language: Optional[str] = None
    author_display_name: Optional[str] = None
    star_count: int = 0
    use_count: int = 0
    date_created: Optional[str] = None
    is_own: bool = False


class PublishTemplateIn(BaseModel):
    description: Optional[str] = Field(default=None, max_length=500)
    tags: Optional[List[str]] = Field(default=None)
    language: Optional[str] = Field(default=None, max_length=10)
    is_anonymous: bool = False


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
        raise HTTPException(status_code=500, detail="Failed to list templates") from e


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
        raise HTTPException(status_code=500, detail="Failed to create template") from e


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
        raise HTTPException(status_code=500, detail="Failed to update template") from e

    update_data = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    try:
        result = directus.update_item("prompt_template", template_id, update_data)["data"]
        return PromptTemplateOut(**result)
    except Exception as e:
        logger.error(f"Failed to update prompt template: {e}")
        raise HTTPException(status_code=500, detail="Failed to update template") from e


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
        raise HTTPException(status_code=500, detail="Failed to delete template") from e

    try:
        directus.delete_item("prompt_template", template_id)
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Failed to delete prompt template: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete template") from e


# ── Community Marketplace ──


@TemplateRouter.get("/community")
async def list_community_templates(
    auth: DependencyDirectusSession,
    search: Optional[str] = None,
    tag: Optional[str] = None,
    language: Optional[str] = None,
    sort: str = "newest",  # "newest", "most_starred", "most_used"
    page: int = 1,
    limit: int = 20,
) -> List[CommunityTemplateOut]:
    try:
        filter_query: dict = {"is_public": {"_eq": True}}

        if search:
            filter_query["_or"] = [
                {"title": {"_contains": search}},
                {"description": {"_contains": search}},
            ]

        if tag:
            filter_query["tags"] = {"_contains": tag}

        if language:
            filter_query["language"] = {"_eq": language}

        sort_mapping = {
            "newest": "-date_created",
            "most_starred": "-star_count",
            "most_used": "-use_count",
        }
        sort_field = sort_mapping.get(sort, "-date_created")
        offset = (page - 1) * limit

        items = directus.get_items(
            "prompt_template",
            {
                "query": {
                    "filter": filter_query,
                    "sort": [sort_field],
                    "fields": ["*", "user_created.id", "user_created.first_name"],
                    "limit": limit,
                    "offset": offset,
                }
            },
        )
        if not isinstance(items, list):
            items = []

        results = []
        for item in items:
            user_created = item.get("user_created") or {}
            user_id = user_created.get("id") if isinstance(user_created, dict) else user_created
            is_anonymous = item.get("is_anonymous", False)
            if is_anonymous:
                author_name = None
            else:
                author_name = user_created.get("first_name") if isinstance(user_created, dict) else None

            results.append(
                CommunityTemplateOut(
                    id=item["id"],
                    title=item["title"],
                    description=item.get("description"),
                    content=item["content"],
                    tags=item.get("tags"),
                    language=item.get("language"),
                    author_display_name=author_name,
                    star_count=item.get("star_count", 0),
                    use_count=item.get("use_count", 0),
                    date_created=item.get("date_created"),
                    is_own=(user_id == auth.user_id),
                )
            )
        return results
    except Exception as e:
        logger.error(f"Failed to list community templates: {e}")
        return []


@TemplateRouter.get("/community/my-stars")
async def get_my_community_stars(
    auth: DependencyDirectusSession,
) -> List[str]:
    try:
        items = directus.get_items(
            "prompt_template_rating",
            {
                "query": {
                    "filter": {
                        "user_created": {"_eq": auth.user_id},
                        "chat_message_id": {"_null": True},
                        "rating": {"_eq": 2},
                    },
                    "fields": ["prompt_template_id"],
                }
            },
        )
        if not isinstance(items, list):
            return []
        return [item["prompt_template_id"] for item in items]
    except Exception as e:
        logger.error(f"Failed to get community stars: {e}")
        return []


@TemplateRouter.post("/prompt-templates/{template_id}/publish")
async def publish_template(
    template_id: str,
    body: PublishTemplateIn,
    auth: DependencyDirectusSession,
) -> PromptTemplateOut:
    try:
        existing = directus.get_item("prompt_template", template_id)
        if not existing or existing.get("user_created") != auth.user_id:
            raise HTTPException(status_code=404, detail="Template not found")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to verify template ownership: {e}")
        raise HTTPException(status_code=500, detail="Failed to publish template") from e

    if body.tags:
        if len(body.tags) > 3:
            raise HTTPException(status_code=400, detail="Maximum 3 tags allowed")
        for t in body.tags:
            if t not in ALLOWED_TAGS:
                raise HTTPException(status_code=400, detail=f"Invalid tag: {t}")

    try:
        update_data: dict = {"is_public": True, "is_anonymous": body.is_anonymous}
        if body.description is not None:
            update_data["description"] = body.description
        if body.tags is not None:
            update_data["tags"] = body.tags
        if body.language is not None:
            update_data["language"] = body.language

        result = directus.update_item("prompt_template", template_id, update_data)["data"]
        return PromptTemplateOut(**result)
    except Exception as e:
        logger.error(f"Failed to publish template: {e}")
        raise HTTPException(status_code=500, detail="Failed to publish template") from e


@TemplateRouter.post("/prompt-templates/{template_id}/unpublish")
async def unpublish_template(
    template_id: str,
    auth: DependencyDirectusSession,
) -> PromptTemplateOut:
    try:
        existing = directus.get_item("prompt_template", template_id)
        if not existing or existing.get("user_created") != auth.user_id:
            raise HTTPException(status_code=404, detail="Template not found")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to verify template ownership: {e}")
        raise HTTPException(status_code=500, detail="Failed to unpublish template") from e

    try:
        result = directus.update_item("prompt_template", template_id, {"is_public": False})["data"]
        return PromptTemplateOut(**result)
    except Exception as e:
        logger.error(f"Failed to unpublish template: {e}")
        raise HTTPException(status_code=500, detail="Failed to unpublish template") from e


@TemplateRouter.post("/prompt-templates/{template_id}/star")
async def toggle_star(
    template_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    try:
        existing_ratings = directus.get_items(
            "prompt_template_rating",
            {
                "query": {
                    "filter": {
                        "user_created": {"_eq": auth.user_id},
                        "prompt_template_id": {"_eq": template_id},
                        "chat_message_id": {"_null": True},
                        "rating": {"_eq": 2},
                    },
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )

        template = directus.get_item("prompt_template", template_id)
        if not template:
            raise HTTPException(status_code=404, detail="Template not found")

        current_count = template.get("star_count", 0) or 0

        if isinstance(existing_ratings, list) and len(existing_ratings) > 0:
            # Remove star
            directus.delete_item("prompt_template_rating", existing_ratings[0]["id"])
            new_count = max(0, current_count - 1)
            directus.update_item("prompt_template", template_id, {"star_count": new_count})["data"]
            return {"starred": False, "star_count": new_count}
        else:
            # Add star
            star_result = directus.create_item(
                "prompt_template_rating",
                {"prompt_template_id": template_id, "rating": 2},
            )["data"]
            directus.update_item("prompt_template_rating", star_result["id"], {"user_created": auth.user_id})
            new_count = current_count + 1
            directus.update_item("prompt_template", template_id, {"star_count": new_count})["data"]
            return {"starred": True, "star_count": new_count}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to toggle star: {e}")
        raise HTTPException(status_code=500, detail="Failed to toggle star") from e


@TemplateRouter.post("/prompt-templates/{template_id}/copy")
async def copy_template(
    template_id: str,
    auth: DependencyDirectusSession,
) -> PromptTemplateOut:
    try:
        # Fetch source with nested user_created to resolve author name
        source_items = directus.get_items(
            "prompt_template",
            {
                "query": {
                    "filter": {"id": {"_eq": template_id}},
                    "fields": ["*", "user_created.id", "user_created.first_name"],
                    "limit": 1,
                }
            },
        )
        if not isinstance(source_items, list) or len(source_items) == 0:
            raise HTTPException(status_code=404, detail="Template not found")
        source = source_items[0]

        user_created = source.get("user_created") or {}
        source_user_id = user_created.get("id") if isinstance(user_created, dict) else user_created
        is_public = source.get("is_public", False)
        is_own = source_user_id == auth.user_id
        if not is_public and not is_own:
            raise HTTPException(status_code=404, detail="Template not found")

        # Snapshot author name at copy time
        is_anonymous = source.get("is_anonymous", False)
        if is_anonymous:
            copied_author_name = None
        else:
            copied_author_name = user_created.get("first_name") if isinstance(user_created, dict) else None

        new_template = directus.create_item(
            "prompt_template",
            {
                "title": source["title"],
                "content": source["content"],
                "copied_from": template_id,
                "author_display_name": copied_author_name,
            },
        )["data"]
        directus.update_item("prompt_template", new_template["id"], {"user_created": auth.user_id})
        new_template["user_created"] = auth.user_id

        # Increment use_count on source
        current_use_count = source.get("use_count", 0) or 0
        directus.update_item("prompt_template", template_id, {"use_count": current_use_count + 1})["data"]

        return PromptTemplateOut(**new_template)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to copy template: {e}")
        raise HTTPException(status_code=500, detail="Failed to copy template") from e


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
        raise HTTPException(status_code=500, detail="Failed to list preferences") from e


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
        raise HTTPException(status_code=500, detail="Failed to save preferences") from e


# ── Ratings ──


@TemplateRouter.post("/ratings")
async def rate_prompt_template(
    body: PromptTemplateRatingIn,
    auth: DependencyDirectusSession,
) -> PromptTemplateRatingOut:
    try:
        # Check if user already rated this template (upsert pattern)
        existing = directus.get_items(
            "prompt_template_rating",
            {
                "query": {
                    "filter": {
                        "user_created": {"_eq": auth.user_id},
                        "prompt_template_id": {"_eq": body.prompt_template_id},
                        # If chat_message_id is provided, rate that specific use
                        # Otherwise, rate the template overall (favorite)
                        **({"chat_message_id": {"_eq": body.chat_message_id}} if body.chat_message_id else {"chat_message_id": {"_null": True}}),
                    },
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )

        if isinstance(existing, list) and len(existing) > 0:
            # Update existing rating
            result = directus.update_item(
                "prompt_template_rating",
                existing[0]["id"],
                {"rating": body.rating},
            )["data"]
            return PromptTemplateRatingOut(**result)

        # Create new rating
        payload: dict = {
            "prompt_template_id": body.prompt_template_id,
            "rating": body.rating,
        }
        if body.chat_message_id:
            payload["chat_message_id"] = body.chat_message_id

        result = directus.create_item("prompt_template_rating", payload)["data"]
        directus.update_item("prompt_template_rating", result["id"], {"user_created": auth.user_id})
        return PromptTemplateRatingOut(**result)
    except Exception as e:
        logger.error(f"Failed to rate prompt template: {e}")
        raise HTTPException(status_code=500, detail="Failed to rate template") from e


@TemplateRouter.delete("/ratings/{rating_id}")
async def delete_rating(
    rating_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    try:
        existing = directus.get_item("prompt_template_rating", rating_id)
        if not existing or existing.get("user_created") != auth.user_id:
            raise HTTPException(status_code=404, detail="Rating not found")
        directus.delete_item("prompt_template_rating", rating_id)
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete rating: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete rating") from e


@TemplateRouter.get("/ratings")
async def list_my_ratings(
    auth: DependencyDirectusSession,
) -> List[PromptTemplateRatingOut]:
    """List all ratings by the current user (for favorites and history)."""
    try:
        items = directus.get_items(
            "prompt_template_rating",
            {
                "query": {
                    "filter": {"user_created": {"_eq": auth.user_id}},
                    "sort": ["-date_created"],
                    "fields": [
                        "id",
                        "prompt_template_id",
                        "rating",
                        "chat_message_id",
                        "date_created",
                    ],
                }
            },
        )
        if not isinstance(items, list):
            items = []
        return [PromptTemplateRatingOut(**item) for item in items]
    except Exception as e:
        logger.error(f"Failed to list ratings: {e}")
        raise HTTPException(status_code=500, detail="Failed to list ratings") from e


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
        raise HTTPException(status_code=500, detail="Failed to update setting") from e
