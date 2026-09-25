-- What changed, so a screen can ask instead of being told.
--
-- Supabase had Realtime: the kitchen screen held a connection and the server pushed the names of the
-- tables that changed. This server holds no connections, and the app's REST client polls
-- `GET /open-orders?since=<cursor>` for the same four names (contracts/openapi.yaml, RealtimeTopic).
--
-- One row per shop and topic, stamped whenever a row of that topic changes. The answer carries no
-- data, only the names, exactly as the live version did: a screen that hears its topic re-reads what
-- it shows, so a missed poll or a repeated one costs a read and never a wrong screen.

create table private.shop_changes (
  shop_id uuid not null references public.shops (id) on delete cascade,
  topic text not null check (topic in ('open_orders', 'open_order_items', 'dining_tables', 'products')),
  changed_at timestamptz not null default clock_timestamp(),
  primary key (shop_id, topic)
);

-- clock_timestamp(), not now(): two writes in one transaction must not share a moment, or a poll
-- that lands between them would miss the second.
create or replace function private.note_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  insert into private.shop_changes (shop_id, topic, changed_at)
  values (v_row.shop_id, tg_argv[0], clock_timestamp())
  on conflict (shop_id, topic) do update set changed_at = excluded.changed_at;
  return null;
end;
$$;

create trigger open_orders_changed
  after insert or update or delete on public.open_orders
  for each row execute function private.note_change('open_orders');

create trigger open_order_items_changed
  after insert or update or delete on public.open_order_items
  for each row execute function private.note_change('open_order_items');

create trigger dining_tables_changed
  after insert or update or delete on public.dining_tables
  for each row execute function private.note_change('dining_tables');

create trigger products_changed
  after insert or update or delete on public.products
  for each row execute function private.note_change('products');

-- A member reads what changed in their own café and nowhere else.
alter table private.shop_changes enable row level security;
revoke all on private.shop_changes from public;
grant select on private.shop_changes to cafe_app;

create policy shop_changes_select on private.shop_changes
  for select to cafe_app
  using (shop_id = (select private.current_shop_id()));
