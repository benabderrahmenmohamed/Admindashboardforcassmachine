-- The café model (docs/spec.md v3): four roles, dining tables, open orders as working state, a
-- kitchen, and payment against order items.
--
-- Migrations 1-9 built a counter-service shop: one role per member, a product with a single `stock`
-- column, and a sale that named products directly. This migration reshapes those tables and adds
-- the three new ones. Nothing here is dropped that a receipt points at: the ledger keeps every row
-- it had, and the columns that moved were renamed, never re-created, so no history is lost.

-- ---------------------------------------------------------------------------------------------
-- Roles. A member holds several: the owner is an admin who also works the counter, so roles is an
-- array and every check asks "does this member hold any of these roles".
alter table public.profiles add column roles text[];
update public.profiles set roles = array[role];
alter table public.profiles
  alter column roles set not null,
  -- cardinality, not array_length: an empty array gives 0 here and null there, and a check
  -- constraint lets null through.
  add constraint profiles_roles_known check (
    cardinality(roles) >= 1 and roles <@ array['admin', 'cashier', 'waiter', 'kitchen']
  );
alter table public.profiles drop column role;

-- Replaces private.current_app_role(): a member can be an admin and something else at once.
create or replace function private.current_roles()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select p.roles from public.profiles p where p.user_id = auth.uid()
$$;

create or replace function private.current_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce('admin' = any (p.roles), false) from public.profiles p where p.user_id = auth.uid()
$$;

grant execute on function private.current_roles(), private.current_is_admin() to authenticated;

-- The policies of migration 20260911000008 that asked for a single role.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    shop_id = (select private.current_shop_id())
    and (user_id = (select auth.uid()) or (select private.current_is_admin()))
  );

drop policy categories_insert on public.categories;
create policy categories_insert on public.categories
  for insert to authenticated
  with check (shop_id = (select private.current_shop_id()) and (select private.current_is_admin()));

drop policy categories_delete on public.categories;
create policy categories_delete on public.categories
  for delete to authenticated
  using (shop_id = (select private.current_shop_id()) and (select private.current_is_admin()));

drop policy shop_settings_update on public.shop_settings;
create policy shop_settings_update on public.shop_settings
  for update to authenticated
  using (shop_id = (select private.current_shop_id()) and (select private.current_is_admin()))
  with check (shop_id = (select private.current_shop_id()));

drop policy legacy_orders_select on public.legacy_orders;
create policy legacy_orders_select on public.legacy_orders
  for select to authenticated
  using (shop_id = (select private.current_shop_id()) and (select private.current_is_admin()));

drop function private.current_app_role();

-- The first statement of every RPC. A member holding any of p_roles passes.
create or replace function private.require_profile(p_roles text[] default array['admin', 'cashier'])
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  if auth.uid() is null then
    perform private.raise_error('UNAUTHENTICATED', 'Sign in to continue.');
  end if;
  select * into v_profile from public.profiles where user_id = auth.uid();
  if not found then
    perform private.raise_error('FORBIDDEN', 'This account is not a member of any shop.');
  end if;
  if not (v_profile.roles && p_roles) then
    perform private.raise_error('FORBIDDEN', 'Your role cannot do this.', jsonb_build_object('roles', v_profile.roles));
  end if;
  return v_profile;
end;
$$;

-- Every role signs in, so this one accepts all four; each RPC states its own.
create or replace function public.my_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_email text;
begin
  v_profile := private.require_profile(array['admin', 'cashier', 'waiter', 'kitchen']);
  select u.email into v_email from auth.users u where u.id = v_profile.user_id;
  return jsonb_build_object(
    'user_id', v_profile.user_id,
    'shop_id', v_profile.shop_id,
    'roles', to_jsonb(v_profile.roles),
    'display_name', v_profile.display_name,
    'email', coalesce(v_email, '')
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Menu. `available` becomes `is_available` (on the menu right now, a daily toggle) and `stock`
-- becomes `stock_qty`, the maintained cache of the movement log. `track_stock` is new and off by
-- default: most café items are made to order and counting them is noise. Rows that already carry
-- stock keep being counted, so an imported shop behaves exactly as it did yesterday.
alter table public.products rename column available to is_available;
alter table public.products rename column stock to stock_qty;
alter table public.products add column track_stock boolean not null default false;
update public.products set track_stock = true where stock_qty <> 0;

create or replace function private.move_stock(
  p_shop_id uuid,
  p_product_id uuid,
  p_delta integer,
  p_reason text,
  p_sale_id uuid,
  p_note text,
  p_actor uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stock integer;
begin
  if p_delta <> 0 then
    insert into public.stock_movements (shop_id, product_id, delta, reason, sale_id, note, created_by)
    values (p_shop_id, p_product_id, p_delta, p_reason, p_sale_id, coalesce(p_note, ''), p_actor);
    update public.products set stock_qty = stock_qty + p_delta
    where id = p_product_id and shop_id = p_shop_id
    returning stock_qty into v_stock;
  else
    select stock_qty into v_stock from public.products where id = p_product_id and shop_id = p_shop_id;
  end if;
  return v_stock;
end;
$$;

create or replace function private.product_json(v public.products)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.id,
    'name', v.name,
    'price_millimes', v.price_millimes,
    'category_id', v.category_id,
    'category_name', (select c.name from public.categories c where c.id = v.category_id),
    'barcode', coalesce(v.barcode, ''),
    'description', v.description,
    'image_url', v.image_url,
    'stock_qty', v.stock_qty,
    'track_stock', v.track_stock,
    'is_available', v.is_available,
    'created_at', v.created_at,
    'updated_at', v.updated_at
  )
$$;

-- migration.kv_import names products.available in one INSERT. Restating two hundred lines of import
-- logic here would leave two copies to keep in step, so rewrite that one identifier in the stored
-- definition instead. The block refuses to run quietly if the text it expects has moved.
do $$
declare
  v_src text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(p.oid) into v_src
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'migration' and p.proname = 'kv_import';
  if v_src is null then
    raise exception 'migration.kv_import is missing';
  end if;
  v_new := replace(v_src, 'image_url, available,', 'image_url, is_available,');
  if v_new = v_src then
    raise exception 'migration.kv_import no longer inserts products.available: update this migration';
  end if;
  execute v_new;
end;
$$;

-- Admin-only, and the toggle waiters use too: an item that ran out leaves the menu without anyone
-- touching prices. Availability is not stock: an untracked product is simply on or off.
create or replace function public.set_product_availability(p_product_id uuid, p_is_available boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_product public.products;
begin
  v_profile := private.require_profile(array['admin', 'cashier', 'waiter']);
  update public.products
  set is_available = coalesce(p_is_available, true), updated_at = now()
  where id = p_product_id and shop_id = v_profile.shop_id and archived_at is null
  returning * into v_product;
  if not found then
    perform private.raise_error('NOT_FOUND', 'The product does not exist.', jsonb_build_object('product_id', p_product_id));
  end if;
  return private.product_json(v_product);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables, orders and items.
create table public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null default private.current_shop_id() references public.shops (id) on delete restrict,
  name text not null check (length(trim(name)) > 0),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, shop_id),
  unique (shop_id, name)
);
create index dining_tables_shop_id_idx on public.dining_tables (shop_id, sort_order);

-- Working state, not the ledger. An order is created lazily by order_item_add when the first item
-- lands on a free table, so two devices adding to the same table never race on creating one; the
-- partial unique index below is what makes "the table's open order" a single row.
create table public.open_orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete restrict,
  table_id uuid not null,
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_reason text,
  unique (id, shop_id),
  foreign key (table_id, shop_id) references public.dining_tables (id, shop_id) on delete restrict,
  constraint open_orders_closed_fields check (
    (status = 'open' and closed_at is null and closed_reason is null)
    or (status = 'closed' and closed_at is not null and closed_reason is null)
    or (status = 'cancelled' and closed_at is not null and length(trim(coalesce(closed_reason, ''))) > 0)
  )
);
create unique index open_orders_one_open_per_table on public.open_orders (table_id) where status = 'open';
create index open_orders_shop_status_idx on public.open_orders (shop_id, status);

-- One line on a table. The name and the price are copied when the item is added, so a later price
-- change never moves what a guest already ordered. A removed item keeps its row: the admin's report
-- of items removed after they were sent is the point.
--
-- `id` is the add record's own id, so a replayed add answers with the item it already created and a
-- device can show the item under its final id the instant a waiter taps it.
create table public.open_order_items (
  id uuid primary key,
  shop_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  name_snapshot text not null,
  unit_price_millimes bigint not null check (unit_price_millimes >= 0 and unit_price_millimes <= 1000000000000),
  qty integer not null check (qty >= 1),
  note text not null default '',
  device_id text not null default '',
  added_by uuid not null references auth.users (id) on delete restrict,
  added_at timestamptz not null,
  received_at timestamptz not null default now(),
  sent_at timestamptz,
  prepared_at timestamptz,
  removed_at timestamptz,
  removed_by uuid references auth.users (id) on delete restrict,
  removed_reason text,
  paid_sale_id uuid,
  unique (id, shop_id),
  foreign key (order_id, shop_id) references public.open_orders (id, shop_id) on delete restrict,
  foreign key (product_id, shop_id) references public.products (id, shop_id) on delete restrict,
  foreign key (paid_sale_id, shop_id) references public.sales (id, shop_id) on delete restrict,
  constraint open_order_items_removed_fields check (
    (removed_at is null and removed_by is null and removed_reason is null)
    or (removed_at is not null and removed_by is not null and length(trim(coalesce(removed_reason, ''))) > 0)
  ),
  constraint open_order_items_prepared_after_sent check (prepared_at is null or sent_at is not null),
  -- A paid item is never a removed one: record_sale refuses a line that names a removed item.
  constraint open_order_items_paid_is_active check (paid_sale_id is null or removed_at is null)
);
create index open_order_items_order_id_idx on public.open_order_items (order_id);
create index open_order_items_kitchen_idx on public.open_order_items (shop_id, sent_at)
  where sent_at is not null and prepared_at is null and removed_at is null;
create index open_order_items_removed_after_sent_idx on public.open_order_items (shop_id, removed_at)
  where removed_at is not null and sent_at is not null;
create index open_order_items_paid_sale_id_idx on public.open_order_items (paid_sale_id)
  where paid_sale_id is not null;

-- Idempotency for the order and stock RPCs, the same id + payload_hash rule record_sale applies to
-- the ledger: the same id with the same hash replays its stored result, a different hash is a
-- conflict, and another shop's id is never readable.
create table public.order_records (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete restrict,
  kind text not null check (kind in (
    'order_item_add', 'order_item_remove', 'order_send', 'order_item_prepare', 'order_cancel', 'stock_adjustment'
  )),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  device_id text not null default '',
  submitted_by uuid not null references auth.users (id) on delete restrict,
  result jsonb not null,
  created_at timestamptz not null,
  received_at timestamptz not null default now()
);
create index order_records_shop_id_idx on public.order_records (shop_id, received_at desc);

-- ---------------------------------------------------------------------------------------------
-- The ledger learns about tables and order items.
alter table public.sales add column table_id uuid;
alter table public.sales
  add constraint sales_table_id_fkey foreign key (table_id, shop_id)
    references public.dining_tables (id, shop_id) on delete restrict;
-- `discount_millimes` was always the cart discount; the café model says so in the name, because a
-- line now carries a discount of its own.
alter table public.sales rename column discount_millimes to cart_discount_millimes;

-- A line needs an identity of its own: a refund line points at the line it refunds instead of
-- repeating its number, and an order item points at the line that paid it.
alter table public.sale_lines add column id uuid not null default gen_random_uuid();
alter table public.sale_lines add constraint sale_lines_id_key unique (id);
alter table public.sale_lines rename column cart_discount_share_millimes to allocated_discount_millimes;
alter table public.sale_lines add column line_discount_reason text;
alter table public.sale_lines add column open_order_item_id uuid;
alter table public.sale_lines add column refunds_sale_line_id uuid;

-- Old refund rows named a line number. Point them at the line itself before the column goes, so
-- every row written before the café model still reads back the same way. The ledger triggers of
-- migration 20260911000008 refuse an UPDATE without this switch, which is turned off again on the
-- next line: a migration is not always one transaction, so this one is set for the session.
select set_config('pos.ledger_maintenance', 'on', false);
update public.sale_lines l
set refunds_sale_line_id = o.id
from public.sales s
join public.sale_lines o on o.sale_id = s.refunds_sale_id
where s.id = l.sale_id and l.refunds_line_no is not null and o.line_no = l.refunds_line_no;
select set_config('pos.ledger_maintenance', 'off', false);

alter table public.sale_lines drop column refunds_line_no;

alter table public.sale_lines
  add constraint sale_lines_open_order_item_fkey foreign key (open_order_item_id, shop_id)
    references public.open_order_items (id, shop_id) on delete restrict,
  add constraint sale_lines_refunds_sale_line_fkey foreign key (refunds_sale_line_id)
    references public.sale_lines (id) on delete restrict;
-- An order item is paid once and once only.
create unique index sale_lines_open_order_item_key on public.sale_lines (open_order_item_id)
  where open_order_item_id is not null;
create index sale_lines_refunds_sale_line_id_idx on public.sale_lines (refunds_sale_line_id)
  where refunds_sale_line_id is not null;

-- Dropping refunds_line_no took the old shape constraint with it, because it named that column.
alter table public.sale_lines drop constraint if exists sale_lines_shape;
alter table public.sale_lines add constraint sale_lines_shape check (
  (
    qty > 0 and refunds_sale_line_id is null
    and line_discount_millimes + allocated_discount_millimes <= qty * unit_price_millimes
    and line_total_millimes = qty * unit_price_millimes - line_discount_millimes - allocated_discount_millimes
  )
  or (
    qty < 0 and refunds_sale_line_id is not null and open_order_item_id is null
    and line_discount_millimes = 0 and allocated_discount_millimes = 0 and line_total_millimes <= 0
  )
);
-- An offered item or a discounted line always says why. Rows written before the café model carry no
-- line discount at all, so they satisfy this as they stand.
alter table public.sale_lines add constraint sale_lines_discount_reason check (
  line_discount_millimes = 0 or length(trim(coalesce(line_discount_reason, ''))) > 0
);

-- ---------------------------------------------------------------------------------------------
-- Row-level security and privileges, in the shape of migration 20260911000008: members read their
-- shop's rows, the admin edits the table plan, and every other write goes through an RPC.
alter table public.dining_tables enable row level security;
alter table public.open_orders enable row level security;
alter table public.open_order_items enable row level security;
alter table public.order_records enable row level security;

revoke all on public.dining_tables, public.open_orders, public.open_order_items, public.order_records
from anon, authenticated;

grant select on public.dining_tables, public.open_orders, public.open_order_items, public.order_records
to authenticated;

grant insert (name, sort_order, is_active) on public.dining_tables to authenticated;
grant update (name, sort_order, is_active) on public.dining_tables to authenticated;
grant delete on public.dining_tables to authenticated;

create policy dining_tables_select on public.dining_tables
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy dining_tables_insert on public.dining_tables
  for insert to authenticated
  with check (shop_id = (select private.current_shop_id()) and (select private.current_is_admin()));

create policy dining_tables_update on public.dining_tables
  for update to authenticated
  using (shop_id = (select private.current_shop_id()) and (select private.current_is_admin()))
  with check (shop_id = (select private.current_shop_id()));

-- A table an order ever touched is kept by the foreign keys; deleting is for a table plan the admin
-- is still drawing.
create policy dining_tables_delete on public.dining_tables
  for delete to authenticated
  using (shop_id = (select private.current_shop_id()) and (select private.current_is_admin()));

create policy open_orders_select on public.open_orders
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy open_order_items_select on public.open_order_items
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy order_records_select on public.order_records
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

revoke all on function public.my_profile(), public.set_product_availability(uuid, boolean) from public, anon;
grant execute on function public.my_profile(), public.set_product_availability(uuid, boolean) to authenticated;

-- Live updates (RealtimePort): the waiter, kitchen and caisse screens all follow these four tables.
-- The publication exists only where Supabase Realtime is installed, so this is a no-op elsewhere,
-- and replica identity full makes an update carry the row that changed.
alter table public.dining_tables replica identity full;
alter table public.open_orders replica identity full;
alter table public.open_order_items replica identity full;
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.dining_tables, public.open_orders, public.open_order_items, public.products';
  end if;
end;
$$;

revoke all on all functions in schema private from public, anon;
grant execute on function private.current_shop_id(), private.current_roles(), private.current_is_admin() to authenticated;
