from typing import Literal, Optional
from logging import getLogger

import requests
from fastapi import APIRouter, UploadFile, HTTPException
from pydantic import BaseModel

from dembrane.directus import directus
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = getLogger("api.user_settings")

UserSettingsRouter = APIRouter()


class LegalBasisUpdateSchema(BaseModel):
    legal_basis: Literal["client-managed", "consent", "dembrane-events"]
    privacy_policy_url: Optional[str] = None


class UpdateNameSchema(BaseModel):
    first_name: str


class ChangePasswordSchema(BaseModel):
    current_password: str
    new_password: str


class TfaGenerateSchema(BaseModel):
    password: str


class TfaEnableSchema(BaseModel):
    otp: str
    secret: str


class TfaDisableSchema(BaseModel):
    otp: str


# ── Current User Profile ──


USER_PROFILE_FIELDS = [
    "id",
    "first_name",
    "email",
    "avatar",
    "disable_create_project",
    "tfa_secret",
    "whitelabel_logo",
    "legal_basis",
    "privacy_policy_url",
    "hide_ai_suggestions",
]


@UserSettingsRouter.get("/me")
async def get_current_user(
    auth: DependencyDirectusSession,
) -> dict:
    """Get current user profile."""
    try:
        users = directus.get_users(
            {
                "query": {
                    "filter": {"id": {"_eq": auth.user_id}},
                    "fields": USER_PROFILE_FIELDS,
                    "limit": 1,
                }
            },
        )
        if not isinstance(users, list) or len(users) == 0:
            raise HTTPException(status_code=404, detail="User not found")
        user = users[0]
        # Never expose the raw tfa_secret — only expose a boolean flag
        user["tfa_enabled"] = bool(user.get("tfa_secret"))
        user.pop("tfa_secret", None)
        return user
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get current user: {e}")
        raise HTTPException(status_code=500, detail="Failed to get user profile") from e


# ── Change Password ──


@UserSettingsRouter.patch("/password")
async def change_password(
    body: ChangePasswordSchema,
    auth: DependencyDirectusSession,
) -> dict:
    """Change the user's password. Verifies current password via Directus login, then updates."""
    if not auth.access_token:
        raise HTTPException(status_code=401, detail="No access token")

    # Verify current password by attempting to get user email and login
    try:
        users = directus.get_users(
            {
                "query": {
                    "filter": {"id": {"_eq": auth.user_id}},
                    "fields": ["email"],
                    "limit": 1,
                }
            },
        )
        if not isinstance(users, list) or len(users) == 0:
            raise HTTPException(status_code=404, detail="User not found")
        email = users[0].get("email", "")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get user email for password change: {e}")
        raise HTTPException(status_code=500, detail="Failed to change password") from e

    # Verify current password by attempting login
    try:
        login_url = f"{directus.url}/auth/login"
        login_response = requests.post(
            login_url,
            json={"email": email, "password": body.current_password},
            verify=directus.verify,
        )
        if login_response.status_code != 200:
            raise HTTPException(status_code=400, detail="Current password is incorrect")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to verify current password: {e}")
        raise HTTPException(status_code=500, detail="Failed to change password") from e

    # Update password via user's session token
    try:
        url = f"{directus.url}/users/me"
        headers = {
            "Authorization": f"Bearer {auth.access_token}",
            "Content-Type": "application/json",
        }
        response = requests.patch(
            url,
            json={"password": body.new_password},
            headers=headers,
            verify=directus.verify,
        )
        if response.status_code != 200:
            error_data = response.json() if response.content else {}
            errors = error_data.get("errors", [{}])
            detail = errors[0].get("message", "Failed to change password") if errors else "Failed to change password"
            raise HTTPException(status_code=response.status_code, detail=detail)

        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to change password: {e}")
        raise HTTPException(status_code=500, detail="Failed to change password") from e


# ── Two-Factor Authentication ──


@UserSettingsRouter.post("/tfa/generate")
async def tfa_generate(
    body: TfaGenerateSchema,
    auth: DependencyDirectusSession,
) -> dict:
    """Generate a 2FA secret. Proxies to Directus TFA endpoint using the user's session token."""
    if not auth.access_token:
        raise HTTPException(status_code=401, detail="No access token")

    try:
        url = f"{directus.url}/users/me/tfa/generate"
        headers = {
            "Authorization": f"Bearer {auth.access_token}",
            "Content-Type": "application/json",
        }
        response = requests.post(
            url,
            json={"password": body.password},
            headers=headers,
            verify=directus.verify,
        )
        if response.status_code != 200:
            error_data = response.json() if response.content else {}
            errors = error_data.get("errors", [{}])
            detail = errors[0].get("message", "Failed to generate 2FA secret") if errors else "Failed to generate 2FA secret"
            raise HTTPException(status_code=response.status_code, detail=detail)

        return response.json().get("data", response.json())
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to generate 2FA secret: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate 2FA secret") from e


@UserSettingsRouter.post("/tfa/enable")
async def tfa_enable(
    body: TfaEnableSchema,
    auth: DependencyDirectusSession,
) -> dict:
    """Enable 2FA. Proxies to Directus TFA endpoint using the user's session token."""
    if not auth.access_token:
        raise HTTPException(status_code=401, detail="No access token")

    try:
        url = f"{directus.url}/users/me/tfa/enable"
        headers = {
            "Authorization": f"Bearer {auth.access_token}",
            "Content-Type": "application/json",
        }
        response = requests.post(
            url,
            json={"otp": body.otp, "secret": body.secret},
            headers=headers,
            verify=directus.verify,
        )
        if response.status_code != 200 and response.status_code != 204:
            error_data = response.json() if response.content else {}
            errors = error_data.get("errors", [{}])
            detail = errors[0].get("message", "Failed to enable 2FA") if errors else "Failed to enable 2FA"
            raise HTTPException(status_code=response.status_code, detail=detail)

        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to enable 2FA: {e}")
        raise HTTPException(status_code=500, detail="Failed to enable 2FA") from e


@UserSettingsRouter.post("/tfa/disable")
async def tfa_disable(
    body: TfaDisableSchema,
    auth: DependencyDirectusSession,
) -> dict:
    """Disable 2FA. Proxies to Directus TFA endpoint using the user's session token."""
    if not auth.access_token:
        raise HTTPException(status_code=401, detail="No access token")

    try:
        url = f"{directus.url}/users/me/tfa/disable"
        headers = {
            "Authorization": f"Bearer {auth.access_token}",
            "Content-Type": "application/json",
        }
        response = requests.post(
            url,
            json={"otp": body.otp},
            headers=headers,
            verify=directus.verify,
        )
        if response.status_code != 200 and response.status_code != 204:
            error_data = response.json() if response.content else {}
            errors = error_data.get("errors", [{}])
            detail = errors[0].get("message", "Failed to disable 2FA") if errors else "Failed to disable 2FA"
            raise HTTPException(status_code=response.status_code, detail=detail)

        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to disable 2FA: {e}")
        raise HTTPException(status_code=500, detail="Failed to disable 2FA") from e


def _get_or_create_folder_id(folder_name: str) -> str | None:
    """Look up a folder ID by name using admin client, creating it if it doesn't exist."""
    try:
        folders = directus.get(
            "/folders",
            params={"filter[name][_eq]": folder_name, "limit": 1},
        )
        if folders and len(folders) > 0:
            return folders[0]["id"]

        result = directus.post("/folders", json={"name": folder_name})
        folder_id = result.get("data", {}).get("id")
        if folder_id:
            logger.info(f"Created {folder_name} folder: {folder_id}")
            return folder_id
    except Exception as e:
        logger.warning(f"Failed to get or create {folder_name} folder: {e}")
    return None


def _get_or_create_custom_logos_folder_id() -> str | None:
    """Look up the custom_logos folder ID using admin client, creating it if it doesn't exist."""
    try:
        folders = directus.get(
            "/folders",
            params={"filter[name][_eq]": "custom_logos", "limit": 1},
        )
        if folders and len(folders) > 0:
            return folders[0]["id"]

        # Folder doesn't exist, create it
        result = directus.post("/folders", json={"name": "custom_logos"})
        folder_id = result.get("data", {}).get("id")
        if folder_id:
            logger.info(f"Created custom_logos folder: {folder_id}")
            return folder_id
    except Exception as e:
        logger.warning(f"Failed to get or create custom_logos folder: {e}")
    return None


@UserSettingsRouter.post("/whitelabel-logo")
async def upload_whitelabel_logo(
    file: UploadFile,
    auth: DependencyDirectusSession,
) -> dict:
    """Upload a whitelabel logo to the custom_logos folder and set it on the user."""
    folder_id = _get_or_create_custom_logos_folder_id()
    if not folder_id:
        raise HTTPException(status_code=500, detail="Failed to get or create custom_logos folder")

    # Upload file to Directus via admin token
    file_content = await file.read()
    url = f"{directus.url}/files"
    headers = {"Authorization": f"Bearer {directus.get_token()}"}
    files = {"file": (file.filename, file_content, file.content_type or "image/png")}
    data = {"folder": folder_id}

    try:
        response = requests.post(
            url, headers=headers, files=files, data=data, verify=directus.verify
        )
        if response.status_code != 200:
            logger.error(f"Failed to upload file: {response.status_code} {response.text}")
            raise HTTPException(status_code=500, detail="Failed to upload file")

        file_id = response.json()["data"]["id"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload whitelabel logo: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload file") from e

    # Update user's whitelabel_logo field
    try:
        directus.update_user(auth.user_id, {"whitelabel_logo": file_id})
    except Exception as e:
        logger.error(f"Failed to update user whitelabel_logo: {e}")
        raise HTTPException(status_code=500, detail="Failed to update user") from e

    return {"file_id": file_id}


@UserSettingsRouter.delete("/whitelabel-logo")
async def remove_whitelabel_logo(
    auth: DependencyDirectusSession,
) -> dict:
    """Remove the whitelabel logo from the user."""
    try:
        directus.update_user(auth.user_id, {"whitelabel_logo": None})
    except Exception as e:
        logger.error(f"Failed to remove whitelabel logo: {e}")
        raise HTTPException(status_code=500, detail="Failed to remove logo") from e

    return {"status": "ok"}


@UserSettingsRouter.patch("/name")
async def update_name(
    body: UpdateNameSchema,
    auth: DependencyDirectusSession,
) -> dict:
    """Update the user's display name."""
    try:
        directus.update_user(auth.user_id, {"first_name": body.first_name})
    except Exception as e:
        logger.error(f"Failed to update user name: {e}")
        raise HTTPException(status_code=500, detail="Failed to update name") from e
    return {"status": "ok"}


@UserSettingsRouter.post("/avatar")
async def upload_avatar(
    file: UploadFile,
    auth: DependencyDirectusSession,
) -> dict:
    """Upload a user avatar image."""
    folder_id = _get_or_create_folder_id("avatars")
    if not folder_id:
        raise HTTPException(status_code=500, detail="Failed to get or create avatars folder")

    file_content = await file.read()
    url = f"{directus.url}/files"
    headers = {"Authorization": f"Bearer {directus.get_token()}"}
    files = {"file": (file.filename, file_content, file.content_type or "image/png")}
    data = {"folder": folder_id}

    try:
        response = requests.post(
            url, headers=headers, files=files, data=data, verify=directus.verify
        )
        if response.status_code != 200:
            logger.error(f"Failed to upload avatar: {response.status_code} {response.text}")
            raise HTTPException(status_code=500, detail="Failed to upload file")

        file_id = response.json()["data"]["id"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload avatar: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload file") from e

    try:
        directus.update_user(auth.user_id, {"avatar": file_id})
    except Exception as e:
        logger.error(f"Failed to update user avatar: {e}")
        raise HTTPException(status_code=500, detail="Failed to update user") from e

    return {"file_id": file_id}


@UserSettingsRouter.delete("/avatar")
async def remove_avatar(
    auth: DependencyDirectusSession,
) -> dict:
    """Remove the user's avatar."""
    try:
        directus.update_user(auth.user_id, {"avatar": None})
    except Exception as e:
        logger.error(f"Failed to remove avatar: {e}")
        raise HTTPException(status_code=500, detail="Failed to remove avatar") from e
    return {"status": "ok"}


@UserSettingsRouter.patch("/legal-basis")
async def update_legal_basis(
    body: LegalBasisUpdateSchema,
    auth: DependencyDirectusSession,
) -> dict:
    """Update the user's legal basis setting."""
    if body.legal_basis == "dembrane-events":
        try:
            user_data = await run_in_thread_pool(
                directus.get_users,
                {
                    "query": {
                        "filter": {"id": {"_eq": auth.user_id}},
                        "fields": ["email"],
                    }
                },
            )
            email = user_data[0].get("email", "") if user_data else ""
            if not email or not email.lower().endswith("@dembrane.com"):
                raise HTTPException(
                    status_code=403,
                    detail="dembrane-events is only available for dembrane accounts",
                )
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Failed to verify user email: {e}")
            raise HTTPException(status_code=500, detail="Failed to verify user") from e

    update_data: dict = {"legal_basis": body.legal_basis}
    if body.legal_basis == "consent":
        update_data["privacy_policy_url"] = body.privacy_policy_url
    else:
        update_data["privacy_policy_url"] = None

    try:
        await run_in_thread_pool(directus.update_user, auth.user_id, update_data)
    except Exception as e:
        logger.error(f"Failed to update legal basis: {e}")
        raise HTTPException(status_code=500, detail="Failed to update legal basis") from e

    return {"status": "ok"}
