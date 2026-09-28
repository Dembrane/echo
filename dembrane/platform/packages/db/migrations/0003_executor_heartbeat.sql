CREATE TABLE "dbos_executor_heartbeat" (
	"executor_id" text PRIMARY KEY NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
