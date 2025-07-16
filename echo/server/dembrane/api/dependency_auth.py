from typing import Annotated
from logging import getLogger

from jose import JWTError, jwt
from fastapi import Depends, Request

from dembrane.config import DIRECTUS_SECRET, DIRECTUS_SESSION_COOKIE_NAME
from dembrane.api.exceptions import SessionInvalidException

logger = getLogger("api.session")


class DirectusSession:
    def __init__(self, user_id: str, is_admin: bool):
        self.user_id = user_id
        self.is_admin = is_admin

    def __str__(self) -> str:
        return f"DirectusSession(user_id={self.user_id}, is_admin={self.is_admin})"

    def __repr__(self) -> str:
        return str(self)


async def require_directus_session(request: Request) -> DirectusSession:
    """
    Returns user id if user is authenticated, otherwise raises an exception
    """
    directus_cookie = request.cookies.get(DIRECTUS_SESSION_COOKIE_NAME)
    auth_header = request.headers.get("Authorization")

    # Determine the token to decode
    to_decode = None

    if directus_cookie and directus_cookie.strip():
        logger.debug("directus cookie found")
        to_decode = directus_cookie.strip()
    elif auth_header and auth_header.startswith("Bearer "):
        logger.debug("authorization header found")
        to_decode = auth_header[7:].strip()
    else:
        logger.debug("no valid authentication found")
        raise SessionInvalidException

    # Validate we have a token to decode
    if not to_decode:
        raise SessionInvalidException

    # try:
    #     user_id = verify_static_token(to_decode)
    #     # TODO: check if user actually is admin

    #     return DirectusSession(str(user_id), True)
    # except Exception as exc:
    #     logger.debug(f"DirectusBadRequest: {exc}")

    try:
        if not DIRECTUS_SECRET:
            logger.error("DIRECTUS_SECRET is not configured")
            raise SessionInvalidException

        # Decode JWT with algorithm specification for security
        decoded = jwt.decode(
            to_decode,
            DIRECTUS_SECRET,
            algorithms=["HS256"],  # Explicitly specify allowed algorithms
        )

        # Validate required fields exist
        user_id = decoded.get("id")
        if user_id is None:
            logger.error("JWT missing required 'id' field")
            raise SessionInvalidException

        is_admin = decoded.get("admin_access", False)

        return DirectusSession(str(user_id), bool(is_admin))

    except JWTError as exc:
        logger.error(f"JWT validation failed: {exc}")
        raise SessionInvalidException from exc
    except Exception as exc:
        logger.error(f"Unexpected error during authentication: {exc}")
        raise SessionInvalidException from exc


DependencyDirectusSession = Annotated[DirectusSession, Depends(require_directus_session)]
