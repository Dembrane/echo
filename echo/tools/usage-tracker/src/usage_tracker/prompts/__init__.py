"""Prompt management utilities with Jinja2 templating."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader

TEMPLATE_DIR = Path(__file__).resolve().parent

PLATFORM_SUMMARY = """Dembrane ECHO: Platform Context

What It Is
----------
A conversation intelligence platform that transforms group discussions into actionable insights, built for democratic stakeholder engagement at scale.

How It Works
------------
For Hosts (Dashboard):
- Create projects and generate QR codes
- Participants scan codes to record conversations instantly (no app needed)
- Use AI chat interface to analyze incoming conversation data
- Generate reports showing themes, tensions, and key insights grounded in actual quotes

For Participants (Portal):
- Scan QR → record in 2 clicks
- Works on any device, 50+ languages
- WCAG compliant, no downloads required

Core Technology:
- Auto-transcription with WhisperX
- AI clustering to identify themes and patterns
- Quote-based analysis (community voices, not AI summaries)
- Scales from single meetings to thousands of async conversations
- ISO27001 compliant, GDPR-ready

Usage Characteristics (Critical for Analytics)
----------------------------------------------
ECHO is event-driven, not daily-use software. Users run discrete engagement sessions:
workshops, consultations, civic forums, employee feedback rounds.

Typical pattern: Prepare event → Run session → Analyze conversations → Generate report → Return for next event

What this means for interpreting metrics:
- Monthly login cadence (1-2x/month) is healthy and expected, not a retention problem
- "Burst usage" (intensive sessions with gaps) is normal and good
- Longer conversation recordings (30+ min) indicate substantial discussions being captured
- Gaps between activity often mean "between engagement cycles" not "churning"
- Compare to event-driven benchmarks, not daily SaaS metrics

Key Metrics:
- Projects = engagement initiatives/events created by hosts
- Conversations = individual recorded dialogues being analyzed
- Chat sessions = time spent in the AI analysis interface
- Reports = generated outputs for stakeholders
- Logins = return visits to the dashboard

User Types:
- Dashboard users (hosts/organizers) = the people we track in analytics
- Participants (people recording conversations) = not tracked individually
"""

STYLE_GUIDANCE = """Writing Style Guidance
---------------------
Write like you're explaining data to a teammate, not presenting to a board.

DO:
- Use natural language: "This user analyzed 18 conversations" 
- Be direct about what happened, what it means, what to watch
- Interpret metrics in context of ECHO's event-driven usage
- Flag uncertainty honestly: "suggests" / "likely" / "may indicate"
- Match depth to purpose (glanceable vs detailed)

DON'T:
- Use MBA-speak: "high-propensity engagement cohort"
- Treat monthly logins as a churn signal (they're normal for ECHO)
- Over-explain obvious trends
- Hedge with corporate language
- Mix user-level and org-level metrics inconsistently

Structure narratives as:
1. What happened (facts with numbers)
2. What it means (interpretation in ECHO context)
3. What to watch (flags or follow-ups)
"""

env = Environment(
    loader=FileSystemLoader(str(TEMPLATE_DIR)),
    autoescape=False,
    trim_blocks=True,
    lstrip_blocks=True,
)
env.globals["platform_summary"] = PLATFORM_SUMMARY
env.globals["style_guidance"] = STYLE_GUIDANCE


def render_prompt(template_name: str, **context: Any) -> str:
    """Render a Jinja2 prompt template with shared context."""
    template = env.get_template(template_name)
    return template.render(**context)
