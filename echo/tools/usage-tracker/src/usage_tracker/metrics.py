"""Metrics calculation module for usage tracker."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from .data_fetcher import (
    UserUsageData,
    ConversationInfo,
    ChatMessageInfo,
    DateRange,
)

# Constants for duration estimation
MIN_CHUNK_DURATION_SECONDS = 30  # Minimum assumed duration per chunk
WORDS_PER_MINUTE = 150  # Average speech rate


def estimate_duration_from_transcript(transcript: Optional[str]) -> int:
    """
    Estimate conversation duration from transcript text.

    Uses average speech rate of ~150 words per minute.
    Returns duration in seconds.
    """
    if not transcript:
        return 0

    # Count words (simple approximation)
    words = len(transcript.split())
    minutes = words / WORDS_PER_MINUTE
    return int(minutes * 60)


def estimate_conversation_duration(conversation: ConversationInfo) -> int:
    """
    Estimate conversation duration with fallback logic.

    Priority:
    1. Use actual duration if available
    2. Estimate from transcript length
    3. Use minimum based on chunk count (30s per chunk)

    Returns the larger of estimates 2 and 3 when duration is not available.
    """
    # Use actual duration if available
    if conversation.duration is not None and conversation.duration > 0:
        return conversation.duration

    # Calculate minimum based on chunks
    min_from_chunks = conversation.chunk_count * MIN_CHUNK_DURATION_SECONDS

    # Estimate from transcript
    from_transcript = estimate_duration_from_transcript(conversation.merged_transcript)

    # Return the larger estimate
    return max(min_from_chunks, from_transcript)


def format_duration(seconds: int) -> str:
    """Format duration in human-readable format."""
    seconds = int(seconds)  # Ensure integer
    if seconds < 60:
        return f"{seconds}s"
    elif seconds < 3600:
        minutes = seconds // 60
        secs = seconds % 60
        return f"{minutes}m {secs}s" if secs else f"{minutes}m"
    else:
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        return f"{hours}h {minutes}m" if minutes else f"{hours}h"


@dataclass
class AudioMetrics:
    """Metrics related to audio/conversations."""

    total_conversations: int = 0
    total_duration_seconds: int = 0
    estimated_duration_seconds: int = 0
    conversations_with_duration: int = 0
    conversations_without_duration: int = 0
    avg_duration_seconds: float = 0.0
    p50_duration_seconds: float = 0.0  # Median
    p90_duration_seconds: float = 0.0  # 90th percentile
    total_chunks: int = 0
    avg_chunks_per_conversation: float = 0.0

    @property
    def total_duration_formatted(self) -> str:
        return format_duration(self.total_duration_seconds)

    @property
    def avg_duration_formatted(self) -> str:
        return format_duration(int(self.avg_duration_seconds))

    @property
    def p50_duration_formatted(self) -> str:
        return format_duration(int(self.p50_duration_seconds))

    @property
    def p90_duration_formatted(self) -> str:
        return format_duration(int(self.p90_duration_seconds))


@dataclass
class ChatMetrics:
    """Metrics related to chat usage."""

    total_chats: int = 0
    total_messages: int = 0
    user_messages: int = 0
    assistant_messages: int = 0
    total_tokens: int = 0
    avg_messages_per_chat: float = 0.0
    p50_messages_per_chat: float = 0.0  # Median
    p90_messages_per_chat: float = 0.0  # 90th percentile

    # Query analysis
    top_query_words: List[Tuple[str, int]] = field(default_factory=list)
    message_length_distribution: Dict[str, int] = field(default_factory=dict)


@dataclass
class ProjectMetrics:
    """Metrics related to projects."""

    total_projects: int = 0
    active_projects: int = 0  # Has conversations
    avg_conversations_per_project: float = 0.0


@dataclass
class ReportMetrics:
    """Metrics related to reports."""

    total_reports: int = 0
    published_reports: int = 0
    error_reports: int = 0


@dataclass
class FeatureAdoption:
    """Feature adoption tracking."""

    uses_conversations: bool = False
    uses_chat: bool = False
    uses_reports: bool = False
    uses_tags: bool = False  # Could be expanded based on data


@dataclass
class ActivityTimeline:
    """Activity data for timeline visualization."""

    # Daily activity counts
    daily_conversations: Dict[date, int] = field(default_factory=dict)
    daily_chats: Dict[date, int] = field(default_factory=dict)
    daily_messages: Dict[date, int] = field(default_factory=dict)
    daily_duration: Dict[date, int] = field(default_factory=dict)  # seconds

    # Per-project daily breakdown
    daily_conversations_by_project: Dict[str, Dict[date, int]] = field(default_factory=dict)
    daily_duration_by_project: Dict[str, Dict[date, int]] = field(default_factory=dict)

    # Project name lookup for insights
    project_names: Dict[str, str] = field(default_factory=dict)

    # Cumulative totals
    cumulative_conversations: Dict[date, int] = field(default_factory=dict)


@dataclass
class UsageMetrics:
    """Complete usage metrics for a user or group of users."""

    audio: AudioMetrics = field(default_factory=AudioMetrics)
    chat: ChatMetrics = field(default_factory=ChatMetrics)
    projects: ProjectMetrics = field(default_factory=ProjectMetrics)
    reports: ReportMetrics = field(default_factory=ReportMetrics)
    adoption: FeatureAdoption = field(default_factory=FeatureAdoption)
    timeline: ActivityTimeline = field(default_factory=ActivityTimeline)

    first_activity: Optional[datetime] = None
    last_activity: Optional[datetime] = None
    days_since_last_activity: Optional[int] = None


# Multilingual stop words (English, Dutch, German, French, Spanish)
# fmt: off
STOP_WORDS = {
    # English
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
    "from", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
    "does", "did", "will", "would", "could", "should", "may", "might", "can", "this", "that",
    "these", "those", "i", "you", "he", "she", "it", "we", "they", "what", "which", "who",
    "whom", "how", "when", "where", "why", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "no", "not", "only", "same", "so", "than", "too", "very",
    "just", "about", "me", "my", "your", "his", "her", "its", "our", "their", "if", "then",
    "else", "as", "any", "also", "been", "before", "after", "now", "here", "there", "because",
    "through", "during", "between", "into", "over", "under", "again", "further", "once",

    # Dutch
    "de", "het", "een", "en", "van", "ik", "te", "dat", "die", "in", "is", "het", "niet",
    "zijn", "je", "hij", "was", "op", "aan", "met", "als", "voor", "had", "er", "maar", "om",
    "hem", "dan", "zou", "of", "wat", "mijn", "men", "dit", "zo", "door", "over", "ze", "zich",
    "bij", "ook", "tot", "naar", "kan", "hun", "dus", "alles", "onder", "ja", "eens", "hier",
    "wie", "werd", "worden", "nog", "zal", "me", "zij", "nu", "ge", "geen", "omdat", "iets",
    "worden", "toch", "al", "waren", "veel", "meer", "doen", "toen", "moet", "ben", "zonder",
    "kunnen", "hun", "daar", "naar", "heb", "hoe", "heeft", "hebben", "deze", "wel", "wij",
    "waar", "tegen", "ons", "zelf", "haar", "na", "reeds", "wil", "kon", "niets", "uw",
    "iemand", "geweest", "andere", "uit", "boven", "nieuwe", "hele", "maken", "mag",

    # German
    "der", "die", "und", "in", "den", "von", "zu", "das", "mit", "sich", "des", "auf", "für",
    "ist", "im", "dem", "nicht", "ein", "eine", "als", "auch", "es", "an", "werden", "aus",
    "er", "hat", "dass", "sie", "nach", "wird", "bei", "einer", "um", "am", "sind", "noch",
    "wie", "einem", "über", "einen", "so", "zum", "kann", "war", "wurde", "wenn", "nur",
    "aber", "vor", "zur", "bis", "mehr", "durch", "oder", "haben", "dann", "unter", "sehr",
    "selbst", "schon", "hier", "doch", "ihre", "ihr", "sein", "seine", "wieder", "ja", "da",
    "dieser", "muss", "zwischen", "immer", "machen", "hatten", "ohne", "dieses", "wir", "was",
    "ich", "ihm", "seinem", "seinen", "ihren", "ihrer", "aller", "allem", "alle", "weil",
    "dir", "dein", "mich", "mir", "meinen", "wer", "dies", "jetzt", "heute", "gibt", "gibt",

    # French
    "le", "la", "les", "un", "une", "des", "du", "de", "et", "est", "en", "que", "qui", "dans",
    "ce", "il", "je", "ne", "pas", "plus", "par", "sur", "se", "son", "au", "avec", "pour",
    "sont", "mais", "ou", "sa", "aux", "elle", "été", "ont", "ses", "tout", "cette", "nous",
    "bien", "fait", "leur", "très", "même", "aussi", "où", "ils", "peut", "ces", "comme",
    "faire", "sans", "donc", "tous", "sous", "entre", "lui", "après", "avoir", "deux", "si",
    "mes", "car", "dont", "nos", "mon", "être", "peu", "encore", "autres", "moins", "quand",
    "vous", "votre", "vos", "leurs", "cela", "ceci", "ici", "là", "alors", "vers", "chez",
    "puis", "selon", "avant", "ainsi", "chaque", "tant", "fois", "non", "oui", "quel", "quoi",

    # Spanish
    "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "de", "del", "en", "que",
    "es", "por", "con", "no", "para", "su", "al", "lo", "como", "más", "pero", "sus", "le",
    "ya", "fue", "este", "ha", "se", "muy", "sin", "sobre", "ser", "tiene", "también",
    "nos", "uno", "me", "hasta", "hay", "donde", "quien", "desde", "todo", "nos", "cuando",
    "muy", "sin", "sobre", "antes", "ser", "bien", "entre", "durante", "cada", "porque",
    "todos", "esta", "son", "dos", "así", "tres", "poco", "cual", "algo", "estos", "están",
    "mi", "mis", "tú", "tu", "te", "ti", "yo", "él", "ella", "ellos", "ellas", "nosotros",
    "vosotros", "ustedes", "si", "más", "ya", "era", "nada", "puede", "qué", "otro", "otra",
}
# fmt: on


def extract_query_words(messages: List[ChatMessageInfo]) -> Counter:
    """Extract significant words from user messages for analysis (multilingual)."""
    word_counts: Counter = Counter()

    for msg in messages:
        if not msg.message_from or msg.message_from.lower() != "user" or not msg.text:
            continue

        # Clean and tokenize
        text = msg.text.lower()
        # Remove URLs
        text = re.sub(r"http\S+", "", text)
        # Keep letters (including accented), remove everything else
        text = re.sub(r"[^\w\s]", " ", text)
        # Remove numbers
        text = re.sub(r"\d+", " ", text)

        # Split and filter
        words = text.split()
        significant_words = [w for w in words if len(w) > 2 and w not in STOP_WORDS]

        word_counts.update(significant_words)

    return word_counts


def calculate_metrics(usage_data: List[UserUsageData]) -> UsageMetrics:
    """
    Calculate comprehensive metrics from usage data.

    Can handle single or multiple users.
    """
    metrics = UsageMetrics()

    # Aggregate all data
    all_conversations: List[ConversationInfo] = []
    all_chats = []
    all_messages: List[ChatMessageInfo] = []
    all_projects = []
    all_reports = []

    all_first_activities = []
    all_last_activities = []

    for user_data in usage_data:
        all_conversations.extend(user_data.conversations)
        all_chats.extend(user_data.chats)
        all_messages.extend(user_data.chat_messages)
        all_projects.extend(user_data.projects)
        all_reports.extend(user_data.reports)

        if user_data.first_activity:
            all_first_activities.append(user_data.first_activity)
        if user_data.last_activity:
            all_last_activities.append(user_data.last_activity)

    # Calculate Audio Metrics
    audio = AudioMetrics()
    audio.total_conversations = len(all_conversations)

    actual_duration = 0
    estimated_duration = 0

    for conv in all_conversations:
        duration = estimate_conversation_duration(conv)
        audio.total_duration_seconds += duration

        if conv.duration is not None and conv.duration > 0:
            audio.conversations_with_duration += 1
            actual_duration += conv.duration
        else:
            audio.conversations_without_duration += 1
            estimated_duration += duration

        audio.total_chunks += conv.chunk_count

    audio.estimated_duration_seconds = estimated_duration

    if audio.total_conversations > 0:
        audio.avg_duration_seconds = audio.total_duration_seconds / audio.total_conversations
        audio.avg_chunks_per_conversation = audio.total_chunks / audio.total_conversations

        # Calculate duration percentiles
        durations = [estimate_conversation_duration(c) for c in all_conversations]
        durations.sort()
        n = len(durations)
        audio.p50_duration_seconds = durations[n // 2]
        audio.p90_duration_seconds = durations[int(n * 0.9)]

    metrics.audio = audio

    # Calculate Chat Metrics
    chat = ChatMetrics()
    chat.total_chats = len(all_chats)
    chat.total_messages = len(all_messages)

    # message_from can be "User", "user", "assistant", "dembrane" - check case-insensitively
    chat.user_messages = sum(
        1 for m in all_messages if m.message_from and m.message_from.lower() == "user"
    )
    chat.assistant_messages = sum(
        1
        for m in all_messages
        if m.message_from and m.message_from.lower() in ("assistant", "dembrane")
    )

    chat.total_tokens = sum(m.tokens_count or 0 for m in all_messages)

    if chat.total_chats > 0:
        chat.avg_messages_per_chat = chat.total_messages / chat.total_chats

        # Calculate messages per chat percentiles
        msgs_per_chat = [c.message_count for c in all_chats]
        msgs_per_chat.sort()
        n = len(msgs_per_chat)
        chat.p50_messages_per_chat = msgs_per_chat[n // 2]
        chat.p90_messages_per_chat = msgs_per_chat[int(n * 0.9)]

    # Query word analysis
    word_counts = extract_query_words(all_messages)
    chat.top_query_words = word_counts.most_common(50)

    # Message length distribution
    length_buckets = {"short (<50 chars)": 0, "medium (50-200)": 0, "long (>200)": 0}
    for msg in all_messages:
        if msg.message_from and msg.message_from.lower() == "user" and msg.text:
            length = len(msg.text)
            if length < 50:
                length_buckets["short (<50 chars)"] += 1
            elif length < 200:
                length_buckets["medium (50-200)"] += 1
            else:
                length_buckets["long (>200)"] += 1
    chat.message_length_distribution = length_buckets

    metrics.chat = chat

    # Calculate Project Metrics
    projects = ProjectMetrics()
    projects.total_projects = len(all_projects)
    projects.active_projects = sum(1 for p in all_projects if p.conversation_count > 0)

    if projects.total_projects > 0:
        total_convs = sum(p.conversation_count for p in all_projects)
        projects.avg_conversations_per_project = total_convs / projects.total_projects

    metrics.projects = projects

    # Calculate Report Metrics
    reports = ReportMetrics()
    reports.total_reports = len(all_reports)
    reports.published_reports = sum(1 for r in all_reports if r.status == "published")
    reports.error_reports = sum(1 for r in all_reports if r.status == "error")

    metrics.reports = reports

    # Feature Adoption
    adoption = FeatureAdoption()
    adoption.uses_conversations = audio.total_conversations > 0
    adoption.uses_chat = chat.total_chats > 0
    adoption.uses_reports = reports.total_reports > 0

    metrics.adoption = adoption

    # Activity Timeline
    timeline = ActivityTimeline()

    # Build project name lookup
    for p in all_projects:
        timeline.project_names[p.id] = p.name

    # Daily conversations and duration (with per-project breakdown)
    for conv in all_conversations:
        if conv.created_at:
            day = conv.created_at.date()
            duration = estimate_conversation_duration(conv)

            # Global daily counts
            timeline.daily_conversations[day] = timeline.daily_conversations.get(day, 0) + 1
            timeline.daily_duration[day] = timeline.daily_duration.get(day, 0) + duration

            # Per-project breakdown
            proj_id = conv.project_id
            if proj_id:
                if proj_id not in timeline.daily_conversations_by_project:
                    timeline.daily_conversations_by_project[proj_id] = {}
                    timeline.daily_duration_by_project[proj_id] = {}

                timeline.daily_conversations_by_project[proj_id][day] = (
                    timeline.daily_conversations_by_project[proj_id].get(day, 0) + 1
                )
                timeline.daily_duration_by_project[proj_id][day] = (
                    timeline.daily_duration_by_project[proj_id].get(day, 0) + duration
                )

    # Daily chats
    for chat_info in all_chats:
        if chat_info.created_at:
            day = chat_info.created_at.date()
            timeline.daily_chats[day] = timeline.daily_chats.get(day, 0) + 1

    # Daily messages
    for msg in all_messages:
        if msg.created_at:
            day = msg.created_at.date()
            timeline.daily_messages[day] = timeline.daily_messages.get(day, 0) + 1

    # Calculate cumulative conversations
    if timeline.daily_conversations:
        sorted_days = sorted(timeline.daily_conversations.keys())
        cumsum = 0
        for day in sorted_days:
            cumsum += timeline.daily_conversations[day]
            timeline.cumulative_conversations[day] = cumsum

    metrics.timeline = timeline

    # Activity range
    if all_first_activities:
        metrics.first_activity = min(all_first_activities)
    if all_last_activities:
        metrics.last_activity = max(all_last_activities)
        # Handle timezone-aware vs naive datetime comparison
        now = datetime.now(timezone.utc)
        last = metrics.last_activity
        if last.tzinfo is None:
            # Make naive datetime UTC-aware for comparison
            last = last.replace(tzinfo=timezone.utc)
        metrics.days_since_last_activity = (now - last).days

    return metrics


def calculate_trends(
    current_metrics: UsageMetrics,
    previous_metrics: Optional[UsageMetrics],
) -> Dict[str, Any]:
    """
    Calculate trends comparing current period to previous period.

    Returns percentage changes and trend directions.
    """
    if previous_metrics is None:
        return {}

    def calc_change(current: float, previous: float) -> Tuple[float, str]:
        """Calculate percentage change and direction."""
        if previous == 0:
            if current > 0:
                return (100.0, "up")
            return (0.0, "flat")
        change = ((current - previous) / previous) * 100
        direction = "up" if change > 0 else "down" if change < 0 else "flat"
        return (abs(change), direction)

    trends = {
        "conversations": calc_change(
            current_metrics.audio.total_conversations,
            previous_metrics.audio.total_conversations,
        ),
        "duration": calc_change(
            current_metrics.audio.total_duration_seconds,
            previous_metrics.audio.total_duration_seconds,
        ),
        "chats": calc_change(
            current_metrics.chat.total_chats,
            previous_metrics.chat.total_chats,
        ),
        "messages": calc_change(
            current_metrics.chat.total_messages,
            previous_metrics.chat.total_messages,
        ),
        "reports": calc_change(
            current_metrics.reports.total_reports,
            previous_metrics.reports.total_reports,
        ),
    }

    return trends


def get_period_comparison(
    current_range: DateRange,
) -> DateRange:
    """Get the previous period of the same length for comparison."""
    period_length = (current_range.end - current_range.start).days + 1
    previous_end = current_range.start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=period_length - 1)
    return DateRange(start=previous_start, end=previous_end)
