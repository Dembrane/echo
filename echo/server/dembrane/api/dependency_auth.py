from typing import Optional, Annotated
from logging import getLogger

from jose import JWTError, jwt
from fastapi import Depends, Request

from dembrane.directus import (
    DirectusClient,
    directus,
    create_directus_client,
)
from dembrane.settings import get_settings
from dembrane.api.exceptions import SessionInvalidException

logger = getLogger("api.session")
settings = get_settings()

DIRECTUS_SECRET = settings.directus.secret
DIRECTUS_SESSION_COOKIE_NAME = settings.directus.session_cookie_name

logger.debug("DIRECTUS_SECRET: %s", DIRECTUS_SECRET)
logger.debug("DIRECTUS_SESSION_COOKIE_NAME: %s", DIRECTUS_SESSION_COOKIE_NAME)


class DirectusSession:
    def __init__(
        self,
        user_id: str,
        is_admin: bool,
        *,
        access_token: Optional[str] = None,
        client: Optional[DirectusClient] = None,
    ):
        self.user_id = user_id
        self.is_admin = is_admin
        self.access_token = access_token
        self.client = client or directus

    def __str__(self) -> str:
        return (
            "DirectusSession("
            f"user_id={self.user_id}, "
            f"is_admin={self.is_admin}, "
            f"has_token={bool(self.access_token)}"
            ")"
        )

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
        to_decode = directus_cookie.strip()
        logger.debug("directus cookie found with value")
    elif auth_header and auth_header.startswith("Bearer "):
        logger.debug("authorization header found with value")
        to_decode = auth_header[7:].strip()
    else:
        logger.debug("no valid authentication found with value")
        raise SessionInvalidException

    # Validate we have a token to decode
    if not to_decode:
        raise SessionInvalidException

    try:
        if not DIRECTUS_SECRET:
            logger.error("DIRECTUS_SECRET is not configured")
            raise SessionInvalidException

        # Decode JWT with algorithm specification for security
        decoded = jwt.decode(
            token=to_decode,
            key=DIRECTUS_SECRET,
            algorithms=["HS256"],
        )

        # Validate required fields exist
        user_id = decoded.get("id")
        if user_id is None:
            logger.error("JWT missing required 'id' field")
            raise SessionInvalidException
        is_admin = decoded.get("admin_access", False)

        client = create_directus_client(token=to_decode)

        return DirectusSession(
            str(user_id),
            bool(is_admin),
            access_token=to_decode,
            client=client,
        )

    except JWTError as exc:
        logger.error(f"JWT validation failed: {exc}")
        raise SessionInvalidException from exc
    except Exception as exc:
        logger.error(f"Unexpected error during authentication: {exc}")
        raise SessionInvalidException from exc


DependencyDirectusSession = Annotated[DirectusSession, Depends(require_directus_session)]


async def require_directus_client(
    session: DependencyDirectusSession,
) -> DirectusClient:
    return session.client or directus


DependencyDirectusClient = Annotated[DirectusClient, Depends(require_directus_client)]
