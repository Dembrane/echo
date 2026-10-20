-- Whisper's own sentences for each piece with times from the piece's start, and the piece's length:
-- an upload's improved transcript is built from them instead of sending the audio to Whisper again.
-- Null for pieces read by Gemini, for redacted pieces, and for pieces from before this column.
ALTER TABLE "conversation_chunk" ADD COLUMN IF NOT EXISTS "segments" jsonb;
