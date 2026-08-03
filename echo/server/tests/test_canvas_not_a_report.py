"""A canvas is a project_report row with kind='canvas'.

Every endpoint that means "reports" must say so, or canvases leak into the
host's report list, become the project's "latest report", and shadow the
published report the participant portal serves. See the note in
dembrane/api/agentic.py, which filtered `kind` correctly from the start.
"""

from unittest.mock import Mock, AsyncMock, patch

import pytest


def _capturing_directus(captured: dict, rows: list | None = None):
    """A stand-in for the sync `directus` client that records the filter of
    each get_items call against project_report."""
    client = Mock()

    def _get_items(collection, params=None, *a, **k):
        if collection == "project_report":
            captured.setdefault("filters", []).append(
                (params or {}).get("query", {}).get("filter")
            )
        return list(rows or [])

    client.get_items = Mock(side_effect=_get_items)
    return client


REPORT_KIND = {"_eq": "report"}


class TestParticipantPortal:
    """These two are unauthenticated. A canvas is created status='published'
    and is newer than the host's real report, so without the kind filter the
    portal serves participants a blank page in place of the actual report."""

    @pytest.mark.asyncio
    async def test_public_latest_asks_for_a_report(self):
        from dembrane.api.participant import get_public_report_latest

        captured: dict = {}
        with patch(
            "dembrane.api.participant.directus", _capturing_directus(captured)
        ):
            assert await get_public_report_latest("proj-1") is None
        assert captured["filters"][0].get("kind") == REPORT_KIND

    @pytest.mark.asyncio
    async def test_public_detail_asks_for_a_report(self):
        from fastapi import HTTPException

        from dembrane.api.participant import get_public_report_detail

        captured: dict = {}
        with patch(
            "dembrane.api.participant.directus", _capturing_directus(captured)
        ), pytest.raises(HTTPException):
            await get_public_report_detail("proj-1", 7)
        assert captured["filters"][0].get("kind") == REPORT_KIND


class TestHostReportList:
    """The host's Reports sidebar renders a title-less canvas as "Untitled
    report", and because it sorts newest-first the canvas can become the
    selected report and blank the main pane."""

    @pytest.mark.asyncio
    async def test_list_project_reports_asks_for_reports(self):
        from dembrane.api.project import list_project_reports

        captured: dict = {}
        with patch(
            "dembrane.api.project._verify_project_access", AsyncMock(return_value={})
        ), patch("dembrane.directus.directus", _capturing_directus(captured)):
            assert await list_project_reports("proj-1", auth=Mock()) == []
        assert captured["filters"][0].get("kind") == REPORT_KIND

    @pytest.mark.asyncio
    async def test_latest_report_asks_for_a_report(self):
        from dembrane.api.project import get_latest_report

        captured: dict = {}
        with patch(
            "dembrane.api.project._verify_project_access", AsyncMock(return_value={})
        ), patch("dembrane.directus.directus", _capturing_directus(captured)):
            assert await get_latest_report("proj-1", auth=Mock()) is None
        assert captured["filters"][0].get("kind") == REPORT_KIND


class TestBffReportList:
    @pytest.mark.asyncio
    async def test_bff_list_reports_asks_for_reports(self):
        from dembrane.api.v2.bff.reports import list_reports

        captured: dict = {}

        async def _get_items(collection, params=None, *a, **k):
            captured["filter"] = (params or {}).get("query", {}).get("filter")
            return []

        async_client = AsyncMock()
        async_client.get_items = AsyncMock(side_effect=_get_items)

        access = Mock()
        access.require = Mock(return_value=None)

        with patch(
            "dembrane.api.v2.bff.reports.resolve_project_access",
            AsyncMock(return_value=access),
        ), patch("dembrane.api.v2.bff.reports.async_directus", async_client):
            # fields/limit are passed explicitly: calling the endpoint function
            # directly skips FastAPI's Query default resolution.
            assert (
                await list_reports(
                    auth=Mock(), project_id="proj-1", fields=None, limit=1000
                )
                == []
            )
        assert captured["filter"].get("kind") == REPORT_KIND
