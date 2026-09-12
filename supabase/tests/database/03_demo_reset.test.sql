-- The nightly demo reset: what it removes, what it keeps, and that it is the only path allowed to
-- do it. Runs with `supabase test db` against seed.sql, like the other two files.
begin;

create extension if not exists pgtap with schema extensions;

select plan(21);

-- Helpers live in a throwaway schema inside this transaction, and are called while the role is
-- `authenticated`, so that role needs to reach them.
create schema test_helpers;
grant usage on schema test_helpers to authenticated;

-- No `set search_path` clause here: a function with one gets its own GUC nest level, and the role
-- set inside it would be undone the moment the function returned.
create function test_helpers.login(p_user uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- A one-line cash sale of `p_qty` units at `p_unit` on `p_terminal`, whose epoch is 0 throughout.
create function test_helpers.sale(
  p_id uuid, p_terminal text, p_seq bigint, p_session uuid, p_hash text,
  p_product uuid, p_qty integer, p_unit bigint
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'id', p_id, 'kind', 'sale', 'terminal_code', p_terminal, 'epoch', 0, 'seq', p_seq,
    'session_id', p_session, 'created_at', '2026-09-11T10:00:00Z', 'payload_hash', p_hash,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_no', 1, 'product_id', p_product, 'product_name', 'Fixture line', 'qty', p_qty,
      'unit_price_millimes', p_unit, 'line_discount_millimes', 0, 'cart_discount_share_millimes', 0,
      'line_total_millimes', p_qty * p_unit
    )),
    'subtotal_millimes', p_qty * p_unit, 'discount_millimes', 0, 'total_millimes', p_qty * p_unit,
    'payment', jsonb_build_object('method', 'cash', 'tendered_millimes', p_qty * p_unit, 'change_millimes', 0)
  )
$$;

-- A refund of `p_qty` units of line 1 of `p_sale`, never the last units of that line.
create function test_helpers.refund(
  p_id uuid, p_terminal text, p_seq bigint, p_session uuid, p_hash text,
  p_sale uuid, p_product uuid, p_qty integer, p_unit bigint
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'id', p_id, 'kind', 'refund', 'terminal_code', p_terminal, 'epoch', 0, 'seq', p_seq,
    'session_id', p_session, 'created_at', '2026-09-11T11:00:00Z', 'payload_hash', p_hash,
    'refunds_sale_id', p_sale,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_no', 1, 'refunds_line_no', 1, 'product_id', p_product, 'product_name', 'Fixture line',
      'qty', -p_qty, 'unit_price_millimes', p_unit, 'line_discount_millimes', 0,
      'cart_discount_share_millimes', 0, 'line_total_millimes', -(p_qty * p_unit)
    )),
    'subtotal_millimes', -(p_qty * p_unit), 'discount_millimes', 0, 'total_millimes', -(p_qty * p_unit),
    'payment', jsonb_build_object('method', 'cash', 'tendered_millimes', -(p_qty * p_unit), 'change_millimes', 0)
  )
$$;

grant execute on all functions in schema test_helpers to authenticated;

-- Seed ids
--   shop A 11111111-1111-4111-8111-111111111111, admin aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1, terminal T1
--   shop B 22222222-2222-4222-8222-222222222222, admin bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1
--   water 55555555-5555-4555-8555-555555555501 (850, opening 120)
--   milk  55555555-5555-4555-8555-555555555502 (1350, opening 60)
--   shop B product 66666666-6666-4666-8666-666666666601 (1000, opening 10)
--
-- A day of trading on the demo shop:
--   T1  session 7701, closed:  T1-1 sale of 2 water, T1-2 sale of 3 water
--   T1  session 7702, open:    T1-3 refund of 1 unit of T1-2
--   T2  session 7703, closed:  T2-1 sale of 5 milk, T2-2 refund of 2 of them, T2-3 a voided receipt
--   plus a stock adjustment of +4 milk, and one of +3 on the other shop's product.

select test_helpers.login('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
select public.register_terminal('T2');

-- An adjustment, the other kind of movement the reset drops.
select public.save_product(jsonb_build_object(
  'id', '55555555-5555-4555-8555-555555555502', 'name', 'Lait demi-écrémé 1 L',
  'price_millimes', 1350, 'category_id', '44444444-4444-4444-8444-444444444402',
  'barcode', '6194000200012', 'stock_delta', 4
));

select public.open_session(jsonb_build_object(
  'id', '77777777-7777-4777-8777-777777777701', 'terminal_code', 'T1', 'epoch', 0,
  'actor_user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'opened_at', '2026-09-11T08:00:00Z',
  'opening_float_millimes', 0, 'payload_hash', repeat('a', 64)
));
select public.record_sale(test_helpers.sale('88888888-8888-4888-8888-888888888801', 'T1', 1,
  '77777777-7777-4777-8777-777777777701', repeat('b', 64), '55555555-5555-4555-8555-555555555501', 2, 850));
select public.record_sale(test_helpers.sale('88888888-8888-4888-8888-888888888802', 'T1', 2,
  '77777777-7777-4777-8777-777777777701', repeat('c', 64), '55555555-5555-4555-8555-555555555501', 3, 850));
select public.close_session(jsonb_build_object(
  'id', '99999999-9999-4999-8999-999999999901', 'session_id', '77777777-7777-4777-8777-777777777701',
  'terminal_code', 'T1', 'epoch', 0, 'actor_user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'closed_at', '2026-09-11T20:00:00Z', 'closing_counted_millimes', 4250, 'client_z_report', null,
  'payload_hash', repeat('d', 64)
));

-- The next morning's session is still open when the job runs, and holds a refund of yesterday's sale.
select public.open_session(jsonb_build_object(
  'id', '77777777-7777-4777-8777-777777777702', 'terminal_code', 'T1', 'epoch', 0,
  'actor_user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'opened_at', '2026-09-12T08:00:00Z',
  'opening_float_millimes', 0, 'payload_hash', repeat('e', 64)
));
select public.record_sale(test_helpers.refund('88888888-8888-4888-8888-888888888803', 'T1', 3,
  '77777777-7777-4777-8777-777777777702', repeat('f', 64), '88888888-8888-4888-8888-888888888802',
  '55555555-5555-4555-8555-555555555501', 1, 850));

-- A second terminal, whose whole day closes and can go.
select public.open_session(jsonb_build_object(
  'id', '77777777-7777-4777-8777-777777777703', 'terminal_code', 'T2', 'epoch', 0,
  'actor_user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'opened_at', '2026-09-11T08:00:00Z',
  'opening_float_millimes', 0, 'payload_hash', repeat('1', 64)
));
select public.record_sale(test_helpers.sale('88888888-8888-4888-8888-888888888804', 'T2', 1,
  '77777777-7777-4777-8777-777777777703', repeat('2', 64), '55555555-5555-4555-8555-555555555502', 5, 1350));
select public.record_sale(test_helpers.refund('88888888-8888-4888-8888-888888888805', 'T2', 2,
  '77777777-7777-4777-8777-777777777703', repeat('3', 64), '88888888-8888-4888-8888-888888888804',
  '55555555-5555-4555-8555-555555555502', 2, 1350));
select public.void_receipt(jsonb_build_object(
  'record', jsonb_build_object(
    'id', '88888888-8888-4888-8888-888888888806', 'terminal_code', 'T2', 'seq', 3,
    'session_id', '77777777-7777-4777-8777-777777777703', 'payload_hash', repeat('4', 64)
  ),
  'error_code', 'VALIDATION_ERROR',
  'reason', 'Recorded offline against a line that was already refunded elsewhere'
));
select public.close_session(jsonb_build_object(
  'id', '99999999-9999-4999-8999-999999999903', 'session_id', '77777777-7777-4777-8777-777777777703',
  'terminal_code', 'T2', 'epoch', 0, 'actor_user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'closed_at', '2026-09-11T20:30:00Z', 'closing_counted_millimes', 4050, 'client_z_report', null,
  'payload_hash', repeat('5', 64)
));

-- The other shop gets an adjustment too, so a reset that forgot to scope itself would show here.
select test_helpers.login('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
select public.save_product(jsonb_build_object(
  'id', '66666666-6666-4666-8666-666666666601', 'name', 'Other product A',
  'price_millimes', 1000, 'category_id', '44444444-4444-4444-8444-444444444411',
  'barcode', '9990000000011', 'stock_delta', 3
));

reset role;
insert into private.demo_shops (shop_id) values ('11111111-1111-4111-8111-111111111111');

-- The day as recorded, before the job runs.
select is(
  (select array_agg(s.receipt_number order by s.receipt_number)
   from public.sales s where s.shop_id = '11111111-1111-4111-8111-111111111111'),
  array['T1-1', 'T1-2', 'T1-3', 'T2-1', 'T2-2'],
  'the demo shop starts with five documents across three sessions'
);
select is(
  jsonb_build_object(
    'water', (select p.stock from public.products p where p.id = '55555555-5555-4555-8555-555555555501'),
    'milk', (select p.stock from public.products p where p.id = '55555555-5555-4555-8555-555555555502')
  ),
  jsonb_build_object('water', 116, 'milk', 61),
  'trading and the adjustment have moved both products away from their opening stock'
);

-- Only a registered demo shop can be reset.
select throws_ok(
  $$ select private.reset_demo_shop('22222222-2222-4222-8222-222222222222') $$,
  'P0001', null, 'resetting a shop that is not registered as a demo shop raises'
);

-- The same deletes, attempted outside the function, are still refused: pos.ledger_maintenance is
-- off for everyone else, and the API roles have no DELETE privilege at all.
select throws_ok(
  $$ delete from public.sales where id = '88888888-8888-4888-8888-888888888801' $$,
  'PT403', 'FORBIDDEN', 'outside the function the owner cannot delete a sale of the demo shop'
);
select throws_ok(
  $$ delete from public.sale_lines where sale_id = '88888888-8888-4888-8888-888888888801' $$,
  'PT403', 'FORBIDDEN', 'outside the function the owner cannot delete its sale lines'
);
select throws_ok(
  $$ delete from public.stock_movements where sale_id = '88888888-8888-4888-8888-888888888801' $$,
  'PT403', 'FORBIDDEN', 'outside the function the owner cannot delete its stock movements'
);
select throws_ok(
  $$ delete from public.receipt_voids where shop_id = '11111111-1111-4111-8111-111111111111' $$,
  'PT403', 'FORBIDDEN', 'outside the function the owner cannot delete a voided receipt'
);

-- The job itself.
select is(
  private.reset_demo_shop('11111111-1111-4111-8111-111111111111'),
  jsonb_build_object(
    'sales_deleted', 2, 'refunds_deleted', 1, 'voids_deleted', 1,
    'sessions_deleted', 1, 'adjustments_deleted', 1
  ),
  'the reset reports every document it removed'
);

select is(
  (select array_agg(s.receipt_number order by s.receipt_number)
   from public.sales s where s.shop_id = '11111111-1111-4111-8111-111111111111'),
  array['T1-2', 'T1-3'],
  'the sale a kept refund points at survives, and so does the refund'
);
select is(
  (select jsonb_agg(jsonb_build_object('session', s.id, 'open', s.closed_at is null) order by s.id)
   from public.cash_sessions s where s.shop_id = '11111111-1111-4111-8111-111111111111'),
  jsonb_build_array(
    jsonb_build_object('session', '77777777-7777-4777-8777-777777777701', 'open', false),
    jsonb_build_object('session', '77777777-7777-4777-8777-777777777702', 'open', true)
  ),
  'the open session survives; the closed session left with nothing in it is gone'
);
select is(
  (select count(*)::integer from public.receipt_voids v where v.shop_id = '11111111-1111-4111-8111-111111111111'),
  0,
  'the voided receipts of closed sessions are gone'
);

-- Stock is recomputed from what is left of the movement log.
select is(
  (select p.stock from public.products p where p.id = '55555555-5555-4555-8555-555555555502'),
  60,
  'a product whose whole day was removed is back to its opening stock'
);
select is(
  (select array_agg(m.reason order by m.id)
   from public.stock_movements m where m.product_id = '55555555-5555-4555-8555-555555555502'),
  array['opening'],
  'its only movement left is the opening one: the adjustment and the day went with the sales'
);
select is(
  (select p.stock from public.products p where p.id = '55555555-5555-4555-8555-555555555501'),
  118,
  'a product with kept documents keeps exactly their effect on stock'
);
select is(
  (select count(*)::integer
   from public.products p
   where p.shop_id = '11111111-1111-4111-8111-111111111111'
     and p.stock <> coalesce((select sum(m.delta) from public.stock_movements m where m.product_id = p.id), 0)),
  0,
  'every product still holds the stock its movements add up to'
);

select is(
  (select jsonb_object_agg(t.code, t.last_seq)
   from public.terminals t where t.shop_id = '11111111-1111-4111-8111-111111111111'),
  jsonb_build_object('T1', 3, 'T2', 3),
  'last_seq is never lowered: both terminals keep every number they used'
);
select is(
  jsonb_build_object(
    'stock', (select p.stock from public.products p where p.id = '66666666-6666-4666-8666-666666666601'),
    'movements', (select count(*) from public.stock_movements m where m.shop_id = '22222222-2222-4222-8222-222222222222')
  ),
  jsonb_build_object('stock', 13, 'movements', 3),
  'the other shop keeps its adjustment: the reset touches one shop'
);

-- The switch the function turned on does not outlive it.
select throws_ok(
  $$ delete from public.sales where id = '88888888-8888-4888-8888-888888888802' $$,
  'PT403', 'FORBIDDEN', 'once the function has returned the ledger is append-only again'
);

select is(
  private.reset_demo_shop('11111111-1111-4111-8111-111111111111'),
  jsonb_build_object(
    'sales_deleted', 0, 'refunds_deleted', 0, 'voids_deleted', 0,
    'sessions_deleted', 0, 'adjustments_deleted', 0
  ),
  'running it again removes nothing: what is left is an open session and the refund history it needs'
);

-- Who may run it. pg_cron runs as the owner; nothing the Data API can reach gets near it.
select is(
  (select count(*)::integer
   from (values ('anon'), ('authenticated'), ('service_role')) as r (name)
   where has_function_privilege(r.name::name, 'private.reset_demo_shop(uuid)'::regprocedure, 'execute')),
  0,
  'no API role can run the reset'
);
select is(
  (select count(*)::integer
   from (values ('anon'), ('authenticated'), ('service_role')) as r (name)
   where has_table_privilege(r.name::name, 'private.demo_shops'::regclass, 'select')),
  0,
  'no API role can read which shops are demo shops'
);

select * from finish();
rollback;
