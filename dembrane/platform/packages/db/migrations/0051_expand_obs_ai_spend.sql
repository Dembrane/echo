-- obs.ai_spend (cost per UTC day, account, operation, model, provider, with feature names) and obs.ai_call_quality (price and usage flags). Safe to run twice.
create or replace view obs.ai_spend as
with rolled as (
	select distinct day from public.ai_spend_daily
), spend as (
	select s.day, s.billing_account_id, s.payer, s.operation, s.model,
		coalesce((select min(p.provider) from public.ai_price p where p.model = s.model
			having count(distinct p.provider) = 1), 'unknown') as provider,
		s.calls::bigint as calls, s.input_tokens, s.output_tokens, s.cost_micro_eur
	from public.ai_spend_daily s
	union all
	select (m.started_at at time zone 'UTC')::date, m.billing_account_id, m.payer,
		coalesce(m.operation, ''), m.model, coalesce(m.provider, 'unknown'), count(*),
		coalesce(sum(m.input_tokens), 0), coalesce(sum(m.output_tokens), 0),
		coalesce(sum(m.cost_micro_eur), 0)
	from public.model_call m
	where (m.started_at at time zone 'UTC')::date not in (select day from rolled)
	group by 1, 2, 3, 4, 5, 6
), grouped as (
	select day, billing_account_id, payer, operation, model, provider,
		sum(calls)::bigint as calls, sum(input_tokens)::bigint as input_tokens,
		sum(output_tokens)::bigint as output_tokens, sum(cost_micro_eur)::bigint as cost_micro_eur
	from spend group by day, billing_account_id, payer, operation, model, provider
)
select g.day, g.billing_account_id, g.payer, g.operation, f.feature_group, f.group_label, f.feature,
	g.model, g.provider, g.calls, g.input_tokens, g.output_tokens, g.cost_micro_eur
from grouped g cross join lateral obs.ai_feature(g.operation) f;
--> statement-breakpoint
comment on view obs.ai_spend is 'AI cost per UTC day, account, payer, operation, model and provider. Rolled days come from ai_spend_daily, the rest from model_call. Feature names come from obs.ai_feature, which reads the backend rules.';
--> statement-breakpoint
create or replace view obs.ai_call_quality as
select (started_at at time zone 'UTC')::date as day, model, count(*) as calls,
	count(*) filter (where price_missing) as price_missing_calls,
	count(*) filter (where usage_estimated) as usage_estimated_calls
from public.model_call
group by 1, 2;
--> statement-breakpoint
comment on view obs.ai_call_quality is 'Calls per UTC day and model with no price found or with estimated token usage. Only as far back as model_call is kept.';
