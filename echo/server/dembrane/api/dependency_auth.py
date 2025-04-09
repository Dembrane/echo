from typing import Annotated
from logging import getLogger

from jose import jwt
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


# async def require_directus_session(request: Request) -> DirectusSession:
#     """
#     Returns user id if user is authenticated, otherwise raises an exception
#     """
#     directus_cookie = request.cookies.get(DIRECTUS_SESSION_COOKIE_NAME)

#     if not directus_cookie:
#         auth_header = request.headers.get("Authorization")
#         if auth_header and auth_header.startswith("Bearer "):
#             # Extract the token
#             token = auth_header[7:]  # Skip "Bearer "
#             try:
#                 assert DIRECTUS_SECRET, "DIRECTUS_SECRET is not set"
#                 decoded = jwt.decode(token, DIRECTUS_SECRET)
#             except Exception as exc:
#                 logger.error(exc)
#                 raise SessionInvalidException from exc

#             user_id = decoded.get("id")
#             is_admin = decoded.get("admin_access")

#             return DirectusSession(str(user_id), bool(is_admin))
#         else:
#             raise SessionInvalidException


async def require_directus_session(request: Request) -> DirectusSession:
    """
    Returns user id if user is authenticated, otherwise raises an exception
    """
    directus_cookie = request.cookies.get(DIRECTUS_SESSION_COOKIE_NAME)
    if not directus_cookie:
        raise SessionInvalidException
    try:
        assert DIRECTUS_SECRET, "DIRECTUS_SECRET is not set"
        decoded = jwt.decode(directus_cookie, DIRECTUS_SECRET)
    except Exception as exc:
        logger.error(exc)
        raise SessionInvalidException from exc
    user_id = decoded.get("id")
    is_admin = decoded.get("admin_access")
    return DirectusSession(str(user_id), bool(is_admin))


DependencyDirectusSession = Annotated[DirectusSession, Depends(require_directus_session)]
