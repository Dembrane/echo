-- Structural fingerprint of the public schema: columns, indexes, constraints, triggers,
-- functions, sequences and views, one sorted line each. Two databases with the same
-- fingerprint have the same schema, whatever tool built them.
select 'column', table_name||'.'||column_name||' '||data_type||coalesce('('||character_maximum_length||')','')||' null='||is_nullable||' default='||coalesce(column_default,'') from information_schema.columns where table_schema='public'
union all select 'index', tablename||' '||indexdef from pg_indexes where schemaname='public'
union all select 'constraint', conrelid::regclass::text||' '||contype::text||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
union all select 'trigger', tgrelid::regclass::text||' '||tgname from pg_trigger where not tgisinternal
union all select 'function', proname from pg_proc where pronamespace='public'::regnamespace and not exists (select 1 from pg_depend d where d.objid=pg_proc.oid and d.deptype='e')
union all select 'sequence', sequencename from pg_sequences where schemaname='public'
union all select 'view', viewname from pg_views where schemaname='public'
order by 1,2;
