"""Postgres-level invariants for org_invite (ADR 0004).

Directus-sync (`bash sync.sh push`) does not manage partial unique
indexes, CHECK constraints, or column defaults. Those live in
`scripts/add_org_invite_collection.py` and must be applied per
environment. This test guards against a deploy that runs `sync.sh push`
without re-running the migration script — the kind of silent gap the
retrofit checklist (docs/issues/unified-invite-modal/README.md) was
written to catch.

Skipped when DATABASE_URL is not set, so local dev shells without a
postgres connection don't fail. CI runs against a real database, so the
guard fires there.
"""

from __future__ import annotations

import os

import pytest


def _db_or_skip():
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        pytest.skip("DATABASE_URL not set; skipping postgres schema invariants")
    try:
        import psycopg  # noqa: F401
    except ImportError:
        pytest.skip("psycopg not installed; skipping postgres schema invariants")
    if db_url.startswith("postgresql+psycopg://"):
        db_url = db_url.replace("postgresql+psycopg://", "postgresql://", 1)
    return db_url


def test_org_invite_partial_unique_index_exists() -> None:
    db_url = _db_or_skip()
    import psycopg

    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT indexdef FROM pg_indexes "
                "WHERE schemaname = 'public' AND tablename = 'org_invite' "
                "AND indexname = 'org_invite_pending_unique';"
            )
            row = cur.fetchone()

    assert row is not None, (
        "org_invite_pending_unique partial index missing. Apply by running "
        "scripts/add_org_invite_collection.py with DATABASE_URL set against "
        "this environment, per docs/database_migrations.md."
    )
    indexdef = row[0]
    # Loose match — exact whitespace varies by Postgres version.
    assert "UNIQUE" in indexdef.upper()
    assert "org_id" in indexdef
    assert "lower(email)" in indexdef.lower()
    assert "accepted_at IS NULL" in indexdef
    assert "deleted_at IS NULL" in indexdef


def test_org_invite_email_lowercase_check_exists() -> None:
    db_url = _db_or_skip()
    import psycopg

    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT conname FROM pg_constraint "
                "WHERE conrelid = 'org_invite'::regclass "
                "AND conname = 'org_invite_email_lower';"
            )
            row = cur.fetchone()

    assert row is not None, (
        "org_invite_email_lower CHECK missing. Run "
        "scripts/add_org_invite_collection.py with DATABASE_URL set."
    )


def test_org_invite_expires_at_has_default() -> None:
    db_url = _db_or_skip()
    import psycopg

    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'org_invite' "
                "AND column_name = 'expires_at';"
            )
            row = cur.fetchone()

    assert row is not None, "org_invite.expires_at column missing entirely"
    column_default = row[0]
    assert column_default, (
        "org_invite.expires_at has no DB default. The plan §1a contract "
        "is `default now() + interval '7 days'`. Run "
        "scripts/add_org_invite_collection.py with DATABASE_URL set."
    )
    # Loose check — Postgres normalises the expression.
    assert "7 days" in column_default or "interval" in column_default.lower()
