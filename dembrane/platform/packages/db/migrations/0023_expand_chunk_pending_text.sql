-- Text a participant typed into an anonymised project, held only until the chunk run has
-- written its redacted form to transcript and cleared this. No reader selects it; null once
-- redaction ends, however it ends.
ALTER TABLE "conversation_chunk" ADD COLUMN "pending_text" text;
