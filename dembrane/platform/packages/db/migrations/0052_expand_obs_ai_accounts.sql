-- obs.ai_accounts: per billing account budget, override and this period's spend, as the staff AI costs panel judges it at now(). Safe to run twice.
CREATE INDEX IF NOT EXISTS "ai_spend_daily_billing_account_idx" ON "ai_spend_daily" USING btree ("billing_account_id");
--> statement-breakpoint
create or replace view obs.ai_accounts as
with clock as (
	select (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') as month_start,
		((date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC') as month_end
), unrolled_accounts as (
	select distinct m.billing_account_id as id
	from obs.ai_unrolled_days() u(day)
	join public.model_call m on m.started_at >= u.day::timestamp at time zone 'UTC'
		and m.started_at < (u.day + 1)::timestamp at time zone 'UTC'
	where m.billing_account_id is not null
), base as (
	select b.id, b.tier, b.deleted_at is not null as deleted,
		case when b.org_id is not null then 'organisation'
			when b.workspace_id is not null then 'workspace' end as account_scope,
		regexp_replace(coalesce(o.name, w.name, nullif(b.label, ''), ''),
			'[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '[email withheld]', 'g') as name,
		b.ai_budget_micro_eur as override_amount, b.ai_budget_unlimited as override_unlimited,
		b.ai_budget_until as override_until, b.downgraded_at, c.month_start, c.month_end,
		(b.ai_budget_until is null or b.ai_budget_until > now()) as active,
		-- Free, unless downgraded from a later month.
		(b.tier = 'free' and coalesce(b.downgraded_at < c.month_end, true)) as free
	from public.billing_account b
	cross join clock c
	left join public.org o on o.id = b.org_id
	left join public.workspace w on w.id = b.workspace_id
	where exists (select 1 from public.ai_spend_daily s where s.billing_account_id = b.id)
		or b.id in (select id from unrolled_accounts)
		or b.ai_budget_micro_eur is not null or b.ai_budget_unlimited
), judged as (
	select base.*, (active and override_unlimited) as unlimited,
		case when tier = 'free' and downgraded_at > month_start and downgraded_at <= now()
			then downgraded_at else month_start end as period_start
	from base
), spent as (
	select j.*, coalesce((select u.amount from public.free_usage u
		-- AI_SPEND_KEY of @dembrane/allowance; compared to the millisecond, as the staff API does.
		where u.billing_account_id = j.id and u.key = 'ai_spend_micro_eur'
			and date_trunc('milliseconds', u.period_start) = date_trunc('milliseconds', j.period_start)), 0)::bigint as spend
	from judged j
), budgeted as (
	select s.*, case when free and not unlimited then
		case when active and override_amount is not null then override_amount
			-- 5000000 is FREE_LIMIT_DEFAULTS.ai_budget_micro_eur, used when no tier_limit row exists.
			else coalesce((select t.value from public.tier_limit t
				where t.tier = 'free' and t.key = 'ai_budget_micro_eur'), 5000000) end
	end as budget
	from spent s
)
select id as billing_account_id, name, tier, account_scope, deleted,
	budget as budget_micro_eur,
	(budget is not null and active and override_amount is not null) as custom_budget,
	unlimited,
	case when override_unlimited or override_amount is not null then override_until end as override_until,
	period_start, spend as period_spend_micro_eur,
	case when budget is null then null
		when budget <= 0 then 100
		else floor(spend * 100.0 / budget)::int end as percent_used
from budgeted;
--> statement-breakpoint
comment on view obs.ai_accounts is 'AI budget, override and spend this period per billing account, judged at now() like the staff AI costs panel. Names have emails withheld. Includes accounts with a budget override and no spend.';
--> statement-breakpoint
comment on schema obs is 'Aggregate views for dashboards: counts, durations and sizes per Amsterdam day, and AI cost per UTC day. Never message text, transcripts or prompts. obs.ai_accounts shows billing account names (organisation, workspace or label, as entered, so possibly a person''s name) with email addresses withheld. Operations grant a read-only role (grafana_obs) this schema and nothing else, with default privileges so later views are covered.';
