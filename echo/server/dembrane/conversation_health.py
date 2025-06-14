import time
import logging
from typing import Any
from datetime import timedelta

import numpy as np
import pandas as pd
import requests

from dembrane.s3 import get_signed_url
from dembrane.utils import get_utc_timestamp
from dembrane.config import (
    RUNPOD_DIARIZATION_API_KEY,
    RUNPOD_DIARIZATION_TIMEOUT,
    RUNPOD_DIARIZATION_BASE_URL,
    DISABLE_MULTILINGUAL_DIARIZATION,
)
from dembrane.directus import directus

logger = logging.getLogger("conversation_health")


def _fetch_chunk_data(chunk_id: str) -> tuple[str, str] | None:
    """
    Retrieves the audio file URI and project language for a given chunk ID from Directus.
    
    Returns:
        A tuple containing (audio_file_uri, project_language) if successful, or None if retrieval fails.
    """
    try:
        directus_item = directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "filter": {"id": {"_eq": chunk_id}},
                    "fields": ["path", "conversation_id.project_id.language"]
                }
            }
        )[0]
        audio_file_uri = directus_item["path"]
        project_language = directus_item["conversation_id"]["project_id"]["language"]
        logger.debug(f"Starting diarization for chunk_id: {chunk_id}, path: {audio_file_uri}, project_language: {project_language}")
        return audio_file_uri, project_language
    except Exception as e:
        logger.error(f"Failed to fetch audio_file_uri for chunk_id {chunk_id}: {e}")
        return None


def _generate_audio_url(audio_file_uri: str) -> str | None:
    """
    Generates a signed URL for the specified audio file.
    
    Args:
        audio_file_uri: The URI of the audio file to sign.
    
    Returns:
        The signed URL as a string if successful, or None if signing fails.
    """
    try:
        audio_url = get_signed_url(audio_file_uri)
        logger.debug(f"Generated signed audio_url: {audio_url}")
        return audio_url
    except Exception as e:
        logger.error(f"Failed to generate signed URL for {audio_file_uri}: {e}")
        return None


def _should_skip_diarization(project_language: str) -> bool:
    """
    Determines whether diarization should be skipped for a given project language.
    
    Returns True if diarization is disabled for non-English languages based on configuration; otherwise, returns False.
    """
    if DISABLE_MULTILINGUAL_DIARIZATION and project_language != "en":
        logger.debug(f"Skipping diarization because project language is {project_language}")
        return True
    return False


def _submit_diarization_job(audio_url: str, project_language: str) -> tuple[str, str] | None:
    """
    Submits an audio diarization job to RunPod using the provided audio URL and project language.
    
    Args:
        audio_url: The signed URL of the audio file to be processed.
        project_language: The language code associated with the project.
    
    Returns:
        A tuple containing the job ID and the job status link if submission is successful, or None if the request fails.
    """
    timeout = RUNPOD_DIARIZATION_TIMEOUT
    api_key = RUNPOD_DIARIZATION_API_KEY
    base_url = RUNPOD_DIARIZATION_BASE_URL
    logger.debug(f"Diarization config - timeout: {timeout}, base_url: {base_url}")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    data = {"input": {"audio": audio_url, "language": project_language}}
    
    try:
        logger.debug(f"Sending POST to {base_url}/run with data: {data}")
        response = requests.post(f"{base_url}/run", headers=headers, json=data, timeout=timeout)
        response.raise_for_status()
        job_id = response.json()["id"]
        job_status_link = f"{base_url}/status/{job_id}"
        logger.info(f"Started diarization job {job_id}")
        return job_id, job_status_link
    except Exception as e:
        logger.error(f"Failed to queue diarization job: {e}")
        return None


def _poll_job_status(job_status_link: str, headers: dict) -> dict | None:
    """
    Retrieves the current status of a diarization job from the provided status link.
    
    Args:
        job_status_link: The URL to poll for job status.
        headers: HTTP headers to include in the request.
    
    Returns:
        The JSON response containing job status information, or None if the request fails.
    """
    try:
        logger.debug(f"Polling job status at {job_status_link}")
        response = requests.get(job_status_link, headers=headers, timeout=10)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        logger.error(f"Error polling diarization job status: {e}")
        return None


def _update_chunk_with_results(chunk_id: str, dirz_response_data: dict) -> None:
    """
    Updates a conversation chunk in Directus with diarization analysis results.
    
    Args:
        chunk_id: The ID of the conversation chunk to update.
        dirz_response_data: Dictionary containing diarization metrics and results to store.
    """
    noise_ratio = dirz_response_data.get("noise_ratio")
    cross_talk_instances = dirz_response_data.get("cross_talk_instances")
    silence_ratio = dirz_response_data.get("silence_ratio")
    joined_diarization = dirz_response_data.get("joined_diarization")
    
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


def _cancel_job_on_timeout(job_id: str) -> None:
    """
    Cancels a diarization job on RunPod if it has exceeded the allowed processing time.
    
    Logs a warning before attempting cancellation and logs an error if the cancellation fails.
    """
    base_url = RUNPOD_DIARIZATION_BASE_URL
    api_key = RUNPOD_DIARIZATION_API_KEY
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    
    try:
        cancel_endpoint = f"{base_url}/cancel/{job_id}"
        logger.warning(f"Timeout reached. Cancelling diarization job {job_id} at {cancel_endpoint}")
        cancel_response = requests.post(cancel_endpoint, headers=headers, timeout=10)
        cancel_response.raise_for_status()
        logger.info(f"Cancelled diarization job {job_id} after timeout.")
    except Exception as e:
        logger.error(f"Failed to cancel diarization job {job_id}: {e}")


def get_runpod_diarization(
    chunk_id: str,
) -> None:
    """
    Orchestrates the diarization process for a given chunk by submitting an audio diarization job to RunPod, polling for completion within a timeout, and updating Directus with the results or canceling the job if it times out.
    
    Args:
        chunk_id: The identifier of the audio chunk to process.
    """
    # Fetch chunk data
    chunk_data = _fetch_chunk_data(chunk_id)
    if not chunk_data:
        return None
    audio_file_uri, project_language = chunk_data

    # Generate signed URL
    audio_url = _generate_audio_url(audio_file_uri)
    if not audio_url:
        return None

    # Check if we should skip diarization
    if _should_skip_diarization(project_language):
        return None

    # Submit diarization job
    job_data = _submit_diarization_job(audio_url, project_language)
    if not job_data:
        return None
    job_id, job_status_link = job_data

    # Poll for job completion
    timeout = RUNPOD_DIARIZATION_TIMEOUT
    api_key = RUNPOD_DIARIZATION_API_KEY
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    
    start_time = time.time()
    while time.time() - start_time < timeout:
        response_data = _poll_job_status(job_status_link, headers)
        if response_data:
            status = response_data.get("status")
            logger.debug(f"Job {job_id} status: {status}")
            
            if status == "COMPLETED":
                dirz_response_data = response_data.get("output")
                if dirz_response_data:
                    logger.info(f"Diarization job {job_id} completed. Updating chunk {chunk_id} with results.")
                    _update_chunk_with_results(chunk_id, dirz_response_data)
                    return
                else:
                    logger.warning(f"Diarization job {job_id} completed but no output data received.")
                    return
        
        time.sleep(3)

    # Timeout: cancel the job
    _cancel_job_on_timeout(job_id)
    return None


def get_health_status(
    project_ids: list[str] | None = None,
    conversation_ids: list[str] | None = None,
    cross_talk_threshold: float = 1.0,
    noise_threshold: float = 0.5,
    silence_threshold: float = 0.8,
) -> dict[str, Any]:
    """
    Get the health status of conversations.
    """
    if not project_ids and not conversation_ids:
        raise ValueError("Either project_ids or conversation_ids must be provided")

    chunk_li = _get_timebound_conversation_chunks(project_ids, conversation_ids)
    df = pd.DataFrame(chunk_li)

    if df.empty:
        return {}

    df = _process_data(df)
    result = _calculate_conversation_metrics(
        df, cross_talk_threshold, noise_threshold, silence_threshold
    )
    return result


def _get_timebound_conversation_chunks(
    project_ids: list[str] | None = None,
    conversation_ids: list[str] | None = None,
    time_threshold_mins: int = 5,
    max_chunks_for_conversation: int = 2,
) -> list[dict[str, Any]]:
    """
    Get all chunks in a project for the last 5 minutes.
    """
    if not project_ids and not conversation_ids:
        raise ValueError("Either project_ids or conversation_ids must be provided")

    filter_dict: dict[str, Any] = {
        "timestamp": {
            "_gte": (get_utc_timestamp() - timedelta(minutes=time_threshold_mins)).isoformat()
        }
    }

    return_fields = [
        "conversation_id.id",
        "conversation_id.project_id",
        "noise_ratio",
        "cross_talk_instances",
        "silence_ratio",
        "timestamp",
    ]

    aggregated_response = []
    if project_ids:
        filter_dict["conversation_id"] = {}
        filter_dict["conversation_id"]["project_id"] = {"_in": project_ids}
        response = directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "filter": filter_dict,
                    "fields": return_fields,
                    "sort": ["-timestamp"],  # Sort by timestamp descending (newest first)
                },
            },
        )
        aggregated_response.extend(_flatten_response(response))
    if conversation_ids:
        filter_dict["conversation_id"] = {}
        filter_dict["conversation_id"]["id"] = {"_in": conversation_ids}
        response = directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "filter": filter_dict,
                    "fields": return_fields,
                    "sort": ["-timestamp"],  # Sort by timestamp descending (newest first)
                },
            },
        )
        try: 
            response = response[:max_chunks_for_conversation]
            aggregated_response.extend(_flatten_response(response))
        except Exception as e:
            logger.warning(f"Error fetching/flattening conversation chunks {e} : {response}")
    return aggregated_response


def _flatten_response(response: Any) -> list[dict[str, Any]]:
    flattened_response = []
    if isinstance(response, list):
        for item in response:
            if isinstance(item, dict):
                conversation_data = item.get("conversation_id", {})
                if isinstance(conversation_data, dict):
                    flattened_item = {
                        "conversation_id": conversation_data.get("id"),
                        "project_id": conversation_data.get("project_id"),
                        "noise_ratio": item.get("noise_ratio"),
                        "cross_talk_instances": item.get("cross_talk_instances"),
                        "silence_ratio": item.get("silence_ratio"),
                        "timestamp": item.get("timestamp"),
                    }
                    flattened_response.append(flattened_item)

    return flattened_response


def _process_data(df: pd.DataFrame) -> pd.DataFrame:
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    max_timestamp = df["timestamp"].max()
    df["time_diff_seconds"] = (max_timestamp - df["timestamp"]).dt.total_seconds()
    decay_factor = 30
    df["recency_weight"] = np.exp(-df["time_diff_seconds"] / decay_factor)
    df.drop(columns=["timestamp", "time_diff_seconds"], inplace=True)
    df = df[
        [
            "project_id",
            "conversation_id",
            "noise_ratio",
            "cross_talk_instances",
            "silence_ratio",
            "recency_weight",
        ]
    ]
    df.dropna(inplace=True)
    return df


def _calculate_conversation_metrics(
    df: pd.DataFrame, cross_talk_threshold: float, noise_threshold: float, silence_threshold: float
) -> dict[str, Any]:
    # Calculate conversation-level metrics (average of chunks within each conversation)
    conversation_metrics = (
        df.groupby(["project_id", "conversation_id"])
        .agg({"noise_ratio": "mean", "cross_talk_instances": "mean", "silence_ratio": "mean"})
        .reset_index()
    )

    def classify_conversation_issue(row: Any) -> str:
        if row["cross_talk_instances"] > cross_talk_threshold:
            return "HIGH_CROSSTALK"
        elif row["noise_ratio"] > noise_threshold:
            return "HIGH_NOISE"
        elif row["silence_ratio"] > silence_threshold:
            return "HIGH_SILENCE"
        else:
            return "NONE"

    conversation_metrics["conversation_issue"] = conversation_metrics.apply(
        classify_conversation_issue, axis=1
    )

    # Calculate project-level metrics (average of conversations within each project)
    project_metrics = (
        conversation_metrics.groupby("project_id")
        .agg({"noise_ratio": "mean", "cross_talk_instances": "mean", "silence_ratio": "mean"})
        .reset_index()
    )

    # Calculate global metrics (average of all projects)
    global_metrics = project_metrics.agg(
        {"noise_ratio": "mean", "cross_talk_instances": "mean", "silence_ratio": "mean"}
    )

    # Build the nested dictionary structure
    result: dict[str, Any] = {
        "global_noise_ratio": float(global_metrics["noise_ratio"]),
        "global_cross_talk_instances": float(global_metrics["cross_talk_instances"]),
        "global_silence_ratio": float(global_metrics["silence_ratio"]),
        "projects": {},
    }

    # Build projects dictionary
    projects_dict: dict[str, Any] = {}
    for _, project_row in project_metrics.iterrows():
        project_id = str(project_row["project_id"])
        projects_dict[project_id] = {
            "project_noise_ratio": float(project_row["noise_ratio"]),
            "project_cross_talk_instances": float(project_row["cross_talk_instances"]),
            "project_silence_ratio": float(project_row["silence_ratio"]),
            "conversations": {},
        }

        # Add conversations for this project
        conversations_dict: dict[str, Any] = {}
        project_conversations = conversation_metrics[
            conversation_metrics["project_id"] == project_row["project_id"]
        ]
        for _, conv_row in project_conversations.iterrows():
            conversation_id = str(conv_row["conversation_id"])
            conversations_dict[conversation_id] = {
                "conversation_noise_ratio": float(conv_row["noise_ratio"]),
                "conversation_cross_talk_instances": float(conv_row["cross_talk_instances"]),
                "conversation_silence_ratio": float(conv_row["silence_ratio"]),
                "conversation_issue": conv_row["conversation_issue"],
            }
        projects_dict[project_id]["conversations"] = conversations_dict
    result["projects"] = projects_dict
    return result
