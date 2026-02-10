from logging import getLogger

import requests
from fastapi import APIRouter, HTTPException, UploadFile

from dembrane.directus import directus
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = getLogger("api.user_settings")

UserSettingsRouter = APIRouter()


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
        response = requests.post(url, headers=headers, files=files, data=data, verify=directus.verify)
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
