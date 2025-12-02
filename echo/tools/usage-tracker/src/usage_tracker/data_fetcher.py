"""Data fetching module for usage tracker."""

from __future__ import annotations

import logging
from datetime import datetime, date
from typing import Any, Callable, Dict, List, Optional, Protocol
from dataclasses import dataclass, field

from .directus_client import DirectusClient, DirectusError

logger = logging.getLogger(__name__)

# Directus fetch limit per request (smaller to avoid timeouts on slow connections)
DEFAULT_BATCH_SIZE = 200


class ProgressCallback(Protocol):
    """Protocol for progress callbacks."""

    def __call__(self, current: int, total: int, message: str) -> None:
        """Report progress.

        Args:
            current: Current step (0-indexed)
            total: Total steps
            message: Description of current operation
        """
        ...


def _noop_progress(current: int, total: int, message: str) -> None:
    """No-op progress callback."""
    pass


@dataclass
class DateRange:
    """A date range for filtering."""

    start: date
    end: date

    def to_filter(self, field_name: str = "created_at") -> Dict[str, Any]:
        """Convert to Directus filter format."""
        return {
            field_name: {
                "_gte": self.start.isoformat(),
                "_lte": f"{self.end.isoformat()}T23:59:59",
            }
        }


@dataclass
class UserInfo:
    """Basic user information."""

    id: str
    email: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None

    @property
    def display_name(self) -> str:
        """Get display name (full name or email)."""
        parts = [p for p in [self.first_name, self.last_name] if p]
        return " ".join(parts) if parts else self.email


@dataclass
class ProjectInfo:
    """Project information with counts."""

    id: str
    name: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    conversation_count: int = 0
    is_conversation_allowed: bool = True


@dataclass
class ConversationInfo:
    """Conversation information."""

    id: str
    project_id: str
    created_at: Optional[datetime] = None
    duration: Optional[int] = None  # in seconds
    chunk_count: int = 0
    is_finished: bool = False
    participant_name: Optional[str] = None
    source: Optional[str] = None
    merged_transcript: Optional[str] = None


@dataclass
class ChatInfo:
    """Project chat information."""

    id: str
    project_id: str
    name: Optional[str] = None
    created_at: Optional[datetime] = None
    message_count: int = 0


@dataclass
class ChatMessageInfo:
    """Chat message information."""

    id: str
    chat_id: str
    message_from: str  # "User" or "assistant" or "dembrane"
    text: Optional[str] = None
    tokens_count: Optional[int] = None
    created_at: Optional[datetime] = None


@dataclass
class ReportInfo:
    """Project report information."""

    id: int
    project_id: str
    status: str
    language: Optional[str] = None
    created_at: Optional[datetime] = None


@dataclass
class UserUsageData:
    """Aggregated usage data for a user."""

    user: UserInfo
    projects: List[ProjectInfo] = field(default_factory=list)
    conversations: List[ConversationInfo] = field(default_factory=list)
    chats: List[ChatInfo] = field(default_factory=list)
    chat_messages: List[ChatMessageInfo] = field(default_factory=list)
    reports: List[ReportInfo] = field(default_factory=list)

    # Activity tracking
    first_activity: Optional[datetime] = None
    last_activity: Optional[datetime] = None


def _parse_datetime(value: Any) -> Optional[datetime]:
    """Parse a datetime string from Directus."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        # Handle various formats
        for fmt in [
            "%Y-%m-%dT%H:%M:%S.%f%z",
            "%Y-%m-%dT%H:%M:%S%z",
            "%Y-%m-%dT%H:%M:%S.%f",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%d",
        ]:
            try:
                return datetime.strptime(value.replace("Z", "+00:00"), fmt)
            except ValueError:
                continue
        # Try fromisoformat as last resort
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


class DataFetcher:
    """
    Fetches usage data from Directus.

    Uses batching and aggregation where possible for efficiency.
    """

    def __init__(self, client: DirectusClient):
        self.client = client

    def get_all_users(
        self,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[UserInfo]:
        """Get all Directus users."""
        if progress:
            progress(0, 1, "📋 Loading users...")

        try:
            users = self.client.get_users(
                fields=["id", "email", "first_name", "last_name"],
                limit=-1,
            )
            result = [
                UserInfo(
                    id=u["id"],
                    email=u.get("email", ""),
                    first_name=u.get("first_name"),
                    last_name=u.get("last_name"),
                )
                for u in users
            ]
            if progress:
                progress(1, 1, f"✓ Loaded {len(result)} users")
            return result
        except DirectusError as e:
            logger.error(f"Failed to fetch users: {e}")
            return []

    def search_users(self, query: str) -> List[UserInfo]:
        """Search users by email or name."""
        if not query:
            return self.get_all_users()

        try:
            users = self.client.get_users(
                fields=["id", "email", "first_name", "last_name"],
                filter_query={
                    "_or": [
                        {"email": {"_icontains": query}},
                        {"first_name": {"_icontains": query}},
                        {"last_name": {"_icontains": query}},
                    ]
                },
                limit=50,
            )
            return [
                UserInfo(
                    id=u["id"],
                    email=u.get("email", ""),
                    first_name=u.get("first_name"),
                    last_name=u.get("last_name"),
                )
                for u in users
            ]
        except DirectusError as e:
            logger.error(f"Failed to search users: {e}")
            return []

    def get_user_projects(
        self,
        user_id: str,
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[ProjectInfo]:
        """Get projects owned by a user with batching.
        
        Note: We fetch ALL projects for the user (not filtered by date range).
        Date filtering is applied to conversations/chats/reports, not projects themselves.
        This ensures we capture all activity within the date range, even in older projects.
        """
        filter_query: Dict[str, Any] = {"directus_user_id": {"_eq": user_id}}
        # Don't filter projects by date - we want all projects, then filter their activity

        result: List[ProjectInfo] = []
        offset = 0
        batch_num = 0

        try:
            while True:
                if progress:
                    progress(0, 1, f"📁 Loading projects (batch {batch_num + 1})...")

                projects = self.client.get_items(
                    "project",
                    fields=[
                        "id",
                        "name",
                        "created_at",
                        "updated_at",
                        "is_conversation_allowed",
                        "count(conversations)",
                    ],
                    filter_query=filter_query,
                    sort=["-created_at"],
                    limit=batch_size,
                    offset=offset,
                )

                if not projects:
                    break

                for p in projects:
                    # Handle conversation count from aggregate
                    conv_count = p.get("conversations_count", 0)
                    if isinstance(conv_count, dict):
                        conv_count = conv_count.get("count", 0)
                    if conv_count is None:
                        conv_count = 0

                    result.append(
                        ProjectInfo(
                            id=p["id"],
                            name=p.get("name") or "Unnamed Project",
                            created_at=_parse_datetime(p.get("created_at")),
                            updated_at=_parse_datetime(p.get("updated_at")),
                            conversation_count=int(conv_count),
                            is_conversation_allowed=bool(p.get("is_conversation_allowed", True)),
                        )
                    )

                if len(projects) < batch_size:
                    break
                offset += batch_size
                batch_num += 1

            return result
        except DirectusError as e:
            logger.error(f"Failed to fetch projects for user {user_id}: {e}")
            return []

    def get_project_conversations(
        self,
        project_ids: List[str],
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[ConversationInfo]:
        """
        Get conversations for multiple projects.

        Uses batching for large datasets.
        """
        if not project_ids:
            return []

        filter_query: Dict[str, Any] = {"project_id": {"_in": project_ids}}

        if date_range:
            filter_query.update(date_range.to_filter("created_at"))

        conversations: List[ConversationInfo] = []
        offset = 0
        batch_num = 0

        try:
            while True:
                if progress:
                    progress(0, 1, f"🎤 Loading conversations (batch {batch_num + 1}, {len(conversations)} so far)...")

                batch = self.client.get_items(
                    "conversation",
                    fields=[
                        "id",
                        "project_id",
                        "created_at",
                        "duration",
                        "is_finished",
                        "participant_name",
                        "source",
                        "merged_transcript",
                        "count(chunks)",
                    ],
                    filter_query=filter_query,
                    sort=["created_at"],
                    limit=batch_size,
                    offset=offset,
                )

                if not batch:
                    break

                for c in batch:
                    # Handle chunk count from aggregate
                    chunk_count = c.get("chunks_count", 0)
                    if isinstance(chunk_count, dict):
                        chunk_count = chunk_count.get("count", 0)
                    if chunk_count is None:
                        chunk_count = 0

                    # Handle project_id which might be nested
                    proj_id = c.get("project_id")
                    if isinstance(proj_id, dict):
                        proj_id = proj_id.get("id", "")

                    conversations.append(
                        ConversationInfo(
                            id=c["id"],
                            project_id=str(proj_id) if proj_id else "",
                            created_at=_parse_datetime(c.get("created_at")),
                            duration=c.get("duration"),
                            chunk_count=int(chunk_count),
                            is_finished=bool(c.get("is_finished")),
                            participant_name=c.get("participant_name"),
                            source=c.get("source"),
                            merged_transcript=c.get("merged_transcript"),
                        )
                    )

                if len(batch) < batch_size:
                    break
                offset += batch_size
                batch_num += 1

            return conversations
        except DirectusError as e:
            logger.error(f"Failed to fetch conversations: {e}")
            return []

    def get_project_chats(
        self,
        project_ids: List[str],
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[ChatInfo]:
        """Get project chats for multiple projects with batching.
        
        Note: We fetch ALL chats for the projects (not filtered by date range).
        Date filtering is applied to messages, not chats themselves.
        This ensures we capture all messages within the date range, even in older chats.
        """
        if not project_ids:
            return []

        filter_query: Dict[str, Any] = {"project_id": {"_in": project_ids}}
        # Don't filter chats by date - we want all chats, then filter their messages

        result: List[ChatInfo] = []
        offset = 0
        batch_num = 0

        try:
            while True:
                if progress:
                    progress(0, 1, f"💬 Loading chats (batch {batch_num + 1}, {len(result)} so far)...")

                chats = self.client.get_items(
                    "project_chat",
                    fields=[
                        "id",
                        "project_id",
                        "name",
                        "date_created",
                        "count(project_chat_messages)",
                    ],
                    filter_query=filter_query,
                    sort=["-date_created"],
                    limit=batch_size,
                    offset=offset,
                )

                if not chats:
                    break

                for c in chats:
                    # Handle message count from aggregate
                    msg_count = c.get("project_chat_messages_count", 0)
                    if isinstance(msg_count, dict):
                        msg_count = msg_count.get("count", 0)
                    if msg_count is None:
                        msg_count = 0

                    # Handle project_id which might be nested
                    proj_id = c.get("project_id")
                    if isinstance(proj_id, dict):
                        proj_id = proj_id.get("id", "")

                    result.append(
                        ChatInfo(
                            id=c["id"],
                            project_id=str(proj_id) if proj_id else "",
                            name=c.get("name"),
                            created_at=_parse_datetime(c.get("date_created")),
                            message_count=int(msg_count),
                        )
                    )

                if len(chats) < batch_size:
                    break
                offset += batch_size
                batch_num += 1

            return result
        except DirectusError as e:
            logger.error(f"Failed to fetch chats: {e}")
            return []

    def get_chat_messages(
        self,
        chat_ids: List[str],
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[ChatMessageInfo]:
        """Get chat messages for multiple chats."""
        if not chat_ids:
            return []

        filter_query: Dict[str, Any] = {"project_chat_id": {"_in": chat_ids}}

        if date_range:
            filter_query.update(date_range.to_filter("date_created"))

        messages: List[ChatMessageInfo] = []
        offset = 0
        batch_num = 0

        try:
            while True:
                if progress:
                    progress(0, 1, f"📝 Loading messages (batch {batch_num + 1}, {len(messages)} so far)...")

                batch = self.client.get_items(
                    "project_chat_message",
                    fields=[
                        "id",
                        "project_chat_id",
                        "message_from",
                        "text",
                        "tokens_count",
                        "date_created",
                    ],
                    filter_query=filter_query,
                    sort=["date_created"],
                    limit=batch_size,
                    offset=offset,
                )

                if not batch:
                    break

                for m in batch:
                    # Handle chat_id which might be nested
                    chat_id = m.get("project_chat_id")
                    if isinstance(chat_id, dict):
                        chat_id = chat_id.get("id", "")

                    messages.append(
                        ChatMessageInfo(
                            id=m["id"],
                            chat_id=str(chat_id) if chat_id else "",
                            message_from=m.get("message_from", "User"),
                            text=m.get("text"),
                            tokens_count=m.get("tokens_count"),
                            created_at=_parse_datetime(m.get("date_created")),
                        )
                    )

                if len(batch) < batch_size:
                    break
                offset += batch_size
                batch_num += 1

            return messages
        except DirectusError as e:
            logger.error(f"Failed to fetch chat messages: {e}")
            return []

    def get_project_reports(
        self,
        project_ids: List[str],
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[ReportInfo]:
        """Get reports for multiple projects with batching.
        
        Reports ARE filtered by date range since they represent discrete events.
        """
        if not project_ids:
            return []

        filter_query: Dict[str, Any] = {"project_id": {"_in": project_ids}}

        # Reports are filtered by date - they're discrete events
        if date_range:
            filter_query.update(date_range.to_filter("date_created"))

        result: List[ReportInfo] = []
        offset = 0
        batch_num = 0

        try:
            while True:
                if progress:
                    progress(0, 1, f"📊 Loading reports (batch {batch_num + 1})...")

                reports = self.client.get_items(
                    "project_report",
                    fields=[
                        "id",
                        "project_id",
                        "status",
                        "language",
                        "date_created",
                    ],
                    filter_query=filter_query,
                    sort=["-date_created"],
                    limit=batch_size,
                    offset=offset,
                )

                if not reports:
                    break

                for r in reports:
                    # Handle project_id which might be nested
                    proj_id = r.get("project_id")
                    if isinstance(proj_id, dict):
                        proj_id = proj_id.get("id", "")

                    result.append(
                        ReportInfo(
                            id=int(r["id"]),
                            project_id=str(proj_id) if proj_id else "",
                            status=r.get("status", "unknown"),
                            language=r.get("language"),
                            created_at=_parse_datetime(r.get("date_created")),
                        )
                    )

                if len(reports) < batch_size:
                    break
                offset += batch_size
                batch_num += 1

            return result
        except DirectusError as e:
            logger.error(f"Failed to fetch reports: {e}")
            return []

    def get_user_usage_data(
        self,
        user_id: str,
        date_range: Optional[DateRange] = None,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> Optional[UserUsageData]:
        """
        Get complete usage data for a user.

        Fetches all related data in an optimized order.
        """
        total_steps = 6
        current_step = 0

        def report(msg: str) -> None:
            nonlocal current_step
            if progress:
                progress(current_step, total_steps, msg)

        # Step 1: Get user info
        report("👤 Fetching user info...")
        try:
            users = self.client.get_users(
                fields=["id", "email", "first_name", "last_name"],
                filter_query={"id": {"_eq": user_id}},
                limit=1,
            )
            if not users:
                logger.warning(f"User {user_id} not found")
                return None

            user = UserInfo(
                id=users[0]["id"],
                email=users[0].get("email", ""),
                first_name=users[0].get("first_name"),
                last_name=users[0].get("last_name"),
            )
        except DirectusError as e:
            logger.error(f"Failed to fetch user {user_id}: {e}")
            return None

        current_step = 1

        # Step 2: Get projects
        report(f"📁 Fetching projects for {user.display_name}...")
        projects = self.get_user_projects(user_id, date_range)
        project_ids = [p.id for p in projects]
        current_step = 2

        # Step 3: Get conversations
        report(f"🎤 Fetching conversations ({len(project_ids)} projects)...")
        conversations = self.get_project_conversations(project_ids, date_range)
        current_step = 3

        # Step 4: Get chats
        report(f"💬 Fetching chats ({len(project_ids)} projects)...")
        chats = self.get_project_chats(project_ids, date_range)
        current_step = 4

        # Step 5: Get reports
        report(f"📊 Fetching reports ({len(project_ids)} projects)...")
        reports = self.get_project_reports(project_ids, date_range)
        current_step = 5

        # Step 6: Get chat messages
        chat_ids = [c.id for c in chats]
        report(f"📝 Fetching messages ({len(chat_ids)} chats)...")
        messages = self.get_chat_messages(chat_ids, date_range)
        current_step = 6

        # Calculate activity range
        all_dates = []
        for p in projects:
            if p.created_at:
                all_dates.append(p.created_at)
        for c in conversations:
            if c.created_at:
                all_dates.append(c.created_at)
        for ch in chats:
            if ch.created_at:
                all_dates.append(ch.created_at)

        first_activity = min(all_dates) if all_dates else None
        last_activity = max(all_dates) if all_dates else None

        report("✓ Data loaded")

        return UserUsageData(
            user=user,
            projects=projects,
            conversations=conversations,
            chats=chats,
            chat_messages=messages,
            reports=reports,
            first_activity=first_activity,
            last_activity=last_activity,
        )

    def get_multi_user_usage_data(
        self,
        user_ids: List[str],
        date_range: Optional[DateRange] = None,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[UserUsageData]:
        """Get usage data for multiple users with progress reporting."""
        results = []
        total = len(user_ids)

        for i, user_id in enumerate(user_ids):
            if progress:
                progress(i, total, f"Loading user {i + 1}/{total}...")

            data = self.get_user_usage_data(user_id, date_range)
            if data:
                results.append(data)

        if progress:
            progress(total, total, f"✓ Loaded data for {len(results)} users")

        return results
