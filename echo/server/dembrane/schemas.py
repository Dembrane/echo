# this is not upto date. switched to directus for a better life
from enum import Enum
from typing import Any, List, Union, Optional
from datetime import datetime

from pydantic import BaseModel

from dembrane.database import ProcessingStatusEnum


class SessionSchema(BaseModel):
    id: int
    created_at: datetime
    updated_at: datetime


class ProjectTagSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime
    project_id: str

    text: str


class ProjectSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime
    language: str
    name: Optional[str] = None
    context: Optional[str] = None

    tags: Optional[List[ProjectTagSchema]] = []

    is_conversation_allowed: bool
    default_conversation_title: Optional[str] = None
    default_conversation_description: Optional[str] = None
    default_conversation_finish_text: Optional[str] = None


class ResourceSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime
    project_id: str
    original_filename: str
    type: str  # ResourceTypeEnum

    title: str
    description: Optional[str] = None
    context: Optional[str] = None

    is_processed: bool
    processing_error: Optional[str] = None


class ConversationChunkSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime
    conversation_id: str

    transcript: Optional[str] = None
    timestamp: datetime


class ConversationSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime
    project_id: str

    title: Optional[str] = None
    description: Optional[str] = None
    context: Optional[str] = None

    participant_email: Optional[str] = None
    participant_name: Optional[str] = None

    tags: Optional[List[ProjectTagSchema]] = None
    chunks: Optional[List[ConversationChunkSchema]] = None


class ChatMessageSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime
    chat_id: str

    text: str
    role: str  # ChatMessageRoleEnum


class ChatSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime
    project_id: Optional[str] = None

    resources: Optional[list[ResourceSchema]] = []
    conversations: Optional[list[ConversationSchema]] = []
    messages: Optional[list[ChatMessageSchema]] = []


class QuoteSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime

    project_analysis_run_id: str
    conversation_id: str

    conversation_chunks: Optional[List[ConversationChunkSchema]] = []

    text: str


class InsightSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime

    project_analysis_run_id: str

    title: str
    summary: Optional[str] = None

    quotes: Optional[List[QuoteSchema]] = []


class AspectSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime

    project_analysis_run_id: str

    name: str
    description: Optional[str] = None
    short_summary: Optional[str] = None
    long_summary: Optional[str] = None

    image_url: Optional[str] = None

    view_id: Optional[str] = None

    quotes: Optional[List[QuoteSchema]] = []


class ViewSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime

    project_analysis_run_id: str

    name: str
    summary: Optional[str] = None

    aspects: Optional[List["AspectSchema"]] = []


class ProjectAnalysisRunSchema(BaseModel):
    id: str
    created_at: datetime
    updated_at: datetime

    project_id: str

    quotes: Optional[List[QuoteSchema]] = []

    processing_status: ProcessingStatusEnum
    processing_error: Optional[str] = None
    processing_started_at: Optional[datetime] = None
    processing_completed_at: Optional[datetime] = None


class TaskStateEnum(str, Enum):
    PENDING = "PENDING"
    STARTED = "STARTED"
    PROGRESS = "PROGRESS"
    SUCCESS = "SUCCESS"
    FAILURE = "FAILURE"
    RETRY = "RETRY"
    REVOKED = "REVOKED"
    IGNORED = "IGNORED"


class TaskProgressMetaSchema(BaseModel):
    current: int
    total: int
    percent: int
    message: Optional[str] = None


class TaskSchema(BaseModel):
    id: str
    state: TaskStateEnum
    meta: Optional[Union[TaskProgressMetaSchema, Any]] = None
