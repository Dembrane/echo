-- AI spend per UTC day, account, payer, operation and model, for dashboards. Safe to run twice.
create or replace view obs.day_ai_spend as select day, billing_account_id, payer, operation, model, calls, input_tokens, output_tokens, cost_micro_eur from public.ai_spend_daily;
