"""Token-count warm-up: finalize dispatches it, the catch-up sweep self-heals."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from dembrane import tasks as tasks_mod


def test_compute_task_skips_when_already_counted():
    svc = MagicMock()
    svc.get_by_id_or_raise.return_value = {"id": "c1", "token_count": 42}
    with (
        patch("dembrane.service.conversation_service", svc),
        patch.object(tasks_mod, "run_async_in_new_loop") as run_mock,
    ):
        tasks_mod.task_compute_conversation_token_count.fn("c1")
    run_mock.assert_not_called()


def test_compute_task_warms_via_read_endpoint_with_admin_session():
    svc = MagicMock()
    svc.get_by_id_or_raise.return_value = {"id": "c1", "token_count": None}
    captured = {}

    def _run(coro):
        captured["coro"] = coro
        coro.close()
        return 7

    with (
        patch("dembrane.service.conversation_service", svc),
        patch.object(tasks_mod, "run_async_in_new_loop", side_effect=_run),
    ):
        tasks_mod.task_compute_conversation_token_count.fn("c1")
    assert captured["coro"].__qualname__ == "get_conversation_token_count"


def test_compute_task_never_raises():
    svc = MagicMock()
    svc.get_by_id_or_raise.side_effect = RuntimeError("directus down")
    with patch("dembrane.service.conversation_service", svc):
        tasks_mod.task_compute_conversation_token_count.fn("c1")  # must not raise


def test_catch_up_uncounted_queries_one_flag_and_fans_out():
    client = MagicMock()
    client.get_items.return_value = [{"id": "c1"}, {"id": "c2"}]
    ctx = MagicMock()
    ctx.__enter__.return_value = client
    ctx.__exit__.return_value = False

    group_mock = MagicMock()
    with (
        patch.object(tasks_mod, "directus_client_context", return_value=ctx),
        patch.object(tasks_mod, "group", return_value=group_mock) as group_factory,
        patch.object(
            tasks_mod.task_compute_conversation_token_count, "message", side_effect=lambda c: c
        ),
    ):
        tasks_mod.task_catch_up_uncounted_conversations.fn()

    query = client.get_items.call_args.args[1]["query"]
    assert query["filter"] == {
        "is_all_chunks_transcribed": {"_eq": True},
        "token_count": {"_null": True},
        "deleted_at": {"_null": True},
    }
    assert query["limit"] == 200
    assert group_factory.call_args.args[0] == ["c1", "c2"]
    group_mock.run.assert_called_once()


def test_finalize_dispatches_token_warmup():
    import inspect

    src = inspect.getsource(tasks_mod.task_finalize_conversation.fn)
    merge_pos = src.index("task_merge_conversation_chunks.send")
    warm_pos = src.index("task_compute_conversation_token_count.send")
    assert warm_pos > merge_pos
