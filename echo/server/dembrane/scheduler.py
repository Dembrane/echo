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
scheduler.configure(
    jobstores=jobstores,
    timezone=utc,
    # The default 1s misfire_grace_time silently skips any run whose wakeup
    # lands late (routine on WSL2/loaded hosts); these jobs must run late, not never.
    job_defaults={"misfire_grace_time": 60, "coalesce": True},
)

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

scheduler.add_job(
    func="dembrane.tasks:task_check_scheduled_reports.send",
    trigger=CronTrigger(minute="*/5"),
    id="task_check_scheduled_reports",
    name="Check and dispatch scheduled report generation",
    replace_existing=True,
)

scheduler.add_job(
    func="dembrane.tasks:task_expire_workspace_tiers.send",
    trigger=CronTrigger(minute=0),
    id="task_expire_workspace_tiers",
    name="Downgrade workspaces with elapsed tier_expires_at to free",
    replace_existing=True,
)

scheduler.add_job(
    func="dembrane.tasks:task_send_tier_expiry_prewarning.send",
    trigger=CronTrigger(minute=0),
    id="task_send_tier_expiry_prewarning",
    name="Send 3-day pre-warning emails for expiring workspace tiers",
    replace_existing=True,
)

scheduler.add_job(
    func="dembrane.tasks:task_reconcile_pending_billing.send",
    trigger=CronTrigger(minute="*/5"),
    id="task_reconcile_pending_billing",
    name="Activate billing accounts whose first payment cleared (missed webhook/return)",
    replace_existing=True,
)

scheduler.add_job(
    func="dembrane.tasks:task_reconcile_subscription_seats.send",
    trigger=CronTrigger(minute="*/15"),
    id="task_reconcile_subscription_seats",
    name="Re-price active subscriptions to match live seat counts",
    replace_existing=True,
)

scheduler.add_job(
    func="dembrane.tasks:task_flush_email_digests.send",
    trigger=CronTrigger(hour=9, minute=0),
    id="task_flush_email_digests",
    name="Flush batched email notification digests",
    replace_existing=True,
)

logger = getLogger("dembrane.scheduler")

# Start the scheduler when this module is run directly
if __name__ == "__main__":
    logger.info("Starting scheduler")
    scheduler.start()
