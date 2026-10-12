ALTER TABLE "project" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "sample_version" varchar(64);