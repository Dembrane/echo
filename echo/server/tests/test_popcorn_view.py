from __future__ import annotations

import re
import json
from pathlib import Path

from dembrane.popcorn.view import ILLUSTRATIONS, render_flow_page, render_popcorn_page


def test_page_is_self_contained_and_carries_embed_config() -> None:
    html = render_popcorn_page(embed={"mode": "public"})
    assert 'window.POPCORN_EMBED = {"mode": "public"};' in html
    # The embed config is defined before the app script reads it.
    assert html.index("window.POPCORN_EMBED") < html.index("const EMBED =")
    # Stylesheet and scripts are inlined: no relative asset requests remain.
    assert not re.search(r'href="assets/', html)
    assert not re.search(r'src="assets/', html)
    assert "<style>" in html
    assert "fetch(`data/bundle.json?t=${now}" in html
    assert ".qr-panel" in html
    assert "window.POPCORN_AUDIENCE_I18N" in html
    assert 'src="assets/audience-i18n.js' not in html
    assert html.index("window.POPCORN_AUDIENCE_I18N") < html.index("const I18N =")


def test_audience_translations_cover_keys_and_placeholders() -> None:
    static = Path(__file__).parents[1] / "dembrane" / "popcorn" / "static"
    app = (static / "app.js").read_text(encoding="utf-8")
    source = (static / "audience-i18n.js").read_text(encoding="utf-8")
    english_block = app[app.index("    en: {") : app.index("    nl: {")]
    rows = re.findall(r'^      "([^"]+)": ("(?:[^"\\]|\\.)*"),$', english_block, re.M)
    keys = [key for key, _value in rows]
    english = [json.loads(value) for _key, value in rows]
    assert len(keys) == 165

    def placeholders(value: str) -> list[str]:
        return sorted(re.findall(r"\{[^}]+\}", value))

    for language in ("de", "fr", "es", "it", "uk", "cs"):
        match = re.search(rf"^    {language}: \[(.*?)^    \]", source, re.M | re.S)
        assert match, language
        values = json.loads("[" + match.group(1) + "]")
        assert len(values) == len(keys), language
        for key, expected, translated in zip(keys, english, values, strict=True):
            assert translated.strip(), f"{language}: {key}"
            assert placeholders(translated) == placeholders(expected), f"{language}: {key}"

    for language in ("uk", "cs"):
        start = source.index(f"    {language}: {{", source.index("plurals:"))
        end_marker = "\n    cs: {" if language == "uk" else "\n    }\n  }"
        plural_block = source[start : source.index(end_marker, start)]
        for base in (
            "progress.reading", "progress.allRead", "progress.read", "tally.popcorns",
            "wait.empty", "rec.count", "rec.countMatch", "rec.quotes", "tension.count",
            "tension.countMatch", "stake.count", "stake.countMatch", "stake.groups",
        ):
            assert f'"{base}.few"' in plural_block
            assert f'"{base}.many"' in plural_block


def test_embed_config_cannot_break_out_of_its_script_tag() -> None:
    html = render_popcorn_page(embed={"mode": "</script><script>alert(1)"})
    assert "</script><script>alert(1)" not in html
    assert "<\\/script>" in html


def test_flow_page_is_a_whole_document_with_its_diagrams() -> None:
    html = render_flow_page()
    assert html.startswith("<!doctype html>") and "<title>How popcorn works</title>" in html
    assert html.count('<pre class="mermaid">') >= 5
    assert "cdnjs.cloudflare.com/ajax/libs/mermaid/" in html


def test_the_page_carries_the_presenter_switch_and_no_host_bridge() -> None:
    from dembrane.popcorn.view import render_popcorn_page

    html = render_popcorn_page(embed={"mode": "host"})
    assert 'get("present") === "1"' in html
    assert "dembrane:popcorn:settings" not in html and "postHostSetting" not in html
    assert "data/latency" in html and "COUNTDOWN_MS" in html


def test_present_shell_can_reopen_named_opening_screens() -> None:
    html = render_popcorn_page(embed={"mode": "host", "presentationId": "room"})
    assert 'message.command === "opening"' in html
    assert '["intro", "data"].includes(message.screen)' in html
    assert 'type: "opening"' in html
    assert "notifyOpeningState(true, screen.kind)" in html
    assert "notifyOpeningState(false)" in html


def test_every_drawing_has_a_dark_twin_the_deck_can_ask_for() -> None:
    light = {name for name in ILLUSTRATIONS if not name.endswith("-dark")}
    assert light == {"scan", "talk-anon", "talk-public", "understand"}
    assert {f"{name}-dark" for name in light} == set(ILLUSTRATIONS) - light
    for path in ILLUSTRATIONS.values():
        assert path.is_file(), path
    # The deck asks for both of a pair by these names.
    static = Path(__file__).parents[1] / "dembrane" / "popcorn" / "static"
    app = (static / "app.js").read_text(encoding="utf-8")
    assert 'src="illustrations/${name}${twin}.webp"' in app

