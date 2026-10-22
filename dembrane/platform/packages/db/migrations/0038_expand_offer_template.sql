CREATE TABLE "offer_template" (
	"template" text NOT NULL,
	"language" text NOT NULL,
	"kind" text NOT NULL,
	"greeting" text NOT NULL,
	"intro" text NOT NULL,
	"closing" text NOT NULL,
	"columns" json NOT NULL,
	"valid_days" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "offer_template_template_language_pk" PRIMARY KEY("template","language"),
	CONSTRAINT "offer_template_template_check" CHECK ("offer_template"."template" in ('subscription', 'event', 'custom')),
	CONSTRAINT "offer_template_language_check" CHECK ("offer_template"."language" in ('en', 'nl'))
);
