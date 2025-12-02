"""Data fetching module for usage tracker."""

from __future__ import annotations

import logging
from datetime import datetime, date
from typing import Any, Callable, Dict, List, Optional, Protocol, Tuple
from dataclasses import dataclass, field
from collections import defaultdict

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
    has_content: bool = False  # Set via aggregate query - True if any chunk has transcript


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
class LoginActivityInfo:
    """Directus activity entry representing a login."""

    id: int
    user_id: str
    timestamp: Optional[datetime] = None
    ip: Optional[str] = None
    user_agent: Optional[str] = None
    origin: Optional[str] = None


@dataclass
class UserUsageData:
    """Aggregated usage data for a user."""

    user: UserInfo
    projects: List[ProjectInfo] = field(default_factory=list)
    conversations: List[ConversationInfo] = field(default_factory=list)
    chats: List[ChatInfo] = field(default_factory=list)
    chat_messages: List[ChatMessageInfo] = field(default_factory=list)
    reports: List[ReportInfo] = field(default_factory=list)
    login_events: List[LoginActivityInfo] = field(default_factory=list)

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

    def _build_timestamp_filter(
        self,
        date_range: Optional[DateRange],
        field_name: str,
    ) -> Dict[str, Any]:
        if not date_range:
            return {}
        return date_range.to_filter(field_name)

    def get_login_activity_events(
        self,
        user_ids: Optional[List[str]] = None,
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[LoginActivityInfo]:
        """Fetch login activity entries, optionally filtered by users/date."""

        filter_query: Dict[str, Any] = {"action": {"_eq": "login"}}
        if user_ids:
            filter_query["user"] = {"_in": user_ids}
        if date_range:
            filter_query.update(self._build_timestamp_filter(date_range, "timestamp"))

        events: List[LoginActivityInfo] = []
        offset = 0
        batch_num = 0

        try:
            while True:
                if progress:
                    progress(0, 1, f"🔐 Loading logins (batch {batch_num + 1}, {len(events)} so far)...")

                batch = self.client.get_activity(
                    fields=["id", "user", "timestamp", "ip", "user_agent", "origin"],
                    filter_query=filter_query,
                    sort=["-timestamp"],
                    limit=batch_size,
                    offset=offset,
                )

                if not batch:
                    break

                for entry in batch:
                    user_value = entry.get("user")
                    if isinstance(user_value, dict):
                        user_value = user_value.get("id", "")

                    events.append(
                        LoginActivityInfo(
                            id=int(entry.get("id", 0)),
                            user_id=str(user_value) if user_value else "",
                            timestamp=_parse_datetime(entry.get("timestamp")),
                            ip=entry.get("ip"),
                            user_agent=entry.get("user_agent"),
                            origin=entry.get("origin"),
                        )
                    )

                if len(batch) < batch_size:
                    break
                offset += batch_size
                batch_num += 1

            return [event for event in events if event.user_id]
        except DirectusError as e:
            logger.error(f"Failed to fetch login activity: {e}")
            return []

    def get_user_login_activity(
        self,
        user_id: str,
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        progress: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[LoginActivityInfo]:
        events = self.get_login_activity_events(
            user_ids=[user_id],
            date_range=date_range,
            batch_size=batch_size,
            progress=progress,
        )
        return [event for event in events if event.user_id == user_id]

    def get_login_activity_summary(
        self,
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> Dict[str, Dict[str, Any]]:
        events = self.get_login_activity_events(
            user_ids=None,
            date_range=date_range,
            batch_size=batch_size,
        )

        summary: Dict[str, Dict[str, Any]] = {}
        for event in events:
            if not event.user_id:
                continue
            entry = summary.setdefault(event.user_id, {"count": 0, "last": None, "first": None})
            entry["count"] += 1
            if event.timestamp and (
                entry["last"] is None or event.timestamp > entry["last"]
            ):
                entry["last"] = event.timestamp
            if event.timestamp and (
                entry["first"] is None or event.timestamp < entry["first"]
            ):
                entry["first"] = event.timestamp

        return summary

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
        total_steps = 7
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
        # Check which conversations have content (at least one chunk with transcript)
        if conversations:
            report(f"🔍 Checking content ({len(conversations)} conversations)...")
            conversation_ids = [c.id for c in conversations]
            ids_with_content = self.get_conversation_ids_with_content(conversation_ids)
            for conv in conversations:
                conv.has_content = conv.id in ids_with_content
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

        # Step 7: Login activity
        report(f"🔐 Fetching login activity for {user.display_name}...")
        login_events = self.get_user_login_activity(user_id, date_range)
        current_step = 7

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
        for login in login_events:
            if login.timestamp:
                all_dates.append(login.timestamp)

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
            login_events=login_events,
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

    def _fetch_projects_metadata(self, project_ids: List[str]) -> Dict[str, Dict[str, Optional[str]]]:
        if not project_ids:
            return {}

        unique_ids = list({pid for pid in project_ids if pid})
        metadata: Dict[str, Dict[str, Optional[str]]] = {}
        batch_size = 200

        for i in range(0, len(unique_ids), batch_size):
            chunk = unique_ids[i : i + batch_size]
            try:
                records = self.client.get_items(
                    "project",
                    fields=["id", "directus_user_id", "name"],
                    filter_query={"id": {"_in": chunk}},
                    limit=len(chunk),
                )
            except DirectusError as e:
                logger.error(f"Failed to fetch project metadata: {e}")
                continue

            for record in records:
                proj_id = str(record.get("id"))
                owner = record.get("directus_user_id")
                if isinstance(owner, dict):
                    owner = owner.get("id")
                metadata[proj_id] = {
                    "owner_id": str(owner) if owner else None,
                    "name": record.get("name") or "Unnamed Project",
                }

        return metadata

    def get_project_chat_activity_summary(
        self,
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> Dict[str, Dict[str, Any]]:
        filter_query: Dict[str, Any] = {}
        if date_range:
            filter_query.update(date_range.to_filter("date_created"))

        summary: Dict[str, Dict[str, Any]] = {}
        project_ids: List[str] = []
        offset = 0

        try:
            while True:
                batch = self.client.get_items(
                    "project_chat",
                    fields=["id", "project_id", "date_created"],
                    filter_query=filter_query,
                    sort=["-date_created"],
                    limit=batch_size,
                    offset=offset,
                )

                if not batch:
                    break

                for chat in batch:
                    proj = chat.get("project_id")
                    proj_id = proj.get("id") if isinstance(proj, dict) else proj
                    if not proj_id:
                        continue

                    project_ids.append(str(proj_id))
                    entry = summary.setdefault(str(proj_id), {"count": 0, "last": None})
                    entry["count"] += 1
                    ts = _parse_datetime(chat.get("date_created"))
                    if ts and (entry["last"] is None or ts > entry["last"]):
                        entry["last"] = ts

                if len(batch) < batch_size:
                    break
                offset += batch_size

        except DirectusError as e:
            logger.error(f"Failed to fetch chat activity summary: {e}")
            return {}

        metadata = self._fetch_projects_metadata(project_ids)
        for proj_id, meta in metadata.items():
            entry = summary.setdefault(proj_id, {"count": 0, "last": None})
            entry["name"] = meta.get("name")
            entry["owner_id"] = meta.get("owner_id")

        return summary

    def get_conversation_activity_snapshot(
        self,
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> Dict[str, Any]:
        filter_query: Dict[str, Any] = {}
        if date_range:
            filter_query.update(date_range.to_filter("created_at"))

        conv_records: List[Tuple[str, Optional[datetime]]] = []
        project_ids: List[str] = []
        offset = 0

        try:
            while True:
                batch = self.client.get_items(
                    "conversation",
                    fields=["id", "project_id", "created_at"],
                    filter_query=filter_query,
                    sort=["-created_at"],
                    limit=batch_size,
                    offset=offset,
                )

                if not batch:
                    break

                for conv in batch:
                    proj = conv.get("project_id")
                    proj_id = proj.get("id") if isinstance(proj, dict) else proj
                    if not proj_id:
                        continue

                    project_ids.append(str(proj_id))
                    conv_records.append((str(proj_id), _parse_datetime(conv.get("created_at"))))

                if len(batch) < batch_size:
                    break
                offset += batch_size

        except DirectusError as e:
            logger.error(f"Failed to fetch conversations for snapshot: {e}")
            return {
                "per_user": {},
                "per_project": {},
                "daily_conversations": {},
                "daily_projects": {},
            }

        metadata = self._fetch_projects_metadata(project_ids)
        per_user: Dict[str, Dict[str, Any]] = {}
        per_project: Dict[str, Dict[str, Any]] = {}
        daily_conversations: Dict[date, int] = defaultdict(int)
        daily_project_sets: Dict[date, set] = defaultdict(set)

        for proj_id, created_at in conv_records:
            meta = metadata.get(proj_id, {})
            owner_id = meta.get("owner_id")
            project_name = meta.get("name") or f"Project {proj_id}"

            proj_entry = per_project.setdefault(
                proj_id,
                {
                    "project_id": proj_id,
                    "project_name": project_name,
                    "owner_id": owner_id,
                    "conversations": 0,
                    "last_conversation": None,
                    "chat_sessions": 0,
                    "last_chat": None,
                },
            )
            proj_entry["conversations"] += 1
            if created_at and (
                proj_entry["last_conversation"] is None or created_at > proj_entry["last_conversation"]
            ):
                proj_entry["last_conversation"] = created_at

            if owner_id:
                user_entry = per_user.setdefault(owner_id, {"count": 0, "last": None})
                user_entry["count"] += 1
                if created_at and (
                    user_entry["last"] is None or created_at > user_entry["last"]
                ):
                    user_entry["last"] = created_at

            if created_at:
                day = created_at.date()
                daily_conversations[day] += 1
                daily_project_sets[day].add(proj_id)

        daily_projects = {day: len(projects) for day, projects in daily_project_sets.items()}

        return {
            "per_user": per_user,
            "per_project": per_project,
            "daily_conversations": dict(daily_conversations),
            "daily_projects": daily_projects,
        }

    def get_conversation_summary_by_user(
        self,
        date_range: Optional[DateRange] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> Dict[str, Dict[str, Any]]:
        snapshot = self.get_conversation_activity_snapshot(date_range, batch_size)
        return snapshot.get("per_user", {})

    def get_conversation_ids_with_content(
        self,
        conversation_ids: List[str],
    ) -> set:
        if not conversation_ids:
            return set()

        try:
            result = self.client.get_aggregate(
                "conversation_chunk",
                aggregate={"countDistinct": "conversation_id"},
                filter_query={
                    "conversation_id": {"_in": conversation_ids},
                    "transcript": {
                        "_nnull": True,
                        "_nempty": True,
                    },
                },
                group_by=["conversation_id"],
            )

            conversation_ids_with_content = set()
            for item in result:
                if isinstance(item, dict):
                    conv_id = item.get("conversation_id")
                    if isinstance(conv_id, dict):
                        conv_id = conv_id.get("id", "")
                    if conv_id:
                        conversation_ids_with_content.add(str(conv_id))

            return conversation_ids_with_content

        except DirectusError as e:
            logger.error(f"Failed to get conversation IDs with content: {e}")
            return set()
