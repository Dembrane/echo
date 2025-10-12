from pytz import utc
from apscheduler.triggers.cron import CronTrigger
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.schedulers.blocking import BlockingScheduler

# from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from dembrane.config import DEBUG_MODE, TRANSCRIPTION_PROVIDER

# from dembrane.config import DATABASE_URL

jobstores = {
    # "default": SQLAlchemyJobStore(url=DATABASE_URL),
    "default": MemoryJobStore(),
}

scheduler = BlockingScheduler()
scheduler.configure(jobstores=jobstores, timezone=utc)

# Add periodic tasks
scheduler.add_job(
    func="dembrane.tasks:task_collect_and_finish_unfinished_conversations.send",
    trigger=CronTrigger(minute="*/1"),
    id="task_collect_and_finish_unfinished_conversations",
    name="Collect and finish unfinished conversations",
    replace_existing=True,
)

if TRANSCRIPTION_PROVIDER is not None and "runpod" in TRANSCRIPTION_PROVIDER.lower():
    if DEBUG_MODE:
        trigger = CronTrigger(minute="*/2")
    else:
        trigger = CronTrigger(minute="*/10")

    scheduler.add_job(
        func="dembrane.tasks:task_update_runpod_transcription_response.send",
        trigger=trigger,
        id="task_update_runpod_transcription_response",
        name="update runpod transcription responses",
        replace_existing=True,
    )

# Start the scheduler when this module is run directly
if __name__ == "__main__":
    scheduler.start()
