-- The Figma Make edge function kept all data in this key-value table, created by hand in the hosted
-- project. Creating it here as well (a no-op there) lets every later migration and the KV import
-- run locally and in CI. Only the service role may touch it.
create table if not exists public.kv_store_81f0b18a (
  key text primary key,
  value jsonb not null
);

alter table public.kv_store_81f0b18a enable row level security;
revoke all on table public.kv_store_81f0b18a from anon, authenticated;
