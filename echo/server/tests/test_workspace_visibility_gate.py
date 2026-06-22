"""The paywall fires only when crossing OUT of open_to_organisation."""

from dembrane.api.v2.workspace_settings import visibility_change_needs_paywall


def test_open_to_invite_only_is_gated():
    assert visibility_change_needs_paywall("open_to_organisation", "invite_only") is True


def test_open_to_private_is_gated():
    assert visibility_change_needs_paywall("open_to_organisation", "private") is True


def test_invite_only_to_private_is_free():
    assert visibility_change_needs_paywall("invite_only", "private") is False


def test_private_to_invite_only_is_free():
    assert visibility_change_needs_paywall("private", "invite_only") is False


def test_any_to_open_is_free():
    assert visibility_change_needs_paywall("private", "open_to_organisation") is False
    assert visibility_change_needs_paywall("invite_only", "open_to_organisation") is False


def test_no_change_is_free():
    assert visibility_change_needs_paywall("invite_only", "invite_only") is False
