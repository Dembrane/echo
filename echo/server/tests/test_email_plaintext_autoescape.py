from dembrane.email import TEMPLATE_DIR, _render_plain_text_template


class SafeMockContext(dict):
    def __missing__(self, key):
        return "https://example.com/test?a=1&b=2"


def test_plaintext_templates_no_html_autoescape():
    # Upgrade test to verify that ampersands in urls rendered inside ANY plaintext template
    # are not HTML-escaped to &amp;
    context = SafeMockContext({
        "freeze_items": ["item1", "item2"],
        "revert_items": ["item1", "item2"],
        "items": [{"summary": "Test Summary", "timestamp": "2026-08-01 12:00:00"}],
        "invite_url": "https://dashboard.echo-next.dembrane.com/invite/accept?iss=sameer&role=external&email=test@example.com&h=420a&ws=Default",
        "workspace_url": "https://dashboard.echo-next.dembrane.com/invite/accept?iss=sameer&role=external&email=test@example.com&h=420a&ws=Default",
    })

    txt_files = list(TEMPLATE_DIR.glob("*.txt"))
    assert len(txt_files) > 0, "No plain-text templates found!"

    for f in txt_files:
        template_name = f.stem
        rendered = _render_plain_text_template(template_name, context)
        assert rendered is not None, f"Failed to render plain-text template: {template_name}"
        # The URLs/ampersands must remain exactly as passed (no HTML escaping of ampersands)
        assert "&amp;" not in rendered, f"HTML-escaped ampersand (&amp;) found in rendered plaintext template: {template_name}.txt!"
