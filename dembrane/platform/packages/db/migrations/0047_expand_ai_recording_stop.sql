-- No-op: its conversation column moved to 0048, so the one-transaction run takes no hot
-- lock before billing_account's. Kept so the journal stays in order. Safe to run twice.
SELECT 1;
