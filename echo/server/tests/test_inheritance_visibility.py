"""workspace_follows_organisation_admins gates derived org-admin access on
visibility. Only open_to_organisation fans admins in; invite_only and private
require an explicit join. (Org-owner carve-out is tested via derive_workspace_role.)"""

from dembrane.inheritance import (
    derive_workspace_role,
    workspace_follows_organisation_admins,
)


def test_open_follows_admins():
    assert workspace_follows_organisation_admins({"visibility": "open_to_organisation"}) is True


def test_invite_only_does_not_follow_admins():
    assert workspace_follows_organisation_admins({"visibility": "invite_only"}) is False


def test_private_does_not_follow_admins():
    assert workspace_follows_organisation_admins({"visibility": "private"}) is False


def test_admin_derives_on_open_only():
    assert derive_workspace_role({"visibility": "open_to_organisation"}, "admin", "u1") == "admin"
    assert derive_workspace_role({"visibility": "invite_only"}, "admin", "u1") is None
    assert derive_workspace_role({"visibility": "private"}, "admin", "u1") is None


def test_owner_carveout_survives_on_all_visibilities():
    # The org owner is never locked out, regardless of visibility.
    assert derive_workspace_role({"visibility": "open_to_organisation"}, "owner", "u1") == "admin"
    assert derive_workspace_role({"visibility": "invite_only"}, "owner", "u1") == "admin"
    assert derive_workspace_role({"visibility": "private"}, "owner", "u1") == "admin"
