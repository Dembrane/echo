from uuid import uuid4
from datetime import datetime, timezone

from pydantic import Field, BaseModel


class BaseEvent(BaseModel):
    """Base class for all events"""

    event_id: str = Field(default_factory=lambda: str(uuid4()))
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    # Set by the event service
    event_name: str

    class Config:
        json_encoders = {datetime: lambda v: v.isoformat()}


class ChunkCreatedEvent(BaseEvent):
    event_name: str = "system.chunk.created"

    chunk_id: str
    conversation_id: str


class EventService:
    """Service for publishing events"""

    def publish(
        self,
        event: BaseEvent,
    ) -> None:
        pass
