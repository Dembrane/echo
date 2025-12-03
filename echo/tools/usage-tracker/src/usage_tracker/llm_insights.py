"""LLM-powered insights generation for usage tracker."""

from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .data_fetcher import UserInfo
from .metrics import UsageMetrics, format_duration
from .prompts import render_prompt
from .settings import get_settings

logger = logging.getLogger(__name__)


def _get_litellm():
    """Lazy import of litellm to avoid import errors if not configured."""
    try:
        import litellm

        return litellm
    except ImportError:
        logger.error("litellm not installed. Run: pip install litellm")
        return None


def _get_completion_kwargs() -> Dict[str, Any]:
    """Get LiteLLM completion kwargs from settings."""
    settings = get_settings()
    llm = settings.llm

    if not llm.is_configured:
        raise ValueError("LLM not configured. Set LLM__TEXT_FAST__* environment variables.")

    kwargs: Dict[str, Any] = {"model": llm.model}

    if llm.api_key:
        kwargs["api_key"] = llm.api_key
    if llm.api_base:
        kwargs["api_base"] = llm.api_base
    if llm.api_version:
        kwargs["api_version"] = llm.api_version

    return kwargs


def _build_metrics_context(
    users: List[UserInfo],
    metrics: UsageMetrics,
    trends: Optional[Dict[str, Any]] = None,
) -> str:
    """Build context string from metrics for LLM prompt."""
    user_names = ", ".join(u.display_name for u in users[:5])
    if len(users) > 5:
        user_names += f" and {len(users) - 5} others"

    context_parts = [
        f"# Usage Report for: {user_names}",
        "",
        "## Summary Metrics",
        f"- Total Projects: {metrics.projects.total_projects}",
        f"- Active Projects (with conversations): {metrics.projects.active_projects}",
        f"- Total Conversations: {metrics.audio.total_conversations}",
        f"- Total Audio Duration: {metrics.audio.total_duration_formatted}",
        f"- Average Duration per Conversation: {metrics.audio.avg_duration_formatted}",
        "",
        "## Chat Usage",
        f"- Total Chat Sessions: {metrics.chat.total_chats}",
        f"- Total Messages: {metrics.chat.total_messages}",
        f"- User Messages: {metrics.chat.user_messages}",
        f"- Assistant Responses: {metrics.chat.assistant_messages}",
        f"- Average Messages per Chat: {metrics.chat.avg_messages_per_chat:.1f}",
        "",
        "## Reports",
        f"- Total Reports Generated: {metrics.reports.total_reports}",
        f"- Published Reports: {metrics.reports.published_reports}",
        "",
        "## Feature Adoption",
        f"- Uses Conversations: {'Yes' if metrics.adoption.uses_conversations else 'No'}",
        f"- Uses Chat: {'Yes' if metrics.adoption.uses_chat else 'No'}",
        f"- Uses Reports: {'Yes' if metrics.adoption.uses_reports else 'No'}",
    ]

    login_last = (
        metrics.logins.last_login.strftime("%Y-%m-%d %H:%M") if metrics.logins.last_login else "n/a"
    )
    context_parts.extend(
        [
            "",
            "## Login Activity",
            f"- Total Logins: {metrics.logins.total_logins}",
            f"- Active Login Days: {metrics.logins.unique_days}",
            f"- Unique Login Users: {metrics.logins.unique_users}",
            f"- Avg Logins / Active Day: {metrics.logins.avg_logins_per_active_day:.1f}",
            f"- Last Login Recorded: {login_last}",
        ]
    )

    if metrics.first_activity:
        context_parts.append("")
        context_parts.append("## Activity Timeline")
        context_parts.append(f"- First Activity: {metrics.first_activity.strftime('%Y-%m-%d')}")
        if metrics.last_activity:
            context_parts.append(f"- Last Activity: {metrics.last_activity.strftime('%Y-%m-%d')}")
        if metrics.days_since_last_activity is not None:
            context_parts.append(f"- Days Since Last Activity: {metrics.days_since_last_activity}")

    # Add trends if available
    if trends:
        context_parts.append("")
        context_parts.append("## Trends (vs Previous Period)")
        for key, (change, direction) in trends.items():
            arrow = "↑" if direction == "up" else "↓" if direction == "down" else "→"
            context_parts.append(f"- {key.title()}: {arrow} {change:.1f}%")

    # Add top query words if available
    if metrics.chat.top_query_words:
        context_parts.append("")
        context_parts.append("## Top Query Topics")
        top_10 = metrics.chat.top_query_words[:10]
        for word, count in top_10:
            context_parts.append(f"- {word}: {count} mentions")

    return "\n".join(context_parts)


@dataclass
class DashboardStats:
    range_label: str
    mau: int
    dau: int
    avg_daily_conversations: float
    avg_daily_projects: float
    top_users: List[tuple]
    top_projects: List[tuple]
    ignored_accounts: List[str] = field(default_factory=list)


@dataclass
class MonthlyOverviewPayload:
    range_label: str
    avg_conversations: float
    median_conversations: float
    p90_conversations: float
    avg_chats: float
    avg_logins: float
    content_ratio: float
    duration_per_conversation: float
    conversations_per_project: float
    notes: List[str] = field(default_factory=list)


def generate_insights(
    users: List[UserInfo],
    metrics: UsageMetrics,
    trends: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Generate LLM-powered insights from usage metrics.

    Returns markdown-formatted insights.
    """
    litellm = _get_litellm()
    if litellm is None:
        return "⚠️ LLM not available. Install litellm to enable AI insights."

    settings = get_settings()
    if not settings.llm.is_configured:
        return "⚠️ LLM not configured. Set LLM__TEXT_FAST__* environment variables."

    try:
        kwargs = _get_completion_kwargs()
        context = _build_metrics_context(users, metrics, trends)

        system_prompt = render_prompt("insights_system.j2")
        user_prompt = render_prompt("insights_user.j2", context=context)

        response = litellm.completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.7,
            **kwargs,
        )

        return response.choices[0].message.content

    except Exception as e:
        logger.error(f"Failed to generate insights: {e}")
        return f"⚠️ Failed to generate insights: {str(e)}"


def generate_executive_summary(
    users: List[UserInfo],
    metrics: UsageMetrics,
) -> str:
    """
    Generate a brief executive summary suitable for PDF reports.

    Returns a 2-3 paragraph summary.
    """
    litellm = _get_litellm()
    if litellm is None:
        return _generate_fallback_summary(users, metrics)

    settings = get_settings()
    if not settings.llm.is_configured:
        return _generate_fallback_summary(users, metrics)

    try:
        kwargs = _get_completion_kwargs()
        context = _build_metrics_context(users, metrics)

        system_prompt = render_prompt("executive_summary_system.j2")
        user_prompt = render_prompt("executive_summary_user.j2", context=context)

        response = litellm.completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.5,
            **kwargs,
        )

        return response.choices[0].message.content

    except Exception as e:
        logger.error(f"Failed to generate summary: {e}")
        return _generate_fallback_summary(users, metrics)


def _format_dashboard_context(stats: DashboardStats) -> str:
    lines = [
        f"Range: {stats.range_label}",
        f"MAU: {stats.mau}",
        f"DAU: {stats.dau}",
        f"Avg Daily Conversations: {stats.avg_daily_conversations:.1f}",
        f"Avg Daily Projects: {stats.avg_daily_projects:.1f}",
        "Top Users:",
    ]
    if stats.top_users:
        for name, count in stats.top_users:
            lines.append(f"- {name}: {count} logins")
    else:
        lines.append("- None")
    lines.append("Top Projects:")
    if stats.top_projects:
        for project, convs, chats in stats.top_projects:
            lines.append(f"- {project}: {convs} convs / {chats} chats")
    else:
        lines.append("- None")
    if stats.ignored_accounts:
        lines.append("Ignore Accounts:")
        for account in stats.ignored_accounts:
            lines.append(f"- {account}")
    return "\n".join(lines)


def _fallback_dashboard_summary(stats: DashboardStats) -> str:
    return (
        f"**Sales Snapshot ({stats.range_label})**\n"
        f"- MAU {stats.mau}, DAU {stats.dau}\n"
        f"- Avg daily conversations {stats.avg_daily_conversations:.1f}; "
        f"avg daily projects {stats.avg_daily_projects:.1f}\n"
    )


def generate_dashboard_overview(stats: DashboardStats) -> str:
    """Generate a dashboard-level LLM summary for the sales team."""
    litellm = _get_litellm()
    if litellm is None:
        return _fallback_dashboard_summary(stats)

    settings = get_settings()
    if not settings.llm.is_configured:
        return _fallback_dashboard_summary(stats)

    try:
        kwargs = _get_completion_kwargs()
        context = _format_dashboard_context(stats)
        system_prompt = render_prompt("dashboard_system.j2")
        user_prompt = render_prompt("dashboard_user.j2", context=context)

        response = litellm.completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.4,
            **kwargs,
        )
        return response.choices[0].message.content
    except Exception as exc:  # noqa: BLE001
        logger.error(f"Failed to generate dashboard overview: {exc}")
        return _fallback_dashboard_summary(stats)


def _format_monthly_overview_context(payload: MonthlyOverviewPayload) -> str:
    duration_minutes = payload.duration_per_conversation / 60
    lines = [
        f"Time period: {payload.range_label}",
        "",
        "CONVERSATIONS (data from participants - via QR scan or upload):",
        f"- Average per month: {payload.avg_conversations:.1f}",
        f"- Median per month: {payload.median_conversations:.1f}",
        f"- Top users (P90): {payload.p90_conversations:.1f}",
        f"- Content ratio: {payload.content_ratio:.0%} have actual transcripts",
        "",
        "HOST ANALYSIS ACTIVITY (when they log in to work with the data):",
        f"- Logins per month: {payload.avg_logins:.1f}",
        f"- Chat sessions per month: {payload.avg_chats:.1f}",
        "",
        "CONVERSATION CHARACTERISTICS:",
        f"- Average recording length: {duration_minutes:.0f} minutes",
        "",
        "PROJECT ORGANIZATION:",
        f"- Conversations per project: {payload.conversations_per_project:.1f}",
    ]
    if payload.notes:
        lines.append("")
        lines.append("Notes:")
        lines.extend(f"- {note}" for note in payload.notes)
    return "\n".join(lines)


def _fallback_monthly_overview(payload: MonthlyOverviewPayload) -> str:
    return (
        f"{payload.range_label}: {payload.avg_conversations:.1f} avg conversations/mo "
        f"(median {payload.median_conversations:.1f}, p90 {payload.p90_conversations:.1f}). "
        f"Chat sessions average {payload.avg_chats:.1f} and logins {payload.avg_logins:.1f}."
    )


def generate_monthly_overview(
    payload: MonthlyOverviewPayload,
    user_profile_context: Optional[str] = None,
) -> str:
    """Generate a concise two-paragraph monthly overview."""
    litellm = _get_litellm()
    if litellm is None:
        return _fallback_monthly_overview(payload)

    settings = get_settings()
    if not settings.llm.is_configured:
        return _fallback_monthly_overview(payload)

    try:
        kwargs = _get_completion_kwargs()
        context = _format_monthly_overview_context(payload)
        system_prompt = render_prompt("monthly_overview_system.j2")
        user_prompt = render_prompt(
            "monthly_overview_user.j2",
            context=context,
            user_profile=user_profile_context or "",
        )

        response = litellm.completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.4,
            **kwargs,
        )
        return response.choices[0].message.content
    except Exception as exc:  # noqa: BLE001
        logger.error(f"Failed to generate monthly overview: {exc}")
        return _fallback_monthly_overview(payload)


def _generate_fallback_summary(
    users: List[UserInfo],
    metrics: UsageMetrics,
) -> str:
    """Generate a basic summary without LLM."""
    user_count = len(users)
    user_text = "user" if user_count == 1 else f"{user_count} users"

    summary_parts = [
        f"This report covers usage data for {user_text}.",
        "",
    ]

    if metrics.projects.total_projects > 0:
        summary_parts.append(
            f"The account has {metrics.projects.total_projects} project(s) with "
            f"{metrics.audio.total_conversations} total conversations, "
            f"representing {metrics.audio.total_duration_formatted} of audio content."
        )
    else:
        summary_parts.append("The account has not created any projects yet.")

    if metrics.chat.total_chats > 0:
        summary_parts.append(
            f"Chat functionality has been used with {metrics.chat.total_chats} sessions "
            f"and {metrics.chat.total_messages} total messages."
        )

    if metrics.reports.total_reports > 0:
        summary_parts.append(f"{metrics.reports.published_reports} report(s) have been generated.")

    return " ".join(summary_parts)


def analyze_chat_messages(
    messages_text: List[str],
    user_profile_context: Optional[str] = None,
) -> str:
    """
    Analyze chat messages using LLM.

    Works best with <1000 messages. Returns themes, patterns, and what users are asking about.
    If user_profile_context is provided, uses it to inform the analysis.
    """
    if not messages_text:
        return "No messages to analyze."

    litellm = _get_litellm()
    if litellm is None:
        return "⚠️ LLM not available."

    settings = get_settings()
    if not settings.llm.is_configured:
        return "⚠️ LLM not configured."

    try:
        kwargs = _get_completion_kwargs()

        # Use all messages if under 500, otherwise random sample
        import random

        if len(messages_text) <= 500:
            sample = messages_text
        else:
            sample = random.sample(messages_text, 500)

        # Truncate each message to keep context reasonable
        messages_str = "\n".join(f"- {m[:300]}" for m in sample)

        system_prompt = render_prompt("chat_analysis_system.j2")
        user_prompt = render_prompt(
            "chat_analysis_user.j2",
            message_count=len(sample),
            messages_blob=messages_str,
            user_profile=user_profile_context or "",
        )

        response = litellm.completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.5,
            **kwargs,
        )

        return response.choices[0].message.content

    except Exception as e:
        logger.error(f"Failed to analyze chat: {e}")
        return f"⚠️ Analysis failed: {str(e)}"


def _fallback_stratified_chat_summary(segment_samples: Dict[str, List[str]]) -> str:
    lines = ["Chat cohort snapshot (LLM offline):"]
    for segment, messages in segment_samples.items():
        tokens = Counter()
        for message in messages:
            extracted = re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ]{3,}", message.lower())
            tokens.update(extracted)
        top_terms = ", ".join(word for word, _ in tokens.most_common(5))
        if top_terms:
            lines.append(f"- {segment}: {top_terms}")
        else:
            lines.append(f"- {segment}: insufficient signal")
    return "\n".join(lines)


def analyze_stratified_chat_segments(
    segment_samples: Dict[str, List[str]],
    ignored_accounts: Optional[List[str]] = None,
) -> str:
    """
    Analyze segment-specific chat samples to uncover emerging trends.
    """
    if not segment_samples:
        return "No chat cohorts available for analysis."

    litellm = _get_litellm()
    if litellm is None:
        return _fallback_stratified_chat_summary(segment_samples)

    settings = get_settings()
    if not settings.llm.is_configured:
        return _fallback_stratified_chat_summary(segment_samples)

    try:
        kwargs = _get_completion_kwargs()
        segment_blocks = []
        for segment, messages in segment_samples.items():
            trimmed = []
            for msg in messages[:80]:
                sanitized = " ".join(msg.split())
                trimmed.append(f"- {sanitized[:280]}")
            block = f"Segment: {segment} ({len(messages)} samples)\n" + "\n".join(trimmed)
            segment_blocks.append(block)

        ignore_clause = ""
        if ignored_accounts:
            ignore_clause = "Ignore these service/automation accounts entirely: " + ", ".join(
                sorted(set(ignored_accounts))
            )

        payload = "\n\n".join(segment_blocks)
        system_prompt = render_prompt("stratified_chat_system.j2")
        user_prompt = render_prompt(
            "stratified_chat_user.j2",
            ignore_clause=ignore_clause,
            payload=payload,
        )

        response = litellm.completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.4,
            **kwargs,
        )

        return response.choices[0].message.content
    except Exception as exc:  # noqa: BLE001
        logger.error(f"Failed to analyze stratified chat segments: {exc}")
        return _fallback_stratified_chat_summary(segment_samples)


def generate_timeline_insights(metrics: UsageMetrics) -> str:
    """
    Generate LLM-powered insights specifically for the activity timeline.

    Analyzes patterns like peak days, project distribution, anomalies.
    """
    litellm = _get_litellm()
    if litellm is None:
        return "⚠️ LLM not available for timeline insights."

    settings = get_settings()
    if not settings.llm.is_configured:
        return "⚠️ LLM not configured for timeline insights."

    # Build timeline context
    timeline = metrics.timeline
    if not timeline.daily_conversations:
        return "No timeline data available for analysis."

    # Find peak days
    sorted_days = sorted(timeline.daily_conversations.items(), key=lambda x: x[1], reverse=True)
    peak_days = sorted_days[:5] if len(sorted_days) >= 5 else sorted_days

    # Find peak days by duration
    sorted_duration_days = sorted(timeline.daily_duration.items(), key=lambda x: x[1], reverse=True)
    peak_duration_days = (
        sorted_duration_days[:5] if len(sorted_duration_days) >= 5 else sorted_duration_days
    )

    # Per-project totals
    project_totals = []
    for proj_id, daily_data in timeline.daily_conversations_by_project.items():
        total_convs = sum(daily_data.values())
        total_duration = sum(timeline.daily_duration_by_project.get(proj_id, {}).values())
        proj_name = timeline.project_names.get(proj_id, proj_id[:8])
        project_totals.append((proj_name, total_convs, total_duration))

    project_totals.sort(key=lambda x: x[1], reverse=True)

    # Build context string
    context_parts = [
        "## Timeline Data",
        "",
        f"**Total days with activity:** {len(timeline.daily_conversations)}",
        f"**Date range:** {min(timeline.daily_conversations.keys())} to {max(timeline.daily_conversations.keys())}",
        "",
        "### Peak Days (by conversation count):",
    ]

    for day, count in peak_days:
        duration = timeline.daily_duration.get(day, 0)
        context_parts.append(
            f"- {day.strftime('%A, %B %d, %Y')}: {count} conversations, {format_duration(duration)}"
        )

    context_parts.append("")
    context_parts.append("### Peak Days (by duration):")
    for day, duration in peak_duration_days:
        count = timeline.daily_conversations.get(day, 0)
        context_parts.append(
            f"- {day.strftime('%A, %B %d, %Y')}: {format_duration(duration)}, {count} conversations"
        )

    context_parts.append("")
    context_parts.append("### Activity by Project:")
    for proj_name, convs, duration in project_totals[:10]:
        context_parts.append(f"- {proj_name}: {convs} conversations, {format_duration(duration)}")

    # Day of week distribution
    dow_counts: Dict[str, int] = {}
    for day, count in timeline.daily_conversations.items():
        dow = day.strftime("%A")
        dow_counts[dow] = dow_counts.get(dow, 0) + count

    context_parts.append("")
    context_parts.append("### Day of Week Distribution:")
    for dow in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]:
        if dow in dow_counts:
            context_parts.append(f"- {dow}: {dow_counts[dow]} conversations")

    context = "\n".join(context_parts)

    try:
        kwargs = _get_completion_kwargs()

        system_prompt = render_prompt("timeline_system.j2")
        user_prompt = render_prompt("timeline_user.j2", context=context)

        response = litellm.completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.7,
            **kwargs,
        )

        return response.choices[0].message.content

    except Exception as e:
        logger.error(f"Failed to generate timeline insights: {e}")
        return f"⚠️ Failed to generate timeline insights: {str(e)}"


@dataclass
class ProjectStructureSample:
    """Detailed sample of a single project's structure."""

    name: str
    tags: List[str]
    participant_names: List[str]  # Sample of conversation.participant_name values
    conversation_count: int
    has_context: bool
    has_portal_customization: bool
    context_snippet: str = ""  # First 150 chars of context


@dataclass
class UserProfilePayload:
    """Payload for user profile analysis."""

    project_count: int
    portal_title_pct: float
    portal_desc_pct: float
    transcript_prompt_pct: float
    proj_context_pct: float
    # Tag usage
    projects_with_tags_pct: float = 0.0
    avg_tags_per_project: float = 0.0
    sample_tags: List[str] = field(default_factory=list)
    # Detailed project samples
    project_samples: List[ProjectStructureSample] = field(default_factory=list)
    # Content samples
    sample_project_contexts: List[str] = field(default_factory=list)
    conversation_summaries: List[str] = field(default_factory=list)
    summary_count: int = 0
    chat_queries: List[str] = field(default_factory=list)
    query_count: int = 0


def _anonymize_text(text: str) -> str:
    """Basic anonymization - remove emails, phone numbers, specific names patterns."""
    import re

    # Remove emails
    text = re.sub(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", "[email]", text)
    # Remove phone numbers (various formats)
    text = re.sub(r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b", "[phone]", text)
    # Remove URLs
    text = re.sub(r"https?://\S+", "[url]", text)
    return text


def _truncate_for_context(items: List[str], max_chars: int = 15000) -> List[str]:
    """Truncate list of strings to fit within character limit."""
    result = []
    total_chars = 0
    for item in items:
        if total_chars + len(item) > max_chars:
            break
        result.append(item)
        total_chars += len(item) + 10  # Account for formatting
    return result


def generate_user_profile(payload: UserProfilePayload) -> str:
    """Generate a user profile analysis."""
    litellm = _get_litellm()
    if litellm is None:
        return _fallback_user_profile(payload)

    settings = get_settings()
    if not settings.llm.is_configured:
        return _fallback_user_profile(payload)

    try:
        kwargs = _get_completion_kwargs()

        # Truncate samples to fit context
        summaries = _truncate_for_context(payload.conversation_summaries, max_chars=8000)
        queries = _truncate_for_context(payload.chat_queries, max_chars=6000)
        contexts = _truncate_for_context(payload.sample_project_contexts, max_chars=2000)

        system_prompt = render_prompt("user_profile_system.j2")
        user_prompt = render_prompt(
            "user_profile_user.j2",
            project_count=payload.project_count,
            portal_title_pct=payload.portal_title_pct,
            portal_desc_pct=payload.portal_desc_pct,
            transcript_prompt_pct=payload.transcript_prompt_pct,
            proj_context_pct=payload.proj_context_pct,
            projects_with_tags_pct=payload.projects_with_tags_pct,
            avg_tags_per_project=payload.avg_tags_per_project,
            sample_tags=payload.sample_tags,
            project_samples=payload.project_samples,
            sample_project_contexts=contexts,
            conversation_summaries=summaries,
            summary_count=payload.summary_count,
            chat_queries=queries,
            query_count=payload.query_count,
        )

        response = litellm.completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.5,
            **kwargs,
        )

        return response.choices[0].message.content

    except Exception as e:
        logger.error(f"Failed to generate user profile: {e}")
        return _fallback_user_profile(payload)


def _fallback_user_profile(payload: UserProfilePayload) -> str:
    """Fallback when LLM is unavailable."""
    lines = [
        "**How They Use ECHO**",
        f"{payload.project_count} projects with {payload.summary_count} conversations analyzed.",
        "",
        "**Project Setup Style**",
        f"Portal customization: {payload.portal_title_pct:.0f}% titles, {payload.portal_desc_pct:.0f}% descriptions. ",
        f"Tags: {payload.projects_with_tags_pct:.0f}% of projects tagged ({payload.avg_tags_per_project:.1f} avg).",
        "",
        "**What They're Exploring**",
        f"{payload.query_count} questions asked in chat sessions.",
    ]
    if payload.sample_tags:
        lines.append(f"Common tags: {', '.join(payload.sample_tags[:5])}")
    return "\n".join(lines)
