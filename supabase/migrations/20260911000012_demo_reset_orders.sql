-- The nightly demo reset, with the café model's working state.
--
-- Two things forced this. A sale line now points at the order item it paid for, so deleting a day's
-- sales without clearing those items is refused by the foreign key and the whole reset fails. And a
-- demo that opens with yesterday's half-eaten tables is not a demo: the table plan has to be free
-- again in the morning.
--
-- What it keeps is unchanged: open sessions and every document in them, any sale a kept refund
-- points at, terminal counters, and the catalog. An order item a kept sale paid for is part of that
-- document, so its item and its order stay too.
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
  v_items integer;
  v_orders integer;
  v_records integer;
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

  -- The tables are cleared before the documents, because an order item names the sale that paid it
  -- and the foreign key refuses to let that sale go while it does. Everything a waiter put down
  -- yesterday goes, paid or not, except an item that belongs to a sale this run keeps: that item is
  -- part of a document, not working state.
  delete from public.open_order_items i
  where i.shop_id = p_shop_id
    and not exists (select 1 from public.sale_lines sl where sl.open_order_item_id = i.id);
  get diagnostics v_items = row_count;

  delete from public.open_orders o
  where o.shop_id = p_shop_id
    and not exists (select 1 from public.open_order_items i where i.order_id = o.id);
  get diagnostics v_orders = row_count;

  -- An idempotency record whose order is gone would replay an answer about a row that no longer
  -- exists; the stock adjustments this run undoes go with them.
  delete from public.order_records r
  where r.shop_id = p_shop_id
    and not exists (select 1 from public.open_orders o where o.id = private.try_uuid(r.result ->> 'order_id'));
  get diagnostics v_records = row_count;

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
  set stock_qty = coalesce((select sum(m.delta) from public.stock_movements m where m.product_id = p.id), 0)
  where p.shop_id = p_shop_id;

  -- The ledger is append-only again for whatever the caller does next in this transaction. pg_cron
  -- gives each statement its own, but a person running this from the SQL editor may not.
  perform set_config('pos.ledger_maintenance', 'off', true);

  return jsonb_build_object(
    'sales_deleted', v_sales,
    'refunds_deleted', v_refunds,
    'voids_deleted', v_voids,
    'sessions_deleted', v_sessions,
    'adjustments_deleted', v_adjustments,
    'order_items_deleted', v_items,
    'orders_deleted', v_orders,
    'order_records_deleted', v_records
  );
end;
$$;

revoke all on function private.reset_demo_shop(uuid) from public, anon, authenticated;
