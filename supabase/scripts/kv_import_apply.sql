-- The real legacy key-value import. Run once, after the dry run has been reviewed, in a moment when
-- nobody is selling through the old app (docs/runbooks/kv-import.md). It freezes the key-value table
-- first, in the same transaction, so nothing written by the old edge function can be lost.
begin;

create or replace function migration.kv_store_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'KV_FROZEN: the legacy key-value store is read-only after the import';
end;
$$;

drop trigger if exists kv_store_frozen on public.kv_store_81f0b18a;
create trigger kv_store_frozen
  before insert or update or delete on public.kv_store_81f0b18a
  for each statement execute function migration.kv_store_frozen();

select kv_key, outcome, reason, raw
from migration.kv_import('<shop-id>'::uuid, false)
order by outcome <> 'rejected', outcome, kv_key;

commit;
