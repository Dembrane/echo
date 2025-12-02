"""PDF export functionality for usage reports."""

from __future__ import annotations

import io
import re
import logging
from datetime import date
from typing import List, Optional

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
    Image,
)
from reportlab.lib.enums import TA_CENTER, TA_LEFT

from .data_fetcher import UserInfo, DateRange
from .metrics import UsageMetrics, format_duration

logger = logging.getLogger(__name__)


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
    # Fix unclosed bold tags like <b>text<b> -> <b>text</b>
    result = re.sub(r"<b>([^<]*)<b>", r"<b>\1</b>", result)

    # Remove any remaining unclosed tags
    result = re.sub(r"<b>([^<]*)$", r"\1", result)

    # Escape special characters that could break XML
    result = result.replace("&", "&amp;")
    result = result.replace("<br/>", "\n<BR/>")  # Protect line breaks
    result = result.replace("&amp;", "&")  # Restore ampersands
    result = result.replace("\n<BR/>", "<br/>")  # Restore line breaks

    return result


def _create_styles():
    """Create custom paragraph styles."""
    styles = getSampleStyleSheet()

    styles.add(
        ParagraphStyle(
            "ReportTitle",
            parent=styles["Heading1"],
            fontSize=24,
            spaceAfter=30,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#1a1a2e"),
        )
    )

    styles.add(
        ParagraphStyle(
            "SectionTitle",
            parent=styles["Heading2"],
            fontSize=14,
            spaceBefore=20,
            spaceAfter=10,
            textColor=colors.HexColor("#16213e"),
        )
    )

    styles.add(
        ParagraphStyle(
            "SubSection",
            parent=styles["Heading3"],
            fontSize=12,
            spaceBefore=15,
            spaceAfter=8,
            textColor=colors.HexColor("#0f3460"),
        )
    )

    # Override existing BodyText style
    styles["BodyText"].fontSize = 10
    styles["BodyText"].spaceBefore = 6
    styles["BodyText"].spaceAfter = 6
    styles["BodyText"].leading = 14

    styles.add(
        ParagraphStyle(
            "MetricLabel",
            parent=styles["Normal"],
            fontSize=9,
            textColor=colors.HexColor("#666666"),
        )
    )

    styles.add(
        ParagraphStyle(
            "MetricValue",
            parent=styles["Normal"],
            fontSize=14,
            fontName="Helvetica-Bold",
            textColor=colors.HexColor("#1a1a2e"),
        )
    )

    styles.add(
        ParagraphStyle(
            "Footer",
            parent=styles["Normal"],
            fontSize=8,
            textColor=colors.HexColor("#999999"),
            alignment=TA_CENTER,
        )
    )

    return styles


def _create_metric_box(label: str, value: str, styles) -> Table:
    """Create a metric display box."""
    data = [
        [Paragraph(value, styles["MetricValue"])],
        [Paragraph(label, styles["MetricLabel"])],
    ]

    table = Table(data, colWidths=[2.5 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8f9fa")),
                ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#e9ecef")),
                ("TOPPADDING", (0, 0), (-1, -1), 10),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
                ("LEFTPADDING", (0, 0), (-1, -1), 15),
                ("RIGHTPADDING", (0, 0), (-1, -1), 15),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    return table


def generate_pdf_report(
    users: List[UserInfo],
    metrics: UsageMetrics,
    date_range: Optional[DateRange] = None,
    executive_summary: Optional[str] = None,
    insights: Optional[str] = None,
) -> bytes:
    """
    Generate a PDF usage report.

    Returns the PDF as bytes.
    """
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=1.5 * cm,
        leftMargin=1.5 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
    )

    styles = _create_styles()
    story = []

    # Title
    story.append(Paragraph("Usage Report", styles["ReportTitle"]))

    # Date range
    if date_range:
        date_text = (
            f"{date_range.start.strftime('%B %d, %Y')} - {date_range.end.strftime('%B %d, %Y')}"
        )
    else:
        date_text = f"Generated on {date.today().strftime('%B %d, %Y')}"
    story.append(Paragraph(date_text, styles["BodyText"]))

    # Users
    user_names = ", ".join(u.display_name for u in users[:10])
    if len(users) > 10:
        user_names += f" (+{len(users) - 10} more)"
    story.append(Paragraph(f"<b>Users:</b> {user_names}", styles["BodyText"]))

    story.append(Spacer(1, 20))

    # Executive Summary
    if executive_summary:
        story.append(Paragraph("Executive Summary", styles["SectionTitle"]))
        # Handle markdown-style formatting
        summary_text = executive_summary.replace("\n\n", "<br/><br/>")
        story.append(Paragraph(summary_text, styles["BodyText"]))
        story.append(Spacer(1, 20))

    # Key Metrics Section
    story.append(Paragraph("Key Metrics", styles["SectionTitle"]))

    # Create metrics grid
    metrics_data = [
        [
            _create_metric_box("Total Projects", str(metrics.projects.total_projects), styles),
            _create_metric_box(
                "Total Conversations",
                str(metrics.audio.total_conversations),
                styles,
            ),
            _create_metric_box(
                "Audio Duration",
                metrics.audio.total_duration_formatted,
                styles,
            ),
        ],
        [
            _create_metric_box("Chat Sessions", str(metrics.chat.total_chats), styles),
            _create_metric_box("Total Messages", str(metrics.chat.total_messages), styles),
            _create_metric_box(
                "Reports Generated",
                str(metrics.reports.total_reports),
                styles,
            ),
        ],
    ]

    metrics_table = Table(
        metrics_data,
        colWidths=[2.7 * inch, 2.7 * inch, 2.7 * inch],
        rowHeights=[1.2 * inch, 1.2 * inch],
    )
    metrics_table.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.append(metrics_table)
    story.append(Spacer(1, 20))

    # Audio/Conversation Details
    story.append(Paragraph("Conversation Analytics", styles["SectionTitle"]))

    conv_data = [
        ["Metric", "Value"],
        ["Total Conversations", str(metrics.audio.total_conversations)],
        ["Total Duration", metrics.audio.total_duration_formatted],
        ["Average Duration", metrics.audio.avg_duration_formatted],
    ]

    conv_table = Table(conv_data, colWidths=[4 * inch, 2 * inch])
    conv_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a1a2e")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e9ecef")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8f9fa")]),
            ]
        )
    )
    story.append(conv_table)
    story.append(Spacer(1, 20))

    # Chat Details
    if metrics.chat.total_chats > 0:
        story.append(Paragraph("Chat Analytics", styles["SectionTitle"]))

        chat_data = [
            ["Metric", "Value"],
            ["Chat Sessions", str(metrics.chat.total_chats)],
            ["Total Messages", str(metrics.chat.total_messages)],
            ["User Messages", str(metrics.chat.user_messages)],
            ["Avg Messages/Chat", f"{metrics.chat.avg_messages_per_chat:.1f}"],
        ]

        chat_table = Table(chat_data, colWidths=[4 * inch, 2 * inch])
        chat_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a1a2e")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                    ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 10),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                    ("LEFTPADDING", (0, 0), (-1, -1), 10),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e9ecef")),
                    (
                        "ROWBACKGROUNDS",
                        (0, 1),
                        (-1, -1),
                        [colors.white, colors.HexColor("#f8f9fa")],
                    ),
                ]
            )
        )
        story.append(chat_table)
        story.append(Spacer(1, 20))

    # Feature Adoption
    story.append(Paragraph("Feature Adoption", styles["SectionTitle"]))

    adoption_data = [
        ["Feature", "Status"],
        [
            "Conversations",
            "✓ Active" if metrics.adoption.uses_conversations else "✗ Not Used",
        ],
        ["Chat", "✓ Active" if metrics.adoption.uses_chat else "✗ Not Used"],
        [
            "Reports",
            "✓ Active" if metrics.adoption.uses_reports else "✗ Not Used",
        ],
    ]

    adoption_table = Table(adoption_data, colWidths=[4 * inch, 2 * inch])
    adoption_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a1a2e")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("ALIGN", (1, 0), (1, -1), "CENTER"),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e9ecef")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8f9fa")]),
            ]
        )
    )
    story.append(adoption_table)

    # AI Insights (if available)
    if insights:
        story.append(PageBreak())
        story.append(Paragraph("AI-Generated Insights", styles["SectionTitle"]))

        # Convert markdown to plain text (safest for ReportLab)
        insights_clean = _markdown_to_plain_text(insights)
        story.append(Paragraph(insights_clean, styles["BodyText"]))

    # Footer
    story.append(Spacer(1, 40))
    story.append(
        Paragraph(
            f"Generated by Dembrane ECHO Usage Tracker • {date.today().strftime('%Y-%m-%d')}",
            styles["Footer"],
        )
    )

    # Build PDF
    doc.build(story)

    buffer.seek(0)
    return buffer.getvalue()
