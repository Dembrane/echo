"""
Reusable email sending via SendGrid.

Works both sync (Dramatiq tasks) and async (FastAPI endpoints).
Uses the SendGrid API (not SMTP) for reliability.

Usage:

    # Async (in FastAPI endpoints)
    from dembrane.email import send_email
    await send_email(
        to="user@example.com",
        subject="Welcome",
        html="<h1>Hello</h1>",
    )

    # Sync (in Dramatiq tasks)
    from dembrane.email import send_email_sync
    send_email_sync(
        to="user@example.com",
        subject="Welcome",
        html="<h1>Hello</h1>",
    )

    # Templated email
    from dembrane.email import send_email
    await send_email(
        to="user@example.com",
        subject="You're invited",
        template="workspace_invite",
        template_data={"workspace_name": "Acme", "inviter_name": "Sam", "invite_url": "..."},
    )
"""

from __future__ import annotations

from logging import getLogger
from pathlib import Path
from typing import Optional

import jinja2
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail, Email, To, Content

from dembrane.settings import get_settings

logger = getLogger("dembrane.email")

# Template directory
TEMPLATE_DIR = Path(__file__).parent.parent / "email_templates"

# Jinja2 environment for email templates
_jinja_env: Optional[jinja2.Environment] = None


def _get_jinja_env() -> jinja2.Environment:
    global _jinja_env
    if _jinja_env is None:
        _jinja_env = jinja2.Environment(
            loader=jinja2.FileSystemLoader(str(TEMPLATE_DIR)),
            autoescape=True,
        )
    return _jinja_env


def _render_template(template_name: str, data: dict) -> str:
    """Render an email template. Falls back to empty string if template missing."""
    try:
        env = _get_jinja_env()
        template = env.get_template(f"{template_name}.html")
        return template.render(**data)
    except jinja2.TemplateNotFound:
        logger.error(f"Email template not found: {template_name}")
        raise
    except Exception:
        logger.exception(f"Failed to render email template: {template_name}")
        raise


def _render_plain_text_template(template_name: str, data: dict) -> Optional[str]:
    """Render a plain-text fallback for a named template.

    Conventions: a template "foo" can have an adjacent "foo.txt" with the
    same variables. Missing .txt is fine — we just skip the multipart
    alternative in that case.
    """
    try:
        env = _get_jinja_env()
        template = env.get_template(f"{template_name}.txt")
        return template.render(**data)
    except jinja2.TemplateNotFound:
        return None
    except Exception:
        logger.exception(f"Failed to render plain-text template: {template_name}")
        return None


def _build_message(
    to: str | list[str],
    subject: str,
    html: str | None = None,
    plain_text: str | None = None,
    template: str | None = None,
    template_data: dict | None = None,
    from_email: str | None = None,
    from_name: str | None = None,
) -> Mail:
    """Build a SendGrid Mail object."""
    settings = get_settings()

    sender = Email(
        email=from_email or settings.email.from_email,
        name=from_name or settings.email.from_name,
    )

    recipients = [To(addr) for addr in (to if isinstance(to, list) else [to])]

    # Resolve content
    if template:
        html = _render_template(template, template_data or {})
        # Auto-pick up a plain-text fallback when one exists alongside the
        # HTML template — better deliverability (reduces spam score) and
        # works in mail clients that prefer text.
        if plain_text is None:
            plain_text = _render_plain_text_template(template, template_data or {})

    if not html and not plain_text:
        raise ValueError("Either html, plain_text, or template must be provided")

    message = Mail()
    message.from_email = sender
    message.subject = subject
    message.to = recipients

    # SendGrid expects multipart/alternative as text/plain first, then html.
    # Use add_content() (not direct .content assignment) so multiple parts
    # are accepted.
    if plain_text:
        message.add_content(Content("text/plain", plain_text))
    if html:
        message.add_content(Content("text/html", html))

    return message


def send_email_sync(
    to: str | list[str],
    subject: str,
    html: str | None = None,
    plain_text: str | None = None,
    template: str | None = None,
    template_data: dict | None = None,
    from_email: str | None = None,
    from_name: str | None = None,
) -> bool:
    """Send email synchronously. For use in Dramatiq tasks.

    Returns True on success, False on failure (never raises).
    """
    settings = get_settings()
    api_key = settings.email.sendgrid_api_key

    if not api_key:
        logger.warning("SendGrid API key not configured, skipping email send")
        return False

    try:
        message = _build_message(
            to=to,
            subject=subject,
            html=html,
            plain_text=plain_text,
            template=template,
            template_data=template_data,
            from_email=from_email,
            from_name=from_name,
        )

        sg = SendGridAPIClient(api_key)
        response = sg.send(message)

        if response.status_code >= 400:
            logger.error(
                f"SendGrid error {response.status_code}: {response.body}"
            )
            return False

        logger.info(f"Email sent to {to}: {subject} (status: {response.status_code})")
        return True

    except Exception:
        logger.exception(f"Failed to send email to {to}: {subject}")
        return False


async def send_email(
    to: str | list[str],
    subject: str,
    html: str | None = None,
    plain_text: str | None = None,
    template: str | None = None,
    template_data: dict | None = None,
    from_email: str | None = None,
    from_name: str | None = None,
) -> bool:
    """Send email asynchronously. For use in FastAPI endpoints.

    Runs the sync SendGrid call in a thread pool to avoid blocking.
    Returns True on success, False on failure (never raises).
    """
    from dembrane.async_helpers import run_in_thread_pool

    return await run_in_thread_pool(
        send_email_sync,
        to=to,
        subject=subject,
        html=html,
        plain_text=plain_text,
        template=template,
        template_data=template_data,
        from_email=from_email,
        from_name=from_name,
    )
