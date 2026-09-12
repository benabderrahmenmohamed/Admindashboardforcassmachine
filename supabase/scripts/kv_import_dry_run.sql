-- Dry run of the legacy key-value import. Safe to run at any time: every write is rolled back.
-- Replace the shop id, run it in the Supabase SQL editor, then export the result as CSV: that export
-- is the rejects file to review (docs/runbooks/kv-import.md).
begin;

select kv_key, outcome, reason, raw
from migration.kv_import('<shop-id>'::uuid, true)
order by outcome <> 'rejected', outcome, kv_key;

rollback;
