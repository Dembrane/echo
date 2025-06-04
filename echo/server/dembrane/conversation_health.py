import time
import logging

import requests

from dembrane.s3 import get_signed_url
from dembrane.config import (
    RUNPOD_DIARIZATION_API_KEY,
    RUNPOD_DIARIZATION_TIMEOUT,
    RUNPOD_DIARIZATION_BASE_URL,
)
from dembrane.directus import directus

logger = logging.getLogger("conversation_health")


def get_runpod_diarization(
    chunk_id: str | None = None,
    path: str | None = None,
) -> None:
    """
    Request diarization from RunPod, wait for a response, and cancel if no response in timeout.
    All responses and status updates are written to Directus.
    """
    logger.debug(f"***Starting diarization for chunk_id: {chunk_id}, path: {path}")
    try:
        audio_file_uri = path if path else directus.get_item(
            "conversation_chunk",
            chunk_id,
        )["path"]
        logger.debug(f"Fetched audio_file_uri: {audio_file_uri}")
    except Exception as e:
        logger.error(f"Failed to fetch audio_file_uri for chunk_id {chunk_id}: {e}")
        return None

    try:
        audio_url = get_signed_url(audio_file_uri)
        logger.debug(f"Generated signed audio_url: {audio_url}")
    except Exception as e:
        logger.error(f"Failed to generate signed URL for {audio_file_uri}: {e}")
        return None

    timeout = RUNPOD_DIARIZATION_TIMEOUT
    api_key = RUNPOD_DIARIZATION_API_KEY
    base_url = RUNPOD_DIARIZATION_BASE_URL
    logger.debug(f"Diarization config - timeout: {timeout}, base_url: {base_url}")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    data = {"input": {"audio": audio_url}}
    job_status_link = None
    job_id = None
    try:
        logger.debug(f"Sending POST to {base_url}/run with data: {data}")
        response = requests.post(f"{base_url}/run", headers=headers, json=data, timeout=timeout)
        response.raise_for_status()
        job_id = response.json()["id"]
        job_status_link = f"{base_url}/status/{job_id}"
        logger.info(f"Started diarization job {job_id} for chunk {chunk_id}")
    except Exception as e:
        logger.error(f"Failed to queue diarization job: {e}")
        return None

    # Wait for up to timeout seconds for a response
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            logger.debug(f"Polling job status at {job_status_link}")
            response = requests.get(job_status_link, headers=headers, timeout=10)
            response.raise_for_status()
            response_data = response.json()
            status = response_data.get("status")
            logger.debug(f"Job {job_id} status: {status}")
            if status == "COMPLETED":
                dirz_response_data = response_data.get("output")
                noise_ratio = dirz_response_data.get("noise_ratio")
                cross_talk_instances = dirz_response_data.get("cross_talk_instances")
                silence_ratio = dirz_response_data.get("silence_ratio")
                joined_diarization = dirz_response_data.get("joined_diarization")
                logger.info(f"Diarization job {job_id} completed. Updating chunk {chunk_id} with results.")
                directus.update_item(
                    "conversation_chunk",
                    chunk_id,
                    {
                        "noise_ratio": noise_ratio,
                        "cross_talk_instances": cross_talk_instances,
                        "silence_ratio": silence_ratio,
                        "diarization": joined_diarization,
                    },
                )
                logger.debug(f"Updated chunk {chunk_id} with diarization results.")
                return
        except Exception as e:
            logger.error(f"Error polling diarization job status for job {job_id}: {e}")
        time.sleep(3)

    # Timeout: cancel the job
    try:
        cancel_endpoint = f"{base_url}/cancel/{job_id}"
        logger.warning(f"Timeout reached. Cancelling diarization job {job_id} at {cancel_endpoint}")
        cancel_response = requests.post(cancel_endpoint, headers=headers, timeout=10)
        cancel_response.raise_for_status()
        logger.info(f"Cancelled diarization job {job_id} after timeout.")
    except Exception as e:
        logger.error(f"Failed to cancel diarization job {job_id}: {e}")
    return None
