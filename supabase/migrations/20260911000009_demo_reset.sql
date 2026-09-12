-- Nightly reset for the public Supabase demo. Only shops listed here can be reset.
create table private.demo_shops (
  shop_id uuid primary key references public.shops (id) on delete cascade
);
revoke all on private.demo_shops from public, anon, authenticated;

-- Removes the trading history of a demo shop's closed sessions and restores stock to the opening
-- movements. It runs as the database owner from pg_cron, the one path allowed to delete ledger rows.
--
-- What it keeps, so demo registers keep working the next morning:
--   - open sessions and every document in them, and any sale a kept refund points at
--   - terminal counters: last_seq is never lowered, so numbering never repeats
--   - the catalog itself (names, prices, archived products)
create or replace function private.reset_demo_shop(p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale_ids uuid[];
  v_sales integer;
  v_refunds integer;
  v_voids integer;
  v_sessions integer;
  v_adjustments integer;
begin
  if not exists (select 1 from private.demo_shops d where d.shop_id = p_shop_id) then
    raise exception 'reset_demo_shop: shop % is not registered as a demo shop', p_shop_id;
  end if;

  -- Every delete below is refused by the ledger triggers unless this is on. The switch exists for
  -- this reset alone (migration 20260911000008). The third argument makes it transaction-local, so
  -- a crash or a rollback takes it with them, and it is turned off again before returning: a
  -- function's own SET clause is restored on return, but a setting the body makes is not.
  perform set_config('pos.ledger_maintenance', 'on', true);

  select coalesce(array_agg(s.id), '{}')
  into v_sale_ids
  from public.sales s
  join public.cash_sessions cs on cs.id = s.session_id
  where s.shop_id = p_shop_id
    and cs.closed_at is not null
    and not exists (
      select 1
      from public.sales r
      join public.cash_sessions rcs on rcs.id = r.session_id
      where r.refunds_sale_id = s.id and rcs.closed_at is null
    );

  delete from public.stock_movements m where m.sale_id = any (v_sale_ids);
  delete from public.sale_lines l where l.sale_id = any (v_sale_ids);
  -- Refunds before the sales they point at, and counted separately: a run that removed refunds
  -- would otherwise report fewer documents than it deleted.
  delete from public.sales s where s.id = any (v_sale_ids) and s.kind = 'refund';
  get diagnostics v_refunds = row_count;
  delete from public.sales s where s.id = any (v_sale_ids) and s.kind = 'sale';
  get diagnostics v_sales = row_count;

  delete from public.receipt_voids v
  using public.cash_sessions cs
  where v.session_id = cs.id and cs.shop_id = p_shop_id and cs.closed_at is not null;
  get diagnostics v_voids = row_count;

  delete from public.cash_sessions cs
  where cs.shop_id = p_shop_id
    and cs.closed_at is not null
    and not exists (select 1 from public.sales s where s.session_id = cs.id)
    and not exists (select 1 from public.receipt_voids v where v.session_id = cs.id);
  get diagnostics v_sessions = row_count;

  delete from public.stock_movements m where m.shop_id = p_shop_id and m.reason = 'adjustment';
  get diagnostics v_adjustments = row_count;

  update public.products p
  set stock = coalesce((select sum(m.delta) from public.stock_movements m where m.product_id = p.id), 0)
  where p.shop_id = p_shop_id;

  -- The ledger is append-only again for whatever the caller does next in this transaction. pg_cron
  -- gives each statement its own, but a person running this from the SQL editor may not.
  perform set_config('pos.ledger_maintenance', 'off', true);

  return jsonb_build_object(
    'sales_deleted', v_sales,
    'refunds_deleted', v_refunds,
    'voids_deleted', v_voids,
    'sessions_deleted', v_sessions,
    'adjustments_deleted', v_adjustments
  );
end;
$$;

revoke all on function private.reset_demo_shop(uuid) from public, anon, authenticated;
