-- obs.ai_unrolled_days(), obs.ai_spend_base (cost per UTC day, account, operation, model, provider), obs.ai_spend (the same with feature names), obs.ai_call_quality (price and usage flags) and obs.ai_call_gaps (calls with no payer or no operation). Safe to run twice.
-- Security definer like obs.ai_feature, and a row estimate, so plans stay small (a bare generate_series counts as 1000 days).
CREATE OR REPLACE FUNCTION obs.ai_unrolled_days() RETURNS SETOF date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp ROWS 3 AS $$
	SELECT g.day::date FROM (SELECT min(started_at), max(started_at) FROM public.model_call) b(first_at, last_at)
	CROSS JOIN generate_series((b.first_at AT TIME ZONE 'UTC')::date, (b.last_at AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
	WHERE NOT EXISTS (SELECT 1 FROM public.ai_spend_daily s WHERE s.day = g.day::date)
$$;
--> statement-breakpoint
comment on function obs.ai_unrolled_days() is 'UTC days with model calls and no ai_spend_daily rows yet; their cost is read from model_call.';
--> statement-breakpoint
-- A day is either rolled or unrolled and ai_spend_daily is unique per key, so no row needs merging.
create or replace view obs.ai_spend_base as
with sole_provider as (
	select model, min(provider) as provider from public.ai_price
	group by model having count(distinct provider) = 1
)
select s.day, s.billing_account_id, s.payer, s.operation, s.model,
	coalesce(p.provider, 'unknown') as provider, s.calls::bigint as calls,
	s.input_tokens, s.output_tokens, s.cost_micro_eur
from public.ai_spend_daily s
left join sole_provider p on p.model = s.model
union all
select u.day, m.billing_account_id, m.payer, coalesce(m.operation, ''), m.model,
	coalesce(m.provider, 'unknown'), count(*), coalesce(sum(m.input_tokens), 0)::bigint,
	coalesce(sum(m.output_tokens), 0)::bigint, coalesce(sum(m.cost_micro_eur), 0)::bigint
from obs.ai_unrolled_days() u(day)
join public.model_call m on m.started_at >= u.day::timestamp at time zone 'UTC'
	and m.started_at < (u.day + 1)::timestamp at time zone 'UTC'
group by 1, 2, 3, 4, 5, 6;
--> statement-breakpoint
comment on view obs.ai_spend_base is 'AI cost per UTC day, account, payer, operation, model and provider, without feature names. Rolled days come from ai_spend_daily, the rest from model_call. A filter on day reads only those days.';
--> statement-breakpoint
-- It returns one row; the planner assumes 1000 otherwise.
alter function obs.ai_feature(text) rows 1;
--> statement-breakpoint
-- Names each operation once, not each row; base is read once, so a filter on day still reaches its tables.
create or replace view obs.ai_spend as
with operations as (
	select operation from public.ai_spend_daily group by operation
	union
	select coalesce(m.operation, '') from obs.ai_unrolled_days() u(day)
	join public.model_call m on m.started_at >= u.day::timestamp at time zone 'UTC'
		and m.started_at < (u.day + 1)::timestamp at time zone 'UTC'
	group by 1
), named as materialized (
	select o.operation, f.feature_group, f.group_label, f.feature
	from operations o cross join lateral obs.ai_feature(o.operation) f
)
select b.day, b.billing_account_id, b.payer, b.operation, n.feature_group, n.group_label, n.feature,
	b.model, b.provider, b.calls, b.input_tokens, b.output_tokens, b.cost_micro_eur
from obs.ai_spend_base b join named n on n.operation = b.operation;
--> statement-breakpoint
comment on view obs.ai_spend is 'obs.ai_spend_base with feature names from obs.ai_feature, which reads the backend rules. Sums that need no names are faster on obs.ai_spend_base.';
--> statement-breakpoint
create or replace view obs.ai_call_quality as
select (started_at at time zone 'UTC')::date as day, model, count(*) as calls,
	count(*) filter (where price_missing) as price_missing_calls,
	count(*) filter (where usage_estimated) as usage_estimated_calls
from public.model_call
group by 1, 2;
--> statement-breakpoint
comment on view obs.ai_call_quality is 'Calls per UTC day and model with no price found or with estimated token usage. Only as far back as model_call is kept.';
--> statement-breakpoint
-- The window is on started_at, so the started_at index is used.
create or replace view obs.ai_call_gaps as
select (started_at at time zone 'UTC')::date as day, payer, service, coalesce(operation, '') as operation,
	model_group, kind, model, count(*) as calls, coalesce(sum(cost_micro_eur), 0)::bigint as cost_micro_eur
from public.model_call
where started_at >= now() - interval '30 days'
	and (payer = 'unattributed' or coalesce(operation, '') = '')
group by 1, 2, 3, 4, 5, 6, 7;
--> statement-breakpoint
comment on view obs.ai_call_gaps is 'Calls of the last 30 days with no payer (unattributed) or no operation, per UTC day, payer, service, operation, model group, kind and model, so the code path that made them can be found. Names and numbers only.';
