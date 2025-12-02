"""PDF export functionality for usage reports."""

from __future__ import annotations

import io
import re
import logging
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch, cm
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
    HRFlowable,
    Image,
)
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT

from .data_fetcher import UserInfo, DateRange, UserUsageData
from .metrics import UsageMetrics, format_duration, estimate_conversation_duration

logger = logging.getLogger(__name__)

# Color palette
COLORS = {
    "primary": colors.HexColor("#1a1a2e"),
    "secondary": colors.HexColor("#16213e"),
    "accent": colors.HexColor("#667eea"),
    "success": colors.HexColor("#10b981"),
    "muted": colors.HexColor("#6b7280"),
    "light_bg": colors.HexColor("#f8f9fa"),
    "border": colors.HexColor("#e5e7eb"),
    "white": colors.white,
}


def _markdown_to_plain_text(text: str) -> str:
    """
    Convert markdown to ReportLab-safe formatted text.

    Handles bold, headers, lists, and line breaks safely.
    """
    if not text:
        return ""

    result = text

    # Convert markdown headers to bold
    result = re.sub(r"^#{1,3}\s+(.+)$", r"<b>\1</b>", result, flags=re.MULTILINE)

    # Convert **bold** to <b>bold</b> (properly paired)
    result = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", result)

    # Convert *italic* to <i>italic</i>
    result = re.sub(r"\*([^*]+)\*", r"<i>\1</i>", result)

    # Convert markdown bullet lists
    result = re.sub(r"^[-•]\s+", "• ", result, flags=re.MULTILINE)

    # Convert numbered lists (keep as-is but clean up)
    result = re.sub(r"^(\d+)\.\s+", r"\1. ", result, flags=re.MULTILINE)

    # Convert double newlines to paragraph breaks
    result = result.replace("\n\n", "<br/><br/>")

    # Convert single newlines to line breaks
    result = result.replace("\n", "<br/>")

    # Clean up any malformed tags (safety net)
    result = re.sub(r"<b>([^<]*)<b>", r"<b>\1</b>", result)
    result = re.sub(r"<b>([^<]*)$", r"\1", result)

    # Escape special characters that could break XML
    result = result.replace("&", "&amp;")
    result = result.replace("<br/>", "\n<BR/>")
    result = result.replace("&amp;", "&")
    result = result.replace("\n<BR/>", "<br/>")

    return result


def _create_styles():
    """Create custom paragraph styles."""
    styles = getSampleStyleSheet()

    styles.add(
        ParagraphStyle(
            "ReportTitle",
            parent=styles["Heading1"],
            fontSize=28,
            spaceAfter=12,
            alignment=TA_CENTER,
            textColor=COLORS["primary"],
            fontName="Helvetica-Bold",
        )
    )

    styles.add(
        ParagraphStyle(
            "ReportSubtitle",
            parent=styles["Normal"],
            fontSize=11,
            spaceAfter=24,
            alignment=TA_CENTER,
            textColor=COLORS["muted"],
        )
    )

    styles.add(
        ParagraphStyle(
            "SectionTitle",
            parent=styles["Heading2"],
            fontSize=14,
            spaceBefore=20,
            spaceAfter=12,
            textColor=COLORS["secondary"],
            fontName="Helvetica-Bold",
        )
    )

    styles.add(
        ParagraphStyle(
            "SubSection",
            parent=styles["Heading3"],
            fontSize=11,
            spaceBefore=12,
            spaceAfter=6,
            textColor=COLORS["accent"],
            fontName="Helvetica-Bold",
        )
    )

    # Override existing BodyText style
    styles["BodyText"].fontSize = 10
    styles["BodyText"].spaceBefore = 4
    styles["BodyText"].spaceAfter = 4
    styles["BodyText"].leading = 16

    styles.add(
        ParagraphStyle(
            "MetricLabel",
            parent=styles["Normal"],
            fontSize=9,
            textColor=COLORS["muted"],
            alignment=TA_CENTER,
        )
    )

    styles.add(
        ParagraphStyle(
            "MetricValue",
            parent=styles["Normal"],
            fontSize=20,
            fontName="Helvetica-Bold",
            textColor=COLORS["primary"],
            alignment=TA_CENTER,
        )
    )

    styles.add(
        ParagraphStyle(
            "MetricValueSmall",
            parent=styles["Normal"],
            fontSize=14,
            fontName="Helvetica-Bold",
            textColor=COLORS["primary"],
            alignment=TA_CENTER,
        )
    )

    styles.add(
        ParagraphStyle(
            "MetricSubtext",
            parent=styles["Normal"],
            fontSize=8,
            textColor=COLORS["muted"],
            alignment=TA_CENTER,
        )
    )

    styles.add(
        ParagraphStyle(
            "Footer",
            parent=styles["Normal"],
            fontSize=8,
            textColor=COLORS["muted"],
            alignment=TA_CENTER,
        )
    )

    styles.add(
        ParagraphStyle(
            "KeywordTag",
            parent=styles["Normal"],
            fontSize=9,
            textColor=COLORS["accent"],
        )
    )

    styles.add(
        ParagraphStyle(
            "SmallText",
            parent=styles["Normal"],
            fontSize=9,
            textColor=COLORS["muted"],
            leading=12,
        )
    )

    return styles


def _create_hero_metric(label: str, value: str, subtext: str, styles) -> Table:
    """Create a large hero metric for the summary section."""
    data = [
        [Paragraph(value, styles["MetricValue"])],
        [Paragraph(label, styles["MetricLabel"])],
    ]
    if subtext:
        data.append([Paragraph(subtext, styles["MetricSubtext"])])

    table = Table(data, colWidths=[2.2 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), COLORS["light_bg"]),
                ("BOX", (0, 0), (-1, -1), 1, COLORS["border"]),
                ("TOPPADDING", (0, 0), (-1, 0), 14),
                ("BOTTOMPADDING", (0, -1), (-1, -1), 12),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    return table


def _create_compact_metric(label: str, value: str, styles) -> Table:
    """Create a compact metric box."""
    data = [
        [Paragraph(value, styles["MetricValueSmall"])],
        [Paragraph(label, styles["MetricLabel"])],
    ]

    table = Table(data, colWidths=[1.6 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), COLORS["white"]),
                ("BOX", (0, 0), (-1, -1), 1, COLORS["border"]),
                ("TOPPADDING", (0, 0), (-1, 0), 10),
                ("BOTTOMPADDING", (0, -1), (-1, -1), 10),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    return table


def _create_data_table(headers: List[str], rows: List[List[str]], col_widths: List[float]) -> Table:
    """Create a styled data table."""
    data = [headers] + rows

    table = Table(data, colWidths=col_widths)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), COLORS["primary"]),
                ("TEXTCOLOR", (0, 0), (-1, 0), COLORS["white"]),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("GRID", (0, 0), (-1, -1), 0.5, COLORS["border"]),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [COLORS["white"], COLORS["light_bg"]]),
            ]
        )
    )
    return table


def _format_keywords(words: List[Tuple[str, int]], limit: int = 15) -> str:
    """Format top keywords as a comma-separated string."""
    if not words:
        return "—"
    top_words = words[:limit]
    return ", ".join(word for word, _ in top_words)


def _format_trend(pct: float, direction: str) -> str:
    """Format trend indicator for PDF."""
    if direction == "flat":
        return "→"
    arrow = "↑" if direction == "up" else "↓"
    return f"{arrow} {pct:.0f}%"


def _build_project_usage_breakdown(
    usage_data: Optional[List[UserUsageData]],
):
    """Aggregate per-project hours and chat stats for the PDF."""
    if not usage_data:
        return []

    summary: Dict[str, Dict[str, Any]] = {}

    def get_entry(project_id: str) -> Dict[str, Any]:
        if project_id not in summary:
            summary[project_id] = {
                "project_id": project_id,
                "project_name": "Unnamed Project",
                "owner": None,
                "duration": 0,
                "conversations": 0,
                "chat_messages": 0,
                "chat_ids": set(),
            }
        return summary[project_id]

    for user_data in usage_data:
        owner_name = user_data.user.display_name
        project_lookup = {proj.id: proj for proj in user_data.projects}
        chat_project_map = {chat.id: chat.project_id for chat in user_data.chats}

        # Conversations
        for conv in user_data.conversations:
            if not conv.project_id:
                continue
            entry = get_entry(conv.project_id)
            proj_meta = project_lookup.get(conv.project_id)
            if proj_meta and proj_meta.name:
                entry["project_name"] = proj_meta.name
            if entry["owner"] is None:
                entry["owner"] = owner_name
            entry["conversations"] += 1
            entry["duration"] += estimate_conversation_duration(conv)

        # Chat messages -> derive chat sessions touched during range
        for msg in user_data.chat_messages:
            proj_id = chat_project_map.get(msg.chat_id)
            if not proj_id:
                continue
            entry = get_entry(proj_id)
            proj_meta = project_lookup.get(proj_id)
            if proj_meta and proj_meta.name:
                entry["project_name"] = proj_meta.name
            if entry["owner"] is None:
                entry["owner"] = owner_name
            entry["chat_messages"] += 1
            entry["chat_ids"].add(msg.chat_id)

    # Convert to list and calculate chat session counts
    projects = []
    for proj_id, data in summary.items():
        chat_sessions = len(data["chat_ids"])
        projects.append(
            {
                "project_id": proj_id,
                "project_name": data["project_name"],
                "owner": data["owner"] or "—",
                "duration": data["duration"],
                "conversations": data["conversations"],
                "chat_sessions": chat_sessions,
                "chat_messages": data["chat_messages"],
            }
        )

    projects.sort(key=lambda item: (item["duration"], item["chat_sessions"]), reverse=True)
    return projects


_CHART_LIBS: Optional[Tuple[Any, Any]] = None


def _load_chart_libs() -> Tuple[Optional["matplotlib.pyplot"], Optional["np"]]:
    """Lazy-load matplotlib/numpy for PDF charts."""
    global _CHART_LIBS
    if _CHART_LIBS is not None:
        return _CHART_LIBS

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np

        _CHART_LIBS = (plt, np)
    except ImportError:
        _CHART_LIBS = (None, None)

    return _CHART_LIBS


def generate_pdf_report(
    users: List[UserInfo],
    metrics: UsageMetrics,
    date_range: Optional[DateRange] = None,
    executive_summary: Optional[str] = None,
    insights: Optional[str] = None,
    usage_data: Optional[List[UserUsageData]] = None,
) -> bytes:
    """
    Generate a PDF usage report.

    Page 1: At-a-glance summary with key metrics
    Page 2+: Detailed analytics and AI insights

    Returns the PDF as bytes.
    """
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=1.5 * cm,
        leftMargin=1.5 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
    )

    styles = _create_styles()
    story = []

    # ========================================
    # PAGE 1: AT-A-GLANCE SUMMARY
    # ========================================

    # Title
    user_names = ", ".join(u.display_name for u in users[:5])
    if len(users) > 5:
        user_names += f" (+{len(users) - 5} more)"

    story.append(Paragraph(f"Dembrane Usage Report for {user_names}", styles["ReportTitle"]))

    if date_range:
        date_text = (
            f"{date_range.start.strftime('%b %d, %Y')} – {date_range.end.strftime('%b %d, %Y')}"
        )
    else:
        date_text = f"All Time · Generated {date.today().strftime('%b %d, %Y')}"

    story.append(Paragraph(date_text, styles["ReportSubtitle"]))

    # Hero Metrics Row (3 main metrics)
    hero_metrics = [
        [
            _create_hero_metric(
                "Conversations",
                str(metrics.audio.total_conversations),
                f"Avg {metrics.audio.avg_duration_formatted}",
                styles,
            ),
            _create_hero_metric(
                "Audio Duration",
                metrics.audio.total_duration_formatted,
                f"P50 {metrics.audio.p50_duration_formatted} · P90 {metrics.audio.p90_duration_formatted}",
                styles,
            ),
            _create_hero_metric(
                "Chat Sessions",
                str(metrics.chat.total_chats),
                f"{metrics.chat.user_messages} queries" if metrics.chat.total_chats > 0 else "",
                styles,
            ),
        ]
    ]

    hero_table = Table(hero_metrics, colWidths=[2.4 * inch, 2.4 * inch, 2.4 * inch])
    hero_table.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(hero_table)
    story.append(Spacer(1, 18))

    # Secondary Metrics Row
    secondary_metrics = [
        [
            _create_compact_metric("Projects", str(metrics.projects.total_projects), styles),
            _create_compact_metric(
                "Active Projects", str(metrics.projects.active_projects), styles
            ),
            _create_compact_metric("Messages", str(metrics.chat.total_messages), styles),
            _create_compact_metric(
                "Msg/Session",
                f"{metrics.chat.avg_messages_per_chat:.1f}"
                if metrics.chat.total_chats > 0
                else "—",
                styles,
            ),
        ]
    ]

    secondary_table = Table(
        secondary_metrics, colWidths=[1.8 * inch, 1.8 * inch, 1.8 * inch, 1.8 * inch]
    )
    secondary_table.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(secondary_table)
    story.append(Spacer(1, 20))

    # Login tier summary
    legend = "Power &gt;8/wk · High 5-8 · Medium 1-5 · Low &lt;1"
    if metrics.logins.total_logins == 0:
        login_text = f"<b>Login Tier:</b> No login activity recorded · {legend}"
    else:
        tier = metrics.logins.usage_band.title() if metrics.logins.usage_band else "Unknown"
        login_text = (
            f"<b>Login Tier:</b> {tier} ({metrics.logins.avg_logins_per_week:.1f} logins/week) · {legend}"
        )
    story.append(Paragraph(login_text, styles["SmallText"]))
    story.append(Spacer(1, 12))

    # Feature Adoption (compact inline)
    adoption_items = []
    if metrics.adoption.uses_conversations:
        adoption_items.append("✓ Conversations")
    if metrics.adoption.uses_chat:
        adoption_items.append("✓ Chat")
    if metrics.adoption.uses_reports:
        adoption_items.append("✓ Reports")

    if adoption_items:
        adoption_text = "  ·  ".join(adoption_items)
        story.append(Paragraph(f"<b>Features Active:</b>  {adoption_text}", styles["SmallText"]))
        story.append(Spacer(1, 12))

    # Divider
    story.append(HRFlowable(width="100%", thickness=1, color=COLORS["border"], spaceAfter=16))

    # Executive Summary
    if executive_summary:
        story.append(Paragraph("Executive Summary", styles["SectionTitle"]))
        summary_text = _markdown_to_plain_text(executive_summary)
        story.append(Paragraph(summary_text, styles["BodyText"]))
        story.append(Spacer(1, 12))

    # ========================================
    # PAGE 2: MONTHLY SUMMARY & TRENDS (Chart)
    # ========================================
    story.append(PageBreak())

    story.append(Paragraph("Monthly Trends", styles["ReportTitle"]))
    story.append(Spacer(1, 16))

    # Monthly summary chart (last 6 months)
    monthly_stats = metrics.timeline.monthly_stats
    if monthly_stats and len(monthly_stats) >= 2:
        # Take last 6 months only
        recent_months = monthly_stats[-6:] if len(monthly_stats) > 6 else monthly_stats

        # Generate chart using matplotlib if available
        plt, np = _load_chart_libs()
        if plt and np:
            fig, ax1 = plt.subplots(figsize=(7.2, 3.6))

            months = [m.month_label for m in recent_months]
            x = np.arange(len(months))
            width = 0.35

            # Stacked bars for conversations
            valid_convos = [m.conversations_valid for m in recent_months]
            empty_convos = [m.conversations_empty for m in recent_months]

            bars1 = ax1.bar(
                x,
                valid_convos,
                width,
                label="Conversations (with content)",
                color="#667eea",
                alpha=0.9,
            )
            bars2 = ax1.bar(
                x,
                empty_convos,
                width,
                bottom=valid_convos,
                label="Empty (no transcript)",
                color="#ef4444",
                alpha=0.9,
            )

            ax1.set_ylabel("Conversations / Chats", fontsize=9)
            ax1.set_xticks(x)
            ax1.set_xticklabels(months, fontsize=8)

            # Chats as markers on same axis
            chats = [m.chats for m in recent_months]
            ax1.plot(x, chats, "o--", color="#4ecdc4", linewidth=2, markersize=6, label="Chats")

            # Duration on secondary axis
            ax2 = ax1.twinx()
            duration_hours = [m.duration_seconds / 3600 for m in recent_months]
            ax2.plot(
                x,
                duration_hours,
                "s-",
                color="#f5576c",
                linewidth=2.5,
                markersize=7,
                label="Duration (hours)",
            )
            ax2.set_ylabel("Duration (hours)", fontsize=9, color="#f5576c")
            ax2.tick_params(axis="y", labelcolor="#f5576c")

            # Legend
            lines1, labels1 = ax1.get_legend_handles_labels()
            lines2, labels2 = ax2.get_legend_handles_labels()
            ax1.legend(
                lines1 + lines2, labels1 + labels2, loc="upper left", fontsize=7, framealpha=0.9
            )

            fig.tight_layout()
            plt.subplots_adjust(left=0.12, right=0.95, top=0.9, bottom=0.2)

            # Save to bytes
            chart_buffer = io.BytesIO()
            plt.savefig(chart_buffer, format="png", dpi=150, bbox_inches="tight")
            chart_buffer.seek(0)
            plt.close(fig)

            # Add chart image to PDF
            chart_img = Image(chart_buffer, width=6.5 * inch, height=3.25 * inch)
            story.append(chart_img)
            story.append(Spacer(1, 12))

            # Add legend explanation
            story.append(
                Paragraph(
                    "<b>Blue bars</b> = conversations with audio content · "
                    "<b>Red bars</b> = empty conversations (no chunks/transcript) · "
                    "<b>Red line</b> = duration in hours · "
                    "<b>Teal dashed</b> = chat sessions",
                    styles["SmallText"],
                )
            )

        else:
            story.append(Paragraph("Chart generation requires matplotlib.", styles["BodyText"]))
    else:
        story.append(
            Paragraph(
                "Not enough monthly data available (need at least 2 months).", styles["BodyText"]
            )
        )

    # Daily engagement timeline (last 30 days)
    daily_days = sorted(
        set(metrics.timeline.daily_conversations.keys())
        | set(metrics.timeline.daily_messages.keys())
        | set(metrics.timeline.daily_duration.keys())
    )
    if daily_days:
        story.append(Spacer(1, 20))
        story.append(Paragraph("Daily Engagement (last 30 days)", styles["SectionTitle"]))

        recent_days = daily_days[-30:]
        conv_series = [metrics.timeline.daily_conversations.get(day, 0) for day in recent_days]
        msg_series = [metrics.timeline.daily_messages.get(day, 0) for day in recent_days]
        avg_duration_mins = []
        for day in recent_days:
            conv_count = metrics.timeline.daily_conversations.get(day, 0)
            duration = metrics.timeline.daily_duration.get(day, 0)
            if conv_count:
                avg_duration_mins.append((duration / conv_count) / 60)
            else:
                avg_duration_mins.append(0)

        labels = [day.strftime("%b %d") for day in recent_days]

        plt, np = _load_chart_libs()
        if plt and np:
            x = np.arange(len(recent_days))
            fig, ax = plt.subplots(figsize=(7.2, 3.0))
            ax.bar(
                x - 0.15, conv_series, width=0.3, color="#667eea", alpha=0.85, label="Conversations"
            )
            ax.plot(x, msg_series, color="#4ecdc4", linewidth=2, marker="o", label="Chat messages")
            ax.set_ylabel("Count", fontsize=9)
            ax.set_xticks(x)
            ax.set_xticklabels(labels, rotation=35, ha="right", fontsize=8)

            ax2 = ax.twinx()
            ax2.plot(
                x,
                avg_duration_mins,
                color="#f5576c",
                linewidth=2,
                marker="s",
                label="Avg duration (min)",
            )
            ax2.set_ylabel("Avg duration (minutes)", fontsize=9, color="#f5576c")
            ax2.tick_params(axis="y", labelcolor="#f5576c")

            lines1, labels1 = ax.get_legend_handles_labels()
            lines2, labels2 = ax2.get_legend_handles_labels()
            ax.legend(lines1 + lines2, labels1 + labels2, loc="upper left", fontsize=7)

            fig.tight_layout()
            plt.subplots_adjust(left=0.12, right=0.95, top=0.9, bottom=0.28)

            buffer_daily = io.BytesIO()
            plt.savefig(buffer_daily, format="png", dpi=150, bbox_inches="tight")
            buffer_daily.seek(0)
            plt.close(fig)

            story.append(Image(buffer_daily, width=6.5 * inch, height=3.0 * inch))
            story.append(Spacer(1, 8))
            story.append(
                Paragraph(
                    "Bars show daily conversation counts, teal line shows chat volume, and the red squares show average conversation duration for that day.",
                    styles["SmallText"],
                )
            )
        else:
            story.append(
                Paragraph("Daily engagement chart requires matplotlib.", styles["BodyText"])
            )

    # ========================================
    # PAGE 3: DETAILED ANALYTICS
    # ========================================
    story.append(PageBreak())

    story.append(Paragraph("Detailed Analytics", styles["ReportTitle"]))
    story.append(Spacer(1, 16))

    # Conversation Analytics
    story.append(Paragraph("Conversation Analytics", styles["SectionTitle"]))

    conv_rows = [
        ["Total Conversations", str(metrics.audio.total_conversations)],
        ["Total Duration", metrics.audio.total_duration_formatted],
        ["Average Duration", metrics.audio.avg_duration_formatted],
        ["Median Duration (P50)", metrics.audio.p50_duration_formatted],
        ["90th Percentile (P90)", metrics.audio.p90_duration_formatted],
    ]

    story.append(_create_data_table(["Metric", "Value"], conv_rows, [4.5 * inch, 2 * inch]))
    if metrics.audio.total_conversations > 0:
        story.append(
            Paragraph(
                f"Average duration ({metrics.audio.avg_duration_formatted}) sits between the median {metrics.audio.p50_duration_formatted} and the 90th percentile {metrics.audio.p90_duration_formatted}, highlighting both typical calls and the long tail of deeper sessions.",
                styles["SmallText"],
            )
        )
    story.append(Spacer(1, 16))

    # Chat Analytics
    if metrics.chat.total_chats > 0:
        story.append(Paragraph("Chat Analytics", styles["SectionTitle"]))

        queries_per_session = (
            metrics.chat.user_messages / metrics.chat.total_chats
            if metrics.chat.total_chats > 0
            else 0
        )

        chat_rows = [
            ["Chat Sessions", str(metrics.chat.total_chats)],
            ["Total Messages", str(metrics.chat.total_messages)],
            ["User Queries", str(metrics.chat.user_messages)],
            ["Queries per Session", f"{queries_per_session:.1f}"],
            ["Avg Messages/Session", f"{metrics.chat.avg_messages_per_chat:.1f}"],
            ["Median Messages (P50)", f"{metrics.chat.p50_messages_per_chat:.0f}"],
            ["90th Percentile (P90)", f"{metrics.chat.p90_messages_per_chat:.0f}"],
        ]

        story.append(_create_data_table(["Metric", "Value"], chat_rows, [4.5 * inch, 2 * inch]))
        story.append(
            Paragraph(
                "Percentile views (P50/P90) make it easier to benchmark individual chats against the broader distribution even without platform-wide averages.",
                styles["SmallText"],
            )
        )
        story.append(Spacer(1, 12))

        # Top Query Keywords
        if metrics.chat.top_query_words:
            story.append(Paragraph("Top Query Keywords", styles["SubSection"]))
            keywords_text = _format_keywords(metrics.chat.top_query_words, limit=20)
            story.append(Paragraph(keywords_text, styles["KeywordTag"]))
            story.append(Spacer(1, 16))

    # Login Activity
    story.append(Paragraph("Login Activity", styles["SectionTitle"]))
    login_rows = [
        ["Total Logins", str(metrics.logins.total_logins)],
        ["Active Days", str(metrics.logins.unique_days)],
        ["Unique Users", str(metrics.logins.unique_users)],
        ["Avg / Active Day", f"{metrics.logins.avg_logins_per_active_day:.1f}"],
        ["Avg / User", f"{metrics.logins.avg_logins_per_user:.1f}"],
        [
            "Last Login",
            metrics.logins.last_login.strftime("%b %d, %Y %H:%M")
            if metrics.logins.last_login
            else "—",
        ],
    ]
    story.append(_create_data_table(["Metric", "Value"], login_rows, [4.5 * inch, 2 * inch]))

    if metrics.logins.total_logins == 0:
        story.append(Paragraph("No login events were recorded in this period.", styles["BodyText"]))
    else:
        login_days = sorted(metrics.logins.daily_logins.keys())
        if login_days:
            recent_days = login_days[-30:] if len(login_days) > 30 else login_days
            totals = [metrics.logins.daily_logins[d] for d in recent_days]
            unique_counts = []
            for day in recent_days:
                active = sum(
                    1 for counts in metrics.logins.daily_logins_by_user.values() if counts.get(day)
                )
                unique_counts.append(active)

            plt, np = _load_chart_libs()
            if plt and np:
                x = np.arange(len(recent_days))
                fig, ax = plt.subplots(figsize=(7.0, 2.8))
                ax.bar(x, totals, color="#667eea", alpha=0.85, label="Logins")
                ax.set_ylabel("Logins", fontsize=9)
                ax.set_xticks(x)
                ax.set_xticklabels(
                    [d.strftime("%b %d") for d in recent_days], rotation=35, ha="right", fontsize=8
                )

                ax2 = ax.twinx()
                ax2.plot(
                    x, unique_counts, color="#4ecdc4", linewidth=2, marker="o", label="Unique users"
                )
                ax2.set_ylabel("Unique users", fontsize=9, color="#4ecdc4")
                ax2.tick_params(axis="y", labelcolor="#4ecdc4")

                handles1, labels1 = ax.get_legend_handles_labels()
                handles2, labels2 = ax2.get_legend_handles_labels()
                ax.legend(handles1 + handles2, labels1 + labels2, loc="upper left", fontsize=7)

                fig.tight_layout()
                plt.subplots_adjust(left=0.12, right=0.94, top=0.9, bottom=0.35)

                login_buffer = io.BytesIO()
                plt.savefig(login_buffer, format="png", dpi=150, bbox_inches="tight")
                login_buffer.seek(0)
                plt.close(fig)

                story.append(Image(login_buffer, width=6.4 * inch, height=2.8 * inch))
                story.append(Spacer(1, 8))
                story.append(
                    Paragraph(
                        "Bars represent total logins per day (last 30 days); teal line shows how many distinct users logged in per day.",
                        styles["SmallText"],
                    )
                )
            else:
                story.append(Paragraph("Login chart requires matplotlib.", styles["BodyText"]))

        if metrics.logins.logins_by_user:
            user_lookup = {u.id: u.display_name for u in users}
            top_users = sorted(
                metrics.logins.logins_by_user.items(), key=lambda item: item[1], reverse=True
            )[:5]
            user_rows = [
                [user_lookup.get(user_id, user_id), str(count)] for user_id, count in top_users
            ]
            story.append(
                _create_data_table(["Top Users", "Logins"], user_rows, [4.5 * inch, 2 * inch])
            )
    story.append(Spacer(1, 16))

    # Project Summary
    story.append(Paragraph("Project Summary", styles["SectionTitle"]))

    project_rows = [
        ["Total Projects", str(metrics.projects.total_projects)],
        ["Active Projects", str(metrics.projects.active_projects)],
        ["Avg Conversations/Project", f"{metrics.projects.avg_conversations_per_project:.1f}"],
    ]

    story.append(_create_data_table(["Metric", "Value"], project_rows, [4.5 * inch, 2 * inch]))
    if metrics.audio.total_conversations > 0 and metrics.chat.total_chats > 0:
        follow_up_ratio = metrics.chat.total_chats / metrics.audio.total_conversations
        story.append(
            Paragraph(
                f"Follow-up cadence: {follow_up_ratio:.2f} chat sessions per recorded conversation, which can indicate how often teams continue analysis in chat after live work.",
                styles["SmallText"],
            )
        )
    story.append(Spacer(1, 16))

    # Detailed project breakdown
    project_breakdown = _build_project_usage_breakdown(usage_data)
    if project_breakdown:
        story.append(Paragraph("Project Usage Breakdown", styles["SectionTitle"]))
        rows = []
        for item in project_breakdown[:10]:
            hours = item["duration"] / 3600 if item["duration"] else 0
            rows.append(
                [
                    item["project_name"],
                    item["owner"],
                    f"{hours:.1f} h",
                    str(item["conversations"]),
                    str(item["chat_sessions"]),
                ]
            )
        story.append(
            _create_data_table(
                ["Project", "Owner", "Hours", "Conversations", "Chat Sessions"],
                rows,
                [2.8 * inch, 1.5 * inch, 1 * inch, 1 * inch, 1.2 * inch],
            )
        )
        story.append(Spacer(1, 16))

    # Report Summary
    story.append(Paragraph("Report Activity", styles["SectionTitle"]))
    draft_reports = max(
        0,
        metrics.reports.total_reports
        - metrics.reports.published_reports
        - metrics.reports.error_reports,
    )
    report_rows = [
        ["Reports Generated", str(metrics.reports.total_reports)],
        ["Published", str(metrics.reports.published_reports)],
        ["Draft / Unpublished", str(draft_reports)],
        ["Errors", str(metrics.reports.error_reports)],
    ]
    story.append(_create_data_table(["Status", "Count"], report_rows, [4.5 * inch, 2 * inch]))
    story.append(Spacer(1, 16))

    # Activity Timeline Summary (if available)
    if metrics.first_activity or metrics.last_activity:
        story.append(Paragraph("Activity Timeline", styles["SectionTitle"]))

        timeline_rows = []
        if metrics.first_activity:
            timeline_rows.append(["First Activity", metrics.first_activity.strftime("%b %d, %Y")])
        if metrics.last_activity:
            timeline_rows.append(["Last Activity", metrics.last_activity.strftime("%b %d, %Y")])
        if metrics.days_since_last_activity is not None:
            if metrics.days_since_last_activity == 0:
                days_text = "Today"
            elif metrics.days_since_last_activity == 1:
                days_text = "Yesterday"
            else:
                days_text = f"{metrics.days_since_last_activity} days ago"
            timeline_rows.append(["Days Since Last Activity", days_text])

        if timeline_rows:
            story.append(
                _create_data_table(["Metric", "Value"], timeline_rows, [4.5 * inch, 2 * inch])
            )
            story.append(Spacer(1, 16))

    # Data quality notes help readers interpret metrics responsibly
    story.append(Paragraph("Data Quality Notes", styles["SectionTitle"]))
    data_notes = [
        "Conversation duration falls back to transcript word-count estimates or 30 seconds per chunk when raw duration is missing; the report always uses the higher estimate to avoid under-reporting.",
        "Empty conversations are counted when Directus flags `has_content=False`, so spikes may reflect test recordings rather than user-facing work.",
        "Chat percentiles are computed across all captured sessions; platform-wide benchmarks are not yet available, so use these as internal context rather than external comparisons.",
    ]
    for note in data_notes:
        story.append(Paragraph(f"• {note}", styles["BodyText"]))
    story.append(Spacer(1, 12))

    # AI Insights (if available)
    if insights:
        story.append(PageBreak())
        story.append(Paragraph("AI-Generated Insights", styles["SectionTitle"]))
        insights_clean = _markdown_to_plain_text(insights)
        story.append(Paragraph(insights_clean, styles["BodyText"]))

    # Footer
    story.append(Spacer(1, 30))
    story.append(
        HRFlowable(
            width="100%", thickness=0.5, color=COLORS["border"], spaceBefore=10, spaceAfter=10
        )
    )
    story.append(
        Paragraph(
            f"Generated by ECHO Usage Tracker · {date.today().strftime('%Y-%m-%d')}",
            styles["Footer"],
        )
    )

    # Build PDF
    doc.build(story)

    buffer.seek(0)
    return buffer.getvalue()
