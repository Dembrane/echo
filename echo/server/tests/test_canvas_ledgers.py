from __future__ import annotations

from dembrane.canvas.ledgers import (
    host_item,
    state_patch,
    append_host_item,
    fresh_canvas_state,
    render_tabbed_canvas,
    apply_model_extraction,
)
from dembrane.canvas.sanitize import sanitize_canvas_html


def _bundle() -> dict:
    return {
        "project": {"name": "Room"},
        "conversations": [
            {
                "id": "conv-1",
                "label": "Maya",
                "chunks": [
                    {
                        "id": "chunk-1",
                        "transcript": "Keep the doorway open. This should remain easy to explain.",
                        "created_at": "2026-07-08T10:00:00+00:00",
                    }
                ],
            }
        ],
    }


def test_apply_model_extraction_accepts_verbatim_receipts_and_updates_crux() -> None:
    state = fresh_canvas_state()
    extraction = {
        "quotes": [
            {
                "who": "Maya",
                "quote": "Keep the doorway open.",
                "conversation_id": "conv-1",
                "chunk_id": "chunk-1",
            }
        ],
        "concepts": [{"phrase": "doorway open", "supporting_quote_indices": [0]}],
        "crux": {"question": "What first move keeps the doorway open?"},
        "story_slides": [
            {
                "eyebrow": "Signal",
                "heading": "The doorway matters",
                "lede": "People want the doorway open.",
                "quote_indices": [0],
            }
        ],
    }

    state, detail = apply_model_extraction(state, _bundle(), extraction)
    state, second_detail = apply_model_extraction(state, _bundle(), extraction)

    assert detail["quotes_added"] == 1
    assert second_detail["quotes_added"] == 0
    assert state["quotes_ledger"][0]["quote"] == "Keep the doorway open."
    assert state["concepts_ledger"][0]["phrase"] == "doorway open"
    assert state["crux"]["question"] == "What first move keeps the doorway open?"
    assert state["story_slides"][0]["quote_ids"] == [state["quotes_ledger"][0]["id"]]
    assert state_patch(state)["canvas_tabs"] == [
        {"kind": "crux"},
        {"kind": "concept_cloud"},
        {"kind": "story"},
        {"kind": "host_guide"},
        {"kind": "trace"},
        {"kind": "audit"},
    ]
    assert state_patch(state)["canvas_story_slides"]


def test_apply_model_extraction_rejects_fabricated_quote_and_homeless_concept() -> None:
    state = fresh_canvas_state()
    extraction = {
        "quotes": [
            {
                "who": "Maya",
                "quote": "This was never said.",
                "conversation_id": "conv-1",
                "chunk_id": "chunk-1",
            }
        ],
        "concepts": [{"phrase": "never said", "supporting_quote_indices": [0]}],
        "crux": None,
        "story_slides": [],
    }

    state, detail = apply_model_extraction(state, _bundle(), extraction)

    assert state["quotes_ledger"] == []
    assert state["concepts_ledger"] == []
    assert detail["quotes_added"] == 0
    assert any("not found verbatim" in rejection for rejection in detail["rejections"])
    assert any("no accepted supporting quote" in rejection for rejection in detail["rejections"])


def test_crux_updates_in_place_and_keeps_history() -> None:
    state = fresh_canvas_state(
        {"canvas_crux": {"question": "What should we try first?", "history": []}}
    )

    state, detail = apply_model_extraction(
        state,
        _bundle(),
        {
            "quotes": [],
            "concepts": [],
            "crux": {"question": "What first move keeps the doorway open?"},
            "story_slides": [],
        },
    )

    assert detail["crux_changed"] is True
    assert state["crux"]["question"] == "What first move keeps the doorway open?"
    assert state["crux"]["history"] == [
        {
            "question": "What should we try first?",
            "replaced_at": state["crux"]["updated_at"],
        }
    ]


def test_concept_caps_and_three_xl_are_enforced_in_code() -> None:
    state = fresh_canvas_state()
    bundle = {
        "conversations": [
            {
                "id": "conv-1",
                "label": "Maya",
                "latest_transcript": " ".join(f"phrase {i} matters." for i in range(24)),
            }
        ]
    }
    extraction = {
        "quotes": [
            {
                "who": "Maya",
                "quote": f"phrase {i} matters.",
                "conversation_id": "conv-1",
                "chunk_id": None,
            }
            for i in range(24)
        ],
        "concepts": [{"phrase": f"phrase {i}", "supporting_quote_indices": [i]} for i in range(24)],
        "crux": None,
        "story_slides": [],
    }

    state, _detail = apply_model_extraction(state, bundle, extraction)

    assert sum(1 for concept in state["concepts_ledger"] if concept["size_tier"] == "xl") == 3
    html = render_tabbed_canvas(state=state, project={"name": "Room"})
    assert html.count('class="tabbed-concept ') == 20


def test_render_tabbed_canvas_includes_tabs_traceable_quotes_and_host_items() -> None:
    state = fresh_canvas_state()
    state, _detail = apply_model_extraction(
        state,
        _bundle(),
        {
            "quotes": [
                {
                    "who": "Maya",
                    "quote": "Keep the doorway open.",
                    "conversation_id": "conv-1",
                    "chunk_id": "chunk-1",
                }
            ],
            "concepts": [{"phrase": "doorway open", "supporting_quote_indices": [0]}],
            "crux": {"question": "What first move keeps the doorway open?"},
            "story_slides": [],
        },
    )
    item = host_item(
        text="Host says: hold this exact reflection.",
        target_tab="story",
        person="Host",
        chat_id="chat-1",
        message_id="msg-1",
    )
    state = append_host_item(state, item)

    html = render_tabbed_canvas(
        state=state,
        project={"id": "project-1", "workspace_id": "workspace-1", "name": "Room", "language": "en"},
        report_name="13th Week Retrospective Wall",
    )

    assert 'type="radio"' in html
    assert 'for="canvas-tab-crux"' in html
    assert 'for="canvas-tab-host_guide"' in html
    assert 'href="#tab-trace"' in html
    assert 'href="#tab-audit"' in html
    assert ">Open questions</label>" in html
    assert (
        'href="/en-US/w/workspace-1/projects/project-1/chats/new?prefill='
        "I%20need%20a%20new%20tab%20in%20the%2013th%20Week%20Retrospective%20Wall%20canvas%3A%20"
        '" target="_top"'
    ) in html
    assert "tabbed-traceable" in html
    assert 'href="#trace-' in html
    assert 'class="tabbed-trace-entry" id="trace-' in html
    assert "Host says: hold this exact reflection." in html
    sanitized = sanitize_canvas_html(html)
    assert 'href="#trace-' in sanitized.html


def test_render_tabbed_canvas_includes_audit_log_entries() -> None:
    state = fresh_canvas_state(
        {
            "audit_entries": [
                {
                    "at": "2026-07-09T12:34:00Z",
                    "kind": "run",
                    "version": 2,
                    "cause": {
                        "type": "scheduled",
                        "chat_id": "chat-1",
                        "message_id": "msg-1",
                        "run_chat_id": "chat-run",
                    },
                    "heard": ["doorway open"],
                    "changes": ["added doorway open"],
                    "kept_out": ["quote was not exact"],
                }
            ]
        }
    )

    html = render_tabbed_canvas(state=state, project={"name": "Room"})

    assert "Audit log" in html
    assert "12:34 · run — scheduled from chat chat-1 message msg-1" in html
    assert "run chat chat-run" in html
    assert "added doorway open" in html
    assert "quote was not exact" in html


def test_render_tabbed_canvas_includes_persisted_host_guide() -> None:
    state = fresh_canvas_state(
        {
            "canvas_host_guide": {
                "where_the_room_is": "The room is circling one concrete next step.",
                "what_to_ask_next": ["What would make this safe to try tomorrow?"],
                "under_heard": ["No receipts yet from operations."],
            }
        }
    )

    html = render_tabbed_canvas(state=state, project={"name": "Room"})

    assert "Open questions" in html
    assert "Host guide" not in html
    assert "Where the room is" not in html
    assert "What would make this safe to try tomorrow?" in html
    assert "No receipts yet from operations." in html
    assert state_patch(state)["canvas_host_guide"]["where_the_room_is"].startswith("The room")


def test_story_slides_use_full_screen_spacing_hooks() -> None:
    state = fresh_canvas_state(
        {
            "canvas_story_slides": [
                {
                    "eyebrow": "Signal",
                    "heading": "The doorway matters",
                    "lede": "People want the doorway open.",
                    "quote_ids": [],
                }
            ]
        }
    )

    html = render_tabbed_canvas(state=state, project={"name": "Room"})

    assert 'class="tabbed-story-stack"' in html
    assert 'class="tabbed-story-slide"' in html
    assert "min-height:80vh" in html
    assert "font-size:clamp(32px,4.6vw,48px)" in html


def test_board_renders_from_attributed_quotes() -> None:
    state = fresh_canvas_state({"canvas_tabs": [{"kind": "board", "grouping": "person"}]})
    state, detail = apply_model_extraction(
        state,
        _bundle(),
        {
            "quotes": [
                {
                    "who": "Maya",
                    "quote": "Keep the doorway open.",
                    "conversation_id": "conv-1",
                    "chunk_id": "chunk-1",
                }
            ],
            "concepts": [],
            "crux": None,
            "story_slides": [],
            "board_cards": [
                {
                    "group": "Maya",
                    "synthesis": "Maya wants the next step to stay easy to enter.",
                    "quote_indices": [0],
                }
            ],
        },
    )

    html = render_tabbed_canvas(state=state, project={"name": "Room"})

    assert detail["board_changed"] is True
    assert state["board_cards"][0]["group"] == "Maya"
    assert "Maya wants the next step" in html
    assert "Keep the doorway open." in html


def test_board_folds_unattributed_receipts_into_room_card() -> None:
    state = fresh_canvas_state({"canvas_tabs": [{"kind": "board", "grouping": "person"}]})
    bundle = {
        "conversations": [
            {
                "id": "conv-1",
                "label": "participant",
                "latest_transcript": "This should remain easy to explain.",
            }
        ]
    }
    state, _detail = apply_model_extraction(
        state,
        bundle,
        {
            "quotes": [
                {
                    "who": None,
                    "quote": "This should remain easy to explain.",
                    "conversation_id": "conv-1",
                    "chunk_id": None,
                }
            ],
            "concepts": [],
            "crux": None,
            "story_slides": [],
            "board_cards": [
                {
                    "group": "Maya",
                    "synthesis": "The room wants the next step to stay explainable.",
                    "quote_indices": [0],
                }
            ],
        },
    )

    html = render_tabbed_canvas(state=state, project={"name": "Room"})

    assert state["board_cards"][0]["group"] == "the room"
    assert "the room" in html
    assert "Maya" not in html
