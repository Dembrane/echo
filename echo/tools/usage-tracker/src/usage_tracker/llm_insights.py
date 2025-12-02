"""LLM-powered insights generation for usage tracker."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from .settings import get_settings
from .data_fetcher import UserUsageData, UserInfo
from .metrics import UsageMetrics, format_duration

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


INSIGHTS_SYSTEM_PROMPT = """Sales analyst for Dembrane ECHO (qualitative research platform). Give actionable insights. Be brief, use bullets. Focus on non-obvious patterns, growth signals, churn risks."""


INSIGHTS_USER_PROMPT = """Analyze this usage data. Give 4-5 key insights + 2-3 actions.

{context}

Format:
**Insights**
- [title]: [1 sentence with data]
...

**Actions**
- [action]
..."""


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

        response = litellm.completion(
            messages=[
                {"role": "system", "content": INSIGHTS_SYSTEM_PROMPT},
                {"role": "user", "content": INSIGHTS_USER_PROMPT.format(context=context)},
            ],
            temperature=0.7,
            max_tokens=1500,
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

        response = litellm.completion(
            messages=[
                {"role": "system", "content": "Write a 2-paragraph executive summary. Be concise."},
                {"role": "user", "content": f"Summarize:\n{context}"},
            ],
            temperature=0.5,
            max_tokens=300,
            **kwargs,
        )

        return response.choices[0].message.content

    except Exception as e:
        logger.error(f"Failed to generate summary: {e}")
        return _generate_fallback_summary(users, metrics)


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


def analyze_chat_messages(messages_text: List[str]) -> str:
    """
    Analyze chat messages using LLM.

    Works best with <1000 messages. Returns themes, patterns, and what users are asking about.
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

        response = litellm.completion(
            messages=[
                {"role": "system", "content": "Analyze user chat queries. Identify: main topics, common question types, what they're researching. Use bullets. Be specific."},
                {"role": "user", "content": f"User messages ({len(sample)} total):\n{messages_str}"},
            ],
            temperature=0.5,
            max_tokens=500,
            **kwargs,
        )

        return response.choices[0].message.content

    except Exception as e:
        logger.error(f"Failed to analyze chat: {e}")
        return f"⚠️ Analysis failed: {str(e)}"


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

        response = litellm.completion(
            messages=[
                {
                    "role": "system",
                    "content": "Analyze timeline for sales. Find peak days (events?), active projects, patterns. Be specific with dates. Use bullets.",
                },
                {"role": "user", "content": f"Timeline data:\n{context}"},
            ],
            temperature=0.7,
            max_tokens=500,
            **kwargs,
        )

        return response.choices[0].message.content

    except Exception as e:
        logger.error(f"Failed to generate timeline insights: {e}")
        return f"⚠️ Failed to generate timeline insights: {str(e)}"
