from dembrane.email import _render_plain_text_template


def test_plaintext_template_no_html_autoescape():
    # Verify that ampersands in urls rendered inside plaintext templates are not HTML-escaped to &amp;
    invite_url = "https://dashboard.echo-next.dembrane.com/invite/accept?iss=sameer&role=external&email=test@example.com&h=420a&ws=Default"
    rendered = _render_plain_text_template(
        "workspace_invite",
        {
            "inviter_name": "Sameer",
            "workspace_name": "Default Workspace",
            "invite_url": invite_url,
        },
    )
    assert rendered is not None
    # The URL must remain exactly as passed (no HTML escaping of ampersands)
    assert invite_url in rendered
    assert "&amp;" not in rendered
