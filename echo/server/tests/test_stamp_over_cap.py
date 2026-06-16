"""Tests for _stamp_over_cap integration logic in tasks.py.

Verifies the wiring between the conversation finish hook and the
is_over_cap stamp, using mocked Directus calls.
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest

from dembrane.tasks import _stamp_over_cap


@pytest.fixture
def mock_logger():
    return logging.getLogger("test_stamp_over_cap")


def _make_conversation(
    conversation_id: str = "conv-1",
    project_id: str = "proj-1",
    duration: int = 1080,  # 0.3 hours in seconds
) -> dict:
    return {
        "id": conversation_id,
        "project_id": project_id,
        "duration": duration,
        "is_over_cap": False,
    }


def _make_project(project_id: str = "proj-1", workspace_id: str = "ws-1") -> dict:
    return {"id": project_id, "workspace_id": workspace_id}


def _make_workspace(workspace_id: str = "ws-1", _tier: str = "free") -> dict:
    return {"id": workspace_id, "billing_account_id": "acc-1"}


def _get_item_for(tier: str, workspace_id: str = "ws-1"):
    """Sync get_item side-effect: tier now lives on the billing account."""

    def _side(collection, item_id, *_args, **_kwargs):
        if collection == "billing_account":
            return {"id": item_id, "tier": tier}
        return _make_workspace(workspace_id)

    return _side


def _setup_mocks(mock_conv_svc, mock_proj_svc, _mock_directus, conversation, project, workspace, all_projects, all_conversations):
    """Wire up the mocked services and Directus client for _stamp_over_cap."""
    mock_conv_svc.get_by_id_or_raise.return_value = conversation
    mock_proj_svc.get_by_id_or_raise.return_value = project

    mock_client = MagicMock()
    mock_client.get_item.return_value = workspace
    mock_client.get_items.side_effect = [all_projects, all_conversations]

    mock_ctx = MagicMock()
    mock_ctx.__enter__ = MagicMock(return_value=mock_client)
    mock_ctx.__exit__ = MagicMock(return_value=False)

    mock_directus_client_context = MagicMock(return_value=mock_ctx)

    return mock_conv_svc, mock_directus_client_context


class TestStampOverCapWiring:
    """Tests that _stamp_over_cap correctly fetches data and applies the stamp."""

    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.service.project_service")
    @patch("dembrane.service.conversation_service")
    def test_free_over_cap_stamps_true(
        self, mock_conv_svc, mock_proj_svc, _mock_directus, mock_ctx_fn, mock_logger
    ):
        """Free workspace at 1.5h lifetime, 0.3h conversation → stamps True."""
        mock_conv_svc.get_by_id_or_raise.return_value = _make_conversation(duration=1080)
        mock_proj_svc.get_by_id_or_raise.return_value = _make_project()

        mock_client = MagicMock()
        mock_client.get_item.side_effect = _get_item_for("free")
        mock_client.get_items.side_effect = [
            [{"id": "proj-1"}],
            [{"duration": 5400}],  # 1.5h total
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        _stamp_over_cap("conv-1", mock_logger)

        mock_conv_svc.update.assert_called_once_with(
            conversation_id="conv-1", is_over_cap=True
        )

    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.service.project_service")
    @patch("dembrane.service.conversation_service")
    def test_free_under_cap_no_stamp(
        self, mock_conv_svc, mock_proj_svc, _mock_directus, mock_ctx_fn, mock_logger
    ):
        """Free workspace at 0.6h lifetime, 0.3h conversation → persists is_over_cap=False."""
        mock_conv_svc.get_by_id_or_raise.return_value = _make_conversation(duration=1080)
        mock_proj_svc.get_by_id_or_raise.return_value = _make_project()

        mock_client = MagicMock()
        mock_client.get_item.side_effect = _get_item_for("free")
        mock_client.get_items.side_effect = [
            [{"id": "proj-1"}],
            [{"duration": 2160}],  # 0.6h total
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        _stamp_over_cap("conv-1", mock_logger)

        mock_conv_svc.update.assert_called_once_with(
            conversation_id="conv-1", is_over_cap=False
        )

    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.service.project_service")
    @patch("dembrane.service.conversation_service")
    def test_pioneer_never_stamps(
        self, mock_conv_svc, mock_proj_svc, _mock_directus, mock_ctx_fn, mock_logger
    ):
        """Pioneer workspace at 999h → stamp False (overage tier, never locked)."""
        mock_conv_svc.get_by_id_or_raise.return_value = _make_conversation(duration=3600)
        mock_proj_svc.get_by_id_or_raise.return_value = _make_project()

        mock_client = MagicMock()
        mock_client.get_item.side_effect = _get_item_for("pioneer")
        mock_client.get_items.side_effect = [
            [{"id": "proj-1"}],
            [{"duration": 3596400}],
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        _stamp_over_cap("conv-1", mock_logger)

        mock_conv_svc.update.assert_called_once_with(
            conversation_id="conv-1", is_over_cap=False
        )

    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.service.project_service")
    @patch("dembrane.service.conversation_service")
    def test_soft_edge_crossed_cap_during_recording(
        self, mock_conv_svc, mock_proj_svc, _mock_directus, mock_ctx_fn, mock_logger
    ):
        """Free at 1.1h after 0.6h recording → soft edge: stamp False (ADR 0001)."""
        mock_conv_svc.get_by_id_or_raise.return_value = _make_conversation(duration=2160)
        mock_proj_svc.get_by_id_or_raise.return_value = _make_project()

        mock_client = MagicMock()
        mock_client.get_item.side_effect = _get_item_for("free")
        mock_client.get_items.side_effect = [
            [{"id": "proj-1"}],
            [{"duration": 3960}],  # 1.1h
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        _stamp_over_cap("conv-1", mock_logger)

        mock_conv_svc.update.assert_called_once_with(
            conversation_id="conv-1", is_over_cap=False
        )

    @patch("dembrane.service.project_service")
    @patch("dembrane.service.conversation_service")
    def test_no_project_id_skips(
        self, mock_conv_svc, mock_proj_svc, mock_logger
    ):
        """Conversation with no project_id skips the stamp gracefully."""
        mock_conv_svc.get_by_id_or_raise.return_value = {
            "id": "conv-1",
            "project_id": None,
            "duration": 1080,
        }

        _stamp_over_cap("conv-1", mock_logger)

        mock_conv_svc.update.assert_not_called()
        mock_proj_svc.get_by_id_or_raise.assert_not_called()

    @patch("dembrane.service.project_service")
    @patch("dembrane.service.conversation_service")
    def test_no_workspace_id_skips(
        self, mock_conv_svc, mock_proj_svc, mock_logger
    ):
        """Project with no workspace_id skips the stamp gracefully."""
        mock_conv_svc.get_by_id_or_raise.return_value = _make_conversation()
        mock_proj_svc.get_by_id_or_raise.return_value = {
            "id": "proj-1",
            "workspace_id": None,
        }

        _stamp_over_cap("conv-1", mock_logger)

        mock_conv_svc.update.assert_not_called()

    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.service.project_service")
    @patch("dembrane.service.conversation_service")
    def test_free_started_at_cap_stamps_true(
        self, mock_conv_svc, mock_proj_svc, _mock_directus, mock_ctx_fn, mock_logger
    ):
        """Free at 1.5h after 0.5h recording → started at 1.0h, exactly at the 1h cap."""
        mock_conv_svc.get_by_id_or_raise.return_value = _make_conversation(duration=1800)
        mock_proj_svc.get_by_id_or_raise.return_value = _make_project()

        mock_client = MagicMock()
        mock_client.get_item.side_effect = _get_item_for("free")
        mock_client.get_items.side_effect = [
            [{"id": "proj-1"}],
            [{"duration": 5400}],  # 1.5h
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        _stamp_over_cap("conv-1", mock_logger)

        mock_conv_svc.update.assert_called_once_with(
            conversation_id="conv-1", is_over_cap=True
        )

    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.service.project_service")
    @patch("dembrane.service.conversation_service")
    def test_multi_project_workspace_sums_all(
        self, mock_conv_svc, mock_proj_svc, _mock_directus, mock_ctx_fn, mock_logger
    ):
        """Workspace with multiple projects sums hours across all of them."""
        mock_conv_svc.get_by_id_or_raise.return_value = _make_conversation(duration=1080)
        mock_proj_svc.get_by_id_or_raise.return_value = _make_project()

        mock_client = MagicMock()
        mock_client.get_item.side_effect = _get_item_for("free")
        mock_client.get_items.side_effect = [
            [{"id": "proj-1"}, {"id": "proj-2"}],
            [
                {"duration": 1800},
                {"duration": 3600},
                {"duration": 1080},
            ],  # total 1.8h
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        _stamp_over_cap("conv-1", mock_logger)

        # 1.8h - 0.3h = 1.5h >= 1h cap → stamps True
        mock_conv_svc.update.assert_called_once_with(
            conversation_id="conv-1", is_over_cap=True
        )
