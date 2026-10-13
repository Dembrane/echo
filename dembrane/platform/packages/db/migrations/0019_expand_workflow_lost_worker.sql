-- How often an unfinished workflow was running on a worker that stopped, and when recovery
-- set it aside instead of resuming it. Written and cleaned by the recovery sweep in
-- packages/queue; queue_name is kept here because DBOS clears its own on a cancelled workflow.
CREATE TABLE "dbos_workflow_lost_worker" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"queue_name" text,
	"lost" integer NOT NULL,
	"set_aside_at" timestamp with time zone
);
