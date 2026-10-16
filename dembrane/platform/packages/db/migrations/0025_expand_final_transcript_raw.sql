-- Whisper's sentences as they were before the text pass changed them, so every edit stays visible and reversible.
-- Null when the pass changed nothing, was off, or the text was redacted.
ALTER TABLE "conversation_final_transcript" ADD COLUMN IF NOT EXISTS "raw_sentences" jsonb;
