"""Password policy. Keep in sync with frontend/src/lib/passwordPolicy.ts and the
auth_password_policy regex in directus/sync/collections/settings.json."""
import re

PASSWORD_MIN_LENGTH = 8


def validate_password(password: str) -> list[str]:
    """Return a message per unmet rule. Empty list means the password is strong."""
    errors: list[str] = []
    if len(password) < PASSWORD_MIN_LENGTH:
        errors.append(f"Password must be at least {PASSWORD_MIN_LENGTH} characters")
    if not re.search(r"[a-z]", password):
        errors.append("Password must contain a lowercase letter")
    if not re.search(r"[A-Z]", password):
        errors.append("Password must contain an uppercase letter")
    if not re.search(r"[0-9]", password):
        errors.append("Password must contain a number")
    if not re.search(r"[^A-Za-z0-9]", password):
        errors.append("Password must contain a symbol")
    return errors


def is_strong_password(password: str) -> bool:
    return not validate_password(password)
