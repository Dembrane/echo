"""Remove the unused `token` field from workspace_invite collection.

The HMAC flow doesn't need a stored token — the hash is derived from
invite_id via HMAC(invite_id, secret). The old token column was a code smell.

Idempotent: safely skips if field doesn't exist.

Run once:
  cd server && uv run python ../scripts/remove_invite_token_field.py
Then sync:
  cd directus && bash sync.sh -u http://directus:8055 -e admin@dembrane.com -p admin pull
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from dembrane.directus import DirectusClient
from dembrane.settings import get_settings

settings = get_settings()
client = DirectusClient(
    url=settings.directus.base_url,
    token=settings.directus.token,
)


def field_exists(collection: str, field: str) -> bool:
    try:
        client.get(f"/fields/{collection}/{field}")
        return True
    except Exception:
        return False


def main() -> int:
    if not field_exists("workspace_invite", "token"):
        print("Field workspace_invite.token already removed — nothing to do")
        return 0

    print("Deleting field workspace_invite.token...")
    client.delete("/fields/workspace_invite/token")
    print("  ✓ Field deleted")

    print("\nDone. Pull Directus schema to snapshot:")
    print("  cd directus && bash sync.sh -u http://directus:8055 "
          "-e admin@dembrane.com -p admin pull")
    return 0


if __name__ == "__main__":
    sys.exit(main())
