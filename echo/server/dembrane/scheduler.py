from logging import getLogger

from pytz import utc
from apscheduler.triggers.cron import CronTrigger
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.schedulers.blocking import BlockingScheduler

from dembrane.settings import get_settings

jobstores = {
    "default": MemoryJobStore(),
}

scheduler = BlockingScheduler()
scheduler.configure(jobstores=jobstores, timezone=utc)

settings = get_settings()
DEBUG_MODE = settings.feature_flags.debug_mode

# Add periodic tasks
scheduler.add_job(
    func="dembrane.tasks:task_collect_and_finish_unfinished_conversations.send",
    trigger=CronTrigger(minute="*/2"),
    id="task_collect_and_finish_unfinished_conversations",
    name="Collect and finish unfinished conversations",
    replace_existing=True,
)

scheduler.add_job(
    func="dembrane.tasks:task_reconcile_transcribed_flag.send",
    trigger=CronTrigger(minute="*/3"),
    id="task_reconcile_transcribed_flag",
    name="Reconcile is_all_chunks_transcribed flag",
    replace_existing=True,
)

scheduler.add_job(
    func="dembrane.tasks:task_catch_up_unsummarized_conversations.send",
    trigger=CronTrigger(minute="*/5"),
    id="task_catch_up_unsummarized_conversations",
    name="Catch up on unsummarized conversations",
    replace_existing=True,
)

logger = getLogger("dembrane.scheduler")

# Start the scheduler when this module is run directly
if __name__ == "__main__":
    logger.info("Starting scheduler")
    scheduler.start()
