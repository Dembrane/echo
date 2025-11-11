from pytz import utc
from apscheduler.triggers.cron import CronTrigger
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.schedulers.blocking import BlockingScheduler

# from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from dembrane.settings import get_settings

jobstores = {
    # "default": SQLAlchemyJobStore(url=DATABASE_URL),
    "default": MemoryJobStore(),
}

scheduler = BlockingScheduler()
scheduler.configure(jobstores=jobstores, timezone=utc)

settings = get_settings()
DEBUG_MODE = settings.feature_flags.debug_mode

# Add periodic tasks
scheduler.add_job(
    func="dembrane.tasks:task_collect_and_finish_unfinished_conversations.send",
    trigger=CronTrigger(minute="*/1"),
    id="task_collect_and_finish_unfinished_conversations",
    name="Collect and finish unfinished conversations",
    replace_existing=True,
)

# Start the scheduler when this module is run directly
if __name__ == "__main__":
    scheduler.start()
