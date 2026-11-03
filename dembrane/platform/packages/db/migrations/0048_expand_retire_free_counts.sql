-- The AI budget replaces the free chat, report, map and popcorn counts; their ledger rows and limits go. Safe to run twice.
DELETE FROM "free_usage" WHERE "key" IN ('chats', 'reports', 'maps', 'popcorn_analyses');--> statement-breakpoint
DELETE FROM "tier_limit" WHERE "tier" = 'free' AND "key" IN ('chats_month', 'chat_turns_per_chat', 'reports_month', 'maps_month', 'popcorn_analyses_month');
