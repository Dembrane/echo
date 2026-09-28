-- Unlogged: presence is disposable and rewritten by the next ping; skipping the WAL keeps pings cheap.
CREATE UNLOGGED TABLE "platform_presence" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"data" jsonb,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_presence_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE INDEX "platform_presence_scope_idx" ON "platform_presence" USING btree ("kind","scope","seen_at");--> statement-breakpoint
CREATE INDEX "platform_presence_expires_idx" ON "platform_presence" USING btree ("expires_at");