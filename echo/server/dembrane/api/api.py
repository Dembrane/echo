from logging import getLogger

from fastapi import (
    APIRouter,
)

from dembrane.api.chat import ChatRouter
from dembrane.api.stats import StatsRouter
from dembrane.api.search import SearchRouter
from dembrane.api.verify import VerifyRouter
from dembrane.api.agentic import AgenticRouter
from dembrane.api.project import ProjectRouter
from dembrane.api.webhooks import WebhooksRouter
from dembrane.api.stateless import StatelessRouter
from dembrane.api.participant import ParticipantRouter
from dembrane.api.conversation import ConversationRouter
from dembrane.api.user_settings import UserSettingsRouter
from dembrane.api.project_webhook import ProjectWebhookRouter

logger = getLogger("api")

api = APIRouter()


@api.get("/health")
async def health() -> dict:
    return {"status": "ok"}


api.include_router(ChatRouter, prefix="/chats")
api.include_router(ProjectRouter, prefix="/projects")
api.include_router(ProjectWebhookRouter, prefix="/projects")
api.include_router(ParticipantRouter, prefix="/participant")
api.include_router(ConversationRouter, prefix="/conversations")
api.include_router(AgenticRouter, prefix="/agentic")
api.include_router(StatelessRouter, prefix="/stateless")
api.include_router(VerifyRouter, prefix="/verify")
api.include_router(SearchRouter)
api.include_router(UserSettingsRouter, prefix="/user-settings")
api.include_router(StatsRouter, prefix="/stats")
api.include_router(WebhooksRouter)
