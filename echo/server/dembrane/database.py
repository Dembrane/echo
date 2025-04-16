# this is not upto date. switched to directus for a better life
from enum import Enum
from typing import Any, Dict, List, Optional, Annotated, Generator
from logging import getLogger
from datetime import datetime, timezone

from fastapi import Depends
from sqlalchemy import (
    Text,
    Table,
    Column,
    String,
    Boolean,
    Integer,
    DateTime as _DateTime,
    ForeignKey,
    TypeDecorator,
    func,
    create_engine,
)
from sqlalchemy.orm import (
    Mapped,
    Session as _Session,
    relationship,
    sessionmaker,
    mapped_column,
    scoped_session,
    declarative_base,
)
from pgvector.sqlalchemy import Vector  # type: ignore
from sqlalchemy.dialects.postgresql import UUID, JSONB

from dembrane.config import DATABASE_URL
from dembrane.embedding import EMBEDDING_DIM

logger = getLogger("database")

# Create the engine and connect to the SQLite database file
assert DATABASE_URL is not None
logger.debug(f"Connecting to database: {DATABASE_URL}")
engine = create_engine(DATABASE_URL)

# Create a session factory
session_factory = sessionmaker(bind=engine)
Session = scoped_session(session_factory)
# Alias
DatabaseSession = Session

# Define your models as subclasses of the base class
Base: Any = declarative_base()


class DateTime(TypeDecorator[_DateTime]):
    """Custom type to store UTC datetime in the database. Allows to only use
    timezone aware datetime objects as parameters and return timezone aware
    datetime objects as results."""

    impl = _DateTime
    cache_ok = True

    def process_bind_param(self, value, _dialect):  # type: ignore
        if isinstance(value, datetime) and value.tzinfo is None:
            raise ValueError("Naive datetime is not supported")

        return value.astimezone(timezone.utc) if value else None

    def process_result_value(self, value, _dialect):  # type: ignore
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)

        return value.astimezone(timezone.utc) if value else None


class ProcessingStatusEnum(Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    DONE = "DONE"
    ERROR = "ERROR"


# class SessionModel(Base):
#     __tablename__ = "session"
# id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
# uuid: Mapped[str] = mapped_column(UUID(as_uuid=False), unique=False, nullable=False)
# created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
# updated_at: Mapped[datetime] = mapped_column(
#     DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
# )
# projects: Mapped[List["ProjectModel"]] = relationship(
#     "ProjectModel", back_populates="session"
# )
# user_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("directus_user.id"))


class UserModel(Base):
    __tablename__ = "directus_user"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)


class ProjectModel(Base):
    __tablename__ = "project"

    # id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=func.uuid_generate_v4())
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # session_id: Mapped[int] = mapped_column(Integer, ForeignKey("session.id"))
    # session: Mapped["SessionModel"] = relationship("SessionModel", back_populates="projects")

    directus_user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("directus_user.id")
    )
    directus_user: Mapped["UserModel"] = relationship("UserModel")

    pin: Mapped[str] = mapped_column(String, unique=True)

    language: Mapped[str] = mapped_column(String, default="en")

    name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    context: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    is_conversation_allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    image_generation_model: Mapped[str] = mapped_column(String, default="MODEST")

    default_conversation_ask_for_participant_name: Mapped[bool] = mapped_column(Boolean)
    default_conversation_tutorial_slug: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    default_conversation_transcript_prompt: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )

    default_conversation_title: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    default_conversation_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    default_conversation_finish_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    resources: Mapped[List["ResourceModel"]] = relationship(
        "ResourceModel", back_populates="project", cascade="all, delete-orphan"
    )
    conversations: Mapped[List["ConversationModel"]] = relationship(
        "ConversationModel", back_populates="project", cascade="all, delete-orphan"
    )

    tags: Mapped[List["ProjectTagModel"]] = relationship(
        "ProjectTagModel",
        back_populates="project",
        cascade="all, delete-orphan",
    )

    project_analysis_runs: Mapped[List["ProjectAnalysisRunModel"]] = relationship(
        "ProjectAnalysisRunModel",
        back_populates="project",
        cascade="all, delete-orphan",
    )

    # @staticmethod
    # def belongs_to_session(project_id: str, session_id: int) -> bool:
    #     return (
    #         db.query(ProjectModel)
    #         .filter(ProjectModel.id == project_id, ProjectModel.session_id == session_id)
    #         .first()
    #         is not None
    #     )


class ProjectAnalysisRunModel(Base):
    __tablename__ = "project_analysis_run"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    project_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("project.id"))
    project: Mapped["ProjectModel"] = relationship(
        "ProjectModel", back_populates="project_analysis_runs"
    )

    quotes: Mapped[List["QuoteModel"]] = relationship(
        "QuoteModel", back_populates="project_analysis_run"
    )
    insights: Mapped[List["InsightModel"]] = relationship(
        "InsightModel", back_populates="project_analysis_run"
    )
    views: Mapped[List["ViewModel"]] = relationship(
        "ViewModel", back_populates="project_analysis_run"
    )

    processing_status: Mapped[ProcessingStatusEnum] = mapped_column(Text, default="PENDING")
    processing_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    processing_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    processing_started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    processing_completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


conversation_project_tag_association_table = Table(
    "conversation_project_tag",
    Base.metadata,
    Column("id", Integer, autoincrement=True, primary_key=True, unique=True),
    Column("conversation_id", ForeignKey("conversation.id")),
    Column("project_tag_id", ForeignKey("project_tag.id")),
)

project_chat_message_conversation_association_table = Table(
    "project_chat_message_conversation",
    Base.metadata,
    Column("id", Integer, autoincrement=True, primary_key=True, unique=True),
    Column("project_chat_message_id", ForeignKey("project_chat_message.id")),
    Column("conversation_id", ForeignKey("conversation.id")),
)

project_chat_message_conversation_association_1_table = Table(
    "project_chat_message_conversation_1",
    Base.metadata,
    Column("id", Integer, autoincrement=True, primary_key=True, unique=True),
    Column("project_chat_message_id", ForeignKey("project_chat_message.id")),
    Column("conversation_id", ForeignKey("conversation.id")),
)

project_chat_conversation_association_table = Table(
    "project_chat_conversation",
    Base.metadata,
    Column("id", Integer, autoincrement=True, primary_key=True, unique=True),
    Column("project_chat_id", ForeignKey("project_chat.id")),
    Column("conversation_id", ForeignKey("conversation.id")),
)


class ProjectTagModel(Base):
    __tablename__ = "project_tag"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    project_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("project.id"))
    project: Mapped["ProjectModel"] = relationship("ProjectModel", back_populates="tags")

    conversations: Mapped[List["ConversationModel"]] = relationship(
        "ConversationModel",
        secondary=conversation_project_tag_association_table,
        back_populates="tags",
    )

    text: Mapped[str] = mapped_column(String)


class ProjectChatMessageModel(Base):
    __tablename__ = "project_chat_message"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    date_created: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    date_updated: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    project_chat_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("project_chat.id"))
    project_chat: Mapped["ProjectChatModel"] = relationship(
        "ProjectChatModel", back_populates="project_chat_messages"
    )
    text: Mapped[str] = mapped_column(String)
    message_from: Mapped[str] = mapped_column(String)
    used_conversations: Mapped[List["ConversationModel"]] = relationship(
        "ConversationModel",
        secondary=project_chat_message_conversation_association_table,
        back_populates="project_chat_messages",
    )
    added_conversations: Mapped[List["ConversationModel"]] = relationship(
        "ConversationModel",
        secondary=project_chat_message_conversation_association_1_table,
    )
    tokens_count: Mapped[int] = mapped_column(Integer)
    prompt_conversations: Mapped[List[Dict[str, str]]] = mapped_column(JSONB, default=[]) 
    citations: Mapped[List[Dict[str, str]]] = mapped_column(JSONB, default=[]) 


class ProjectChatModel(Base):
    __tablename__ = "project_chat"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    date_created: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    date_updated: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    project_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("project.id"))

    project_chat_messages: Mapped[List["ProjectChatMessageModel"]] = relationship(
        "ProjectChatMessageModel", back_populates="project_chat"
    )

    used_conversations: Mapped[List["ConversationModel"]] = relationship(
        "ConversationModel",
        secondary=project_chat_conversation_association_table,
        back_populates="project_chats",
    )

    auto_select_bool: Mapped[bool] = mapped_column('auto_select', Boolean, default=False)


class ResourceTypeEnum(Enum):
    PDF = "PDF"


class ResourceModel(Base):
    __tablename__ = "document"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    project_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("project.id"))
    project: Mapped["ProjectModel"] = relationship("ProjectModel", back_populates="resources")

    original_filename: Mapped[str] = mapped_column(String, default="")
    type: Mapped[ResourceTypeEnum] = mapped_column(String, default=ResourceTypeEnum.PDF)
    path: Mapped[str] = mapped_column(String)

    title: Mapped[str] = mapped_column(String)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    context: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    is_processed: Mapped[bool] = mapped_column(Boolean, default=False)
    processing_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class ConversationModel(Base):
    __tablename__ = "conversation"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    project_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("project.id"))
    project: Mapped["ProjectModel"] = relationship("ProjectModel", back_populates="conversations")

    participant_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    participant_email: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    participant_user_agent: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    title: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    context: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    processing_status: Mapped[ProcessingStatusEnum] = mapped_column(String, default="PENDING")
    processing_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    chunks: Mapped[List["ConversationChunkModel"]] = relationship(
        "ConversationChunkModel",
        back_populates="conversation",
        cascade="all, delete-orphan",
    )

    tags: Mapped[List["ProjectTagModel"]] = relationship(
        "ProjectTagModel",
        secondary=conversation_project_tag_association_table,
        back_populates="conversations",
    )

    quotes: Mapped[List["QuoteModel"]] = relationship(
        "QuoteModel", back_populates="conversation", cascade="all, delete-orphan"
    )

    project_chats: Mapped[List["ProjectChatModel"]] = relationship(
        "ProjectChatModel",
        back_populates="used_conversations",
        secondary=project_chat_conversation_association_table,
    )

    project_chat_messages: Mapped[List["ProjectChatMessageModel"]] = relationship(
        "ProjectChatMessageModel",
        back_populates="used_conversations",
        secondary=project_chat_message_conversation_association_table,
    )


conversation_chunk_quote_association_table = Table(
    "quote_conversation_chunk",
    Base.metadata,
    Column("id", Integer, autoincrement=True, primary_key=True, unique=True),
    Column("conversation_chunk_id", ForeignKey("conversation_chunk.id")),
    Column("quote_id", ForeignKey("quote.id")),
)


class ConversationChunkModel(Base):
    __tablename__ = "conversation_chunk"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    conversation_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("conversation.id"))
    conversation: Mapped["ConversationModel"] = relationship(
        "ConversationModel", back_populates="chunks"
    )

    path: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    transcript: Mapped[str] = mapped_column(Text, nullable=True)

    quotes: Mapped[List["QuoteModel"]] = relationship(
        "QuoteModel",
        secondary=conversation_chunk_quote_association_table,
        back_populates="conversation_chunks",
    )


quote_aspect_association_table = Table(
    "quote_aspect",
    Base.metadata,
    Column("id", Integer, autoincrement=True, primary_key=True, unique=True),
    Column("quote_id", ForeignKey("quote.id"), primary_key=True),
    Column("aspect_id", ForeignKey("aspect.id"), primary_key=True),
)

representative_quote_aspect_association_table = Table(
    "quote_aspect_1",
    Base.metadata,
    Column("id", Integer, autoincrement=True, primary_key=True, unique=True),
    Column("quote_id", ForeignKey("quote.id"), primary_key=True),
    Column("aspect_id", ForeignKey("aspect.id"), primary_key=True),
)


class QuoteModel(Base):
    __tablename__ = "quote"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    order: Mapped[int] = mapped_column(Integer, nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)

    text: Mapped[str] = mapped_column(Text)
    embedding: Mapped[List[float]] = mapped_column(Vector(EMBEDDING_DIM))

    conversation_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("conversation.id"))
    conversation: Mapped["ConversationModel"] = relationship("ConversationModel")

    conversation_chunks: Mapped[List["ConversationChunkModel"]] = relationship(
        "ConversationChunkModel",
        secondary=conversation_chunk_quote_association_table,
        back_populates="quotes",
    )

    insight_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("insight.id"))
    insight: Mapped[Optional["InsightModel"]] = relationship(
        "InsightModel", back_populates="quotes"
    )

    aspects: Mapped[List["AspectModel"]] = relationship(
        "AspectModel", back_populates="quotes", secondary=quote_aspect_association_table
    )
    representative_aspects: Mapped[List["AspectModel"]] = relationship(
        "AspectModel",
        back_populates="representative_quotes",
        secondary=representative_quote_aspect_association_table,
    )

    project_analysis_run_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("project_analysis_run.id")
    )
    project_analysis_run: Mapped[Optional["ProjectAnalysisRunModel"]] = relationship(
        ProjectAnalysisRunModel, back_populates="quotes"
    )


class ViewModel(Base):
    __tablename__ = "view"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    name: Mapped[str] = mapped_column(String)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    aspects: Mapped[List["AspectModel"]] = relationship("AspectModel", back_populates="view")

    project_analysis_run_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("project_analysis_run.id")
    )
    project_analysis_run: Mapped[Optional["ProjectAnalysisRunModel"]] = relationship(
        ProjectAnalysisRunModel, back_populates="views"
    )

    processing_status: Mapped[ProcessingStatusEnum] = mapped_column(Text, default="PENDING")
    processing_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    processing_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    processing_started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    processing_completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AspectModel(Base):
    __tablename__ = "aspect"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    name: Mapped[str] = mapped_column(String)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    image_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    short_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    long_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    view_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("view.id"))
    view: Mapped[Optional["ViewModel"]] = relationship("ViewModel", back_populates="aspects")

    quotes: Mapped[List["QuoteModel"]] = relationship(
        "QuoteModel", back_populates="aspects", secondary=quote_aspect_association_table
    )

    representative_quotes: Mapped[List["QuoteModel"]] = relationship(
        "QuoteModel",
        back_populates="representative_aspects",
        secondary=representative_quote_aspect_association_table,
    )

    centroid_embedding: Mapped[List[float]] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)


## Depracated
class InsightModel(Base):
    __tablename__ = "insight"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    title: Mapped[Optional[str]] = mapped_column(Text, nullable=False)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    quotes: Mapped[List["QuoteModel"]] = relationship("QuoteModel", back_populates="insight")

    project_analysis_run_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False), ForeignKey("project_analysis_run.id")
    )
    project_analysis_run: Mapped[Optional["ProjectAnalysisRunModel"]] = relationship(
        ProjectAnalysisRunModel, back_populates="insights"
    )


### DO NOT USE
db = Session()
"""
use this instead:
```
with Session() as db:
    ...
```
# this will automatically close the session after the block
"""


def get_db() -> Generator[_Session, None, None]:
    logger.debug("Opening database connection")
    db = Session()
    try:
        yield db
    finally:
        logger.debug("Closing database connection")
        db.close()


DependencyInjectDatabase = Annotated[_Session, Depends(get_db, use_cache=False)]
