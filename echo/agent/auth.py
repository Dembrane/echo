from fastapi import HTTPException, Request, status


def parse_authorization_header(value: str | None) -> str | None:
    if not value:
        return None

    parts = value.strip().split(" ", 1)
    if len(parts) != 2:
        return None

    scheme, token = parts
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        return None

    return token


def extract_bearer_token(request: Request) -> str:
    token = parse_authorization_header(request.headers.get("authorization"))
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
        )
    return token
