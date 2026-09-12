-- Row-level security and privileges, kept together so they can be reviewed in one place.
--
-- Members of a shop read that shop's rows. The write paths are the security definer RPCs plus three
-- plain catalog edits: add a category, delete a category, change the receipt footer. Sales, sale
-- lines, stock movements, sessions, terminals and voids have no client INSERT, UPDATE or DELETE
-- privilege at all, so nothing but record_sale and friends can change them.
--
-- The ledger (sales, sale_lines, stock_movements, receipt_voids) is append-only for every role: the
-- service role has no INSERT, UPDATE, DELETE or TRUNCATE on it either, and triggers refuse UPDATE,
-- DELETE and TRUNCATE for the roles that keep their privileges (the owner and superusers).

alter table public.shops enable row level security;
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.stock_movements enable row level security;
alter table public.shop_settings enable row level security;
alter table public.terminals enable row level security;
alter table public.cash_sessions enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.receipt_voids enable row level security;
alter table public.legacy_orders enable row level security;

revoke all on
  public.shops, public.profiles, public.categories, public.products, public.stock_movements,
  public.shop_settings, public.terminals, public.cash_sessions, public.sales, public.sale_lines,
  public.receipt_voids, public.legacy_orders
from anon, authenticated;

grant select on
  public.shops, public.profiles, public.categories, public.products, public.stock_movements,
  public.shop_settings, public.terminals, public.cash_sessions, public.sales, public.sale_lines,
  public.receipt_voids, public.legacy_orders
to authenticated;

grant insert (name, color) on public.categories to authenticated;
grant delete on public.categories to authenticated;
grant update (receipt_footer) on public.shop_settings to authenticated;

revoke all on sequence public.stock_movements_id_seq from anon, authenticated;

-- The service role keeps SELECT (tests and support read the ledger with it) but cannot write it.
revoke insert, update, delete, truncate on
  public.sales, public.sale_lines, public.stock_movements, public.receipt_voids
from service_role;

-- The last guard, for the roles that keep their privileges on the ledger: the owner (migrations,
-- the SQL editor) and superusers. A row is never updated or deleted and a table is never truncated,
-- unless the transaction first runs
--
--   set local pos.ledger_maintenance = 'on';
--
-- That switch is reserved for the Phase 5 reset of the demo shop, a scheduled job that runs as the
-- owner. It grants nothing by itself: API roles (anon, authenticated, service_role) have no UPDATE,
-- DELETE or TRUNCATE privilege on these tables, so setting it changes nothing for them. It guards
-- against mistakes, not against a superuser, who can still turn triggers off.
create or replace function private.reject_ledger_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('pos.ledger_maintenance', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    -- UPDATE continues with the new row; the value is ignored for TRUNCATE.
    return new;
  end if;
  raise exception using
    errcode = 'PT403',
    message = 'FORBIDDEN',
    detail = '{}',
    hint = format('The ledger is append-only: rows of %s.%s are never updated, deleted or truncated.', tg_table_schema, tg_table_name);
end;
$$;

create trigger sales_append_only before update or delete on public.sales
  for each row execute function private.reject_ledger_change();
create trigger sales_no_truncate before truncate on public.sales
  for each statement execute function private.reject_ledger_change();

create trigger sale_lines_append_only before update or delete on public.sale_lines
  for each row execute function private.reject_ledger_change();
create trigger sale_lines_no_truncate before truncate on public.sale_lines
  for each statement execute function private.reject_ledger_change();

create trigger stock_movements_append_only before update or delete on public.stock_movements
  for each row execute function private.reject_ledger_change();
create trigger stock_movements_no_truncate before truncate on public.stock_movements
  for each statement execute function private.reject_ledger_change();

create trigger receipt_voids_append_only before update or delete on public.receipt_voids
  for each row execute function private.reject_ledger_change();
create trigger receipt_voids_no_truncate before truncate on public.receipt_voids
  for each statement execute function private.reject_ledger_change();

create policy shops_select on public.shops
  for select to authenticated
  using (id = (select private.current_shop_id()));

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    shop_id = (select private.current_shop_id())
    and (user_id = (select auth.uid()) or (select private.current_app_role()) = 'admin')
  );

create policy categories_select on public.categories
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy categories_insert on public.categories
  for insert to authenticated
  with check (shop_id = (select private.current_shop_id()) and (select private.current_app_role()) = 'admin');

create policy categories_delete on public.categories
  for delete to authenticated
  using (shop_id = (select private.current_shop_id()) and (select private.current_app_role()) = 'admin');

create policy products_select on public.products
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy shop_settings_select on public.shop_settings
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy shop_settings_update on public.shop_settings
  for update to authenticated
  using (shop_id = (select private.current_shop_id()) and (select private.current_app_role()) = 'admin')
  with check (shop_id = (select private.current_shop_id()));

create policy terminals_select on public.terminals
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy cash_sessions_select on public.cash_sessions
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy sales_select on public.sales
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy sale_lines_select on public.sale_lines
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy receipt_voids_select on public.receipt_voids
  for select to authenticated
  using (shop_id = (select private.current_shop_id()));

create policy legacy_orders_select on public.legacy_orders
  for select to authenticated
  using (shop_id = (select private.current_shop_id()) and (select private.current_app_role()) = 'admin');

-- Functions. Postgres grants EXECUTE to PUBLIC by default, so revoke from PUBLIC as well as anon;
-- then members get exactly the RPCs.
revoke all on all functions in schema public from public, anon;
grant execute on function
  public.my_profile(),
  public.save_product(jsonb),
  public.archive_product(uuid),
  public.register_terminal(text),
  public.open_session(jsonb),
  public.close_session(jsonb),
  public.force_close_session(uuid, text),
  public.z_report(uuid),
  public.record_sale(jsonb),
  public.void_receipt(jsonb)
to authenticated;

-- Functions created later in public by the migration role no longer get Supabase's per-schema
-- EXECUTE grant to anon. PUBLIC's EXECUTE on new functions is a global default, which a per-schema
-- statement cannot take away, so a later migration that adds a function to public must still
-- revoke it from public and anon itself, as the statement above does for today's functions.
alter default privileges in schema public revoke execute on functions from public, anon;

revoke all on all functions in schema private from public, anon;
-- Row-level security policies and the categories.shop_id default call these as the querying user.
grant execute on function private.current_shop_id(), private.current_app_role() to authenticated;

revoke all on all functions in schema migration from public, anon, authenticated;
