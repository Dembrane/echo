from __future__ import annotations


def enqueue_agentic_run(
    *,
    run_id: str,
    project_id: str,
    user_message: str,
    bearer_token: str,
) -> None:
    from dembrane.tasks import task_execute_agentic_run

    task_execute_agentic_run.send(
        run_id=run_id,
        project_id=project_id,
        user_message=user_message,
        bearer_token=bearer_token,
    )
