-- What a large popcorn session's tensions keep between reads: positions per conversation,
-- the pairs found and their verdicts, one row per loop. Apart from agent_loop so the deck's
-- frequent reads and writes never carry it. Written only by the popcorn tick.
CREATE TABLE "popcorn_tensions_cache" (
	"loop_id" uuid PRIMARY KEY NOT NULL,
	"cache" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
