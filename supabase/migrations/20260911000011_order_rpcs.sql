-- The order RPCs of docs/spec.md, the admin's stock adjustment and its removed-after-sent report,
-- and record_sale taught to pay order items.
--
-- Every one of these takes `p jsonb` with a client `id` and `payload_hash` and is SECURITY DEFINER
-- with explicit shop and role checks, exactly like record_sale: no role holds a write policy on any
-- of these tables. They raise with message = <CODE> and a JSON detail (contracts/errors.md).

-- The café codes. Same table as migration 20260911000002, four rows longer.
create or replace function private.raise_error(p_code text, p_hint text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_state text := case p_code
    when 'UNAUTHENTICATED' then 'PT401'
    when 'FORBIDDEN' then 'PT403'
    when 'NOT_FOUND' then 'PT404'
    when 'ITEM_NOT_FOUND' then 'PT404'
    when 'IDEMPOTENCY_CONFLICT' then 'PT409'
    when 'SEQUENCE_GAP' then 'PT409'
    when 'SESSION_CLOSED' then 'PT409'
    when 'SESSION_ALREADY_OPEN' then 'PT409'
    when 'TERMINAL_SUPERSEDED' then 'PT409'
    when 'ORDER_CHANGED' then 'PT409'
    when 'ORDER_CLOSED' then 'PT409'
    when 'TABLE_INACTIVE' then 'PT409'
    when 'VALIDATION_ERROR' then 'PT422'
  end;
begin
  if v_state is null then
    raise exception 'raise_error called with unknown code %', p_code;
  end if;
  raise exception using
    errcode = v_state,
    message = p_code,
    detail = coalesce(p_details, '{}'::jsonb)::text,
    hint = p_hint;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Payload helpers.

-- The first of p_keys the payload actually carries, or null.
create or replace function private.json_first(p jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p -> k.key
  from unnest(p_keys) with ordinality as k(key, ord)
  where p ? k.key and jsonb_typeof(p -> k.key) <> 'null'
  order by k.ord
  limit 1
$$;

-- A device queues records before it is upgraded, so a payload written by the previous version of
-- the app has to stay readable: this copies a legacy key onto the name the café model uses, and
-- leaves a payload that already carries the new name alone.
create or replace function private.json_alias(p jsonb, p_key text, p_legacy text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p ? p_key and jsonb_typeof(p -> p_key) <> 'null' then p
    when private.json_first(p, p_legacy) is null then p
    else p || jsonb_build_object(p_key, private.json_first(p, p_legacy))
  end
$$;

create or replace function private.json_reason(p jsonb, p_key text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := trim(coalesce(private.json_text(p, p_key, false), ''));
begin
  if v = '' then
    perform private.raise_error('VALIDATION_ERROR', format('%s is required.', p_key), jsonb_build_object('field', p_key));
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Idempotency for order and stock records: the same rule record_sale applies to the ledger.

create or replace function private.order_replay(p_shop_id uuid, p_id uuid, p_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_found record;
begin
  select r.shop_id, r.payload_hash, r.result into v_found from public.order_records r where r.id = p_id;
  if not found then
    return null;
  end if;
  if v_found.shop_id <> p_shop_id then
    perform private.raise_error('FORBIDDEN', 'This record belongs to another shop.', jsonb_build_object('id', p_id));
  end if;
  if v_found.payload_hash <> p_hash then
    perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different record was already stored under this id.', jsonb_build_object('id', p_id));
  end if;
  return jsonb_set(v_found.result, '{status}', '"replayed"');
end;
$$;

-- Stores the record and returns its result. A unique clash means another transaction stored the
-- same id after the replay check, which is the same conflict seen a moment later.
create or replace function private.order_record_store(
  p_shop_id uuid, p_id uuid, p_kind text, p_hash text, p jsonb, p_submitted_by uuid, p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- A device stamps its record; a payload that carries no clock of its own is stamped on arrival.
  v_when jsonb := private.json_first(p, array['created_at', 'added_at', 'sent_at']);
begin
  insert into public.order_records (id, shop_id, kind, payload_hash, device_id, submitted_by, result, created_at)
  values (
    p_id, p_shop_id, p_kind, p_hash,
    coalesce(private.json_text(p, 'device_id', false), ''),
    p_submitted_by, p_result,
    coalesce(
      case when v_when is null then null
           else private.json_timestamptz(jsonb_build_object('created_at', v_when), 'created_at') end,
      now()
    )
  );
  return p_result;
exception when unique_violation then
  perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different record was already stored under this id.', jsonb_build_object('id', p_id));
  return null;
end;
$$;

-- The person the record says did the work, checked against the shop like every ledger record. Order
-- records carry no actor of their own (src/ports/orders.ts), so the caller is the default.
create or replace function private.order_actor(p_profile public.profiles, p jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p ? 'actor_user_id' and jsonb_typeof(p -> 'actor_user_id') <> 'null' then
    return private.require_member(p_profile.shop_id, p);
  end if;
  return p_profile.user_id;
end;
$$;

-- The table named by a record, locked. Locking the table row is what makes lazy order creation
-- safe: two devices adding to the same free table queue here, so the second one sees the order the
-- first one opened instead of racing to create a second.
create or replace function private.lock_table(p_shop_id uuid, p_table_id uuid, p_require_active boolean)
returns public.dining_tables
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.dining_tables;
begin
  select * into v_table from public.dining_tables where id = p_table_id and shop_id = p_shop_id for update;
  if not found then
    perform private.raise_error('FORBIDDEN', 'This table is not in your shop.', jsonb_build_object('table_id', p_table_id));
  end if;
  if p_require_active and not v_table.is_active then
    perform private.raise_error('TABLE_INACTIVE', 'This table is not in service.', jsonb_build_object('table_id', p_table_id));
  end if;
  return v_table;
end;
$$;

-- Closes an order that has nothing left to pay. Called after every payment and after a removal:
-- taking the last unpaid item off a table frees it just as paying for it does.
create or replace function private.close_order_if_settled(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closed boolean := false;
begin
  update public.open_orders o
  set status = 'closed', closed_at = now()
  where o.id = p_order_id
    and o.status = 'open'
    and exists (select 1 from public.open_order_items i where i.order_id = o.id and i.paid_sale_id is not null)
    and not exists (
      select 1 from public.open_order_items i
      where i.order_id = o.id and i.removed_at is null and i.paid_sale_id is null
    );
  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The five order RPCs.

-- p = { id, table_id, product_id, qty, note, added_at, device_id, payload_hash }
-- Finds the table's open order or creates it, snapshots the name and the price, inserts the item.
-- A closed order means the table is free again, so a late add — a waiter's offline event arriving
-- after the caisse paid the table — opens a new order with that item rather than losing it.
-- Returns { status, order_id, item_id }.
create or replace function public.order_item_add(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id uuid;
  v_hash text;
  v_replay jsonb;
  v_table public.dining_tables;
  v_product public.products;
  v_order_id uuid;
  v_qty integer;
  v_note text;
  v_added_at timestamptz;
  v_actor uuid;
begin
  v_profile := private.require_profile(array['admin', 'cashier', 'waiter']);
  p := private.json_alias(p, 'added_at', array['created_at']);
  v_id := private.json_uuid(p, 'id');
  v_hash := private.json_hash(p);

  v_replay := private.order_replay(v_profile.shop_id, v_id, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  v_table := private.lock_table(v_profile.shop_id, private.json_uuid(p, 'table_id'), true);

  select * into v_product
  from public.products
  where id = private.json_uuid(p, 'product_id') and shop_id = v_profile.shop_id and archived_at is null;
  if not found then
    perform private.raise_error(
      'NOT_FOUND', 'That product is not on the menu.',
      jsonb_build_object('product_id', private.json_uuid(p, 'product_id'))
    );
  end if;

  v_qty := private.json_int(p, 'qty');
  if v_qty < 1 then
    perform private.raise_error('VALIDATION_ERROR', 'A quantity is at least one.', jsonb_build_object('field', 'qty'));
  end if;
  v_note := coalesce(private.json_text(p, 'note', false), '');
  v_added_at := private.json_timestamptz(p, 'added_at');
  v_actor := private.order_actor(v_profile, p);

  select o.id into v_order_id
  from public.open_orders o
  where o.table_id = v_table.id and o.status = 'open';
  if v_order_id is null then
    insert into public.open_orders (shop_id, table_id, opened_at)
    values (v_profile.shop_id, v_table.id, v_added_at)
    returning id into v_order_id;
  end if;

  begin
    insert into public.open_order_items (
      id, shop_id, order_id, product_id, name_snapshot, unit_price_millimes, qty, note, device_id, added_by, added_at
    )
    values (
      v_id, v_profile.shop_id, v_order_id, v_product.id, v_product.name, v_product.price_millimes, v_qty, v_note,
      coalesce(private.json_text(p, 'device_id', false), ''), v_actor, v_added_at
    );
  exception when unique_violation then
    -- The item id is the record id, so this is the same record arriving twice at once.
    perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different record was already stored under this id.', jsonb_build_object('id', v_id));
  end;

  return private.order_record_store(
    v_profile.shop_id, v_id, 'order_item_add', v_hash, p, v_profile.user_id,
    jsonb_build_object('status', 'created', 'order_id', v_order_id, 'item_id', v_id)
  );
end;
$$;

-- p = { id, item_id, reason, created_at, device_id, payload_hash }
-- Stamps removed_at and keeps the row: the admin's report of items removed after they were sent is
-- the reason the row stays. Returns { status, order_id, affected }.
create or replace function public.order_item_remove(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id uuid;
  v_hash text;
  v_replay jsonb;
  v_item_id uuid;
  v_item public.open_order_items;
  v_order public.open_orders;
  v_reason text;
  v_actor uuid;
  v_affected integer := 0;
begin
  v_profile := private.require_profile(array['admin', 'cashier', 'waiter']);
  v_id := private.json_uuid(p, 'id');
  v_hash := private.json_hash(p);

  v_replay := private.order_replay(v_profile.shop_id, v_id, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  v_reason := private.json_reason(p, 'reason');
  v_item_id := private.json_uuid(p, 'item_id');
  select * into v_item
  from public.open_order_items
  where id = v_item_id and shop_id = v_profile.shop_id
  for update;
  if not found then
    perform private.raise_error('ITEM_NOT_FOUND', 'That item is not on any table.', jsonb_build_object('item_id', v_item_id));
  end if;

  select * into v_order from public.open_orders where id = v_item.order_id;
  if v_item.paid_sale_id is not null then
    perform private.raise_error(
      'ORDER_CHANGED', 'That item has already been paid for.',
      jsonb_build_object('table_id', v_order.table_id, 'item_id', v_item_id)
    );
  end if;
  if v_order.status <> 'open' then
    perform private.raise_error(
      'ORDER_CLOSED', 'That table has no open order any more.',
      jsonb_build_object('table_id', v_order.table_id, 'order_id', v_order.id)
    );
  end if;

  v_actor := private.order_actor(v_profile, p);
  -- Removing an item that is already off the table changes nothing and must never stop a queue.
  if v_item.removed_at is null then
    update public.open_order_items
    set removed_at = now(), removed_by = v_actor, removed_reason = v_reason
    where id = v_item_id;
    v_affected := 1;
    perform private.close_order_if_settled(v_order.id);
  end if;

  return private.order_record_store(
    v_profile.shop_id, v_id, 'order_item_remove', v_hash, p, v_profile.user_id,
    jsonb_build_object('status', 'created', 'order_id', v_order.id, 'affected', v_affected)
  );
end;
$$;

-- p = { id, table_id, sent_at, device_id, payload_hash }
-- One send is one kitchen ticket: every unsent active item of the table's open order gets the same
-- stamp. Returns { status, order_id, affected }.
create or replace function public.order_send(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id uuid;
  v_hash text;
  v_replay jsonb;
  v_table public.dining_tables;
  v_order public.open_orders;
  v_sent_at timestamptz;
  v_affected integer;
begin
  v_profile := private.require_profile(array['admin', 'cashier', 'waiter']);
  p := private.json_alias(p, 'sent_at', array['created_at']);
  v_id := private.json_uuid(p, 'id');
  v_hash := private.json_hash(p);

  v_replay := private.order_replay(v_profile.shop_id, v_id, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  v_table := private.lock_table(v_profile.shop_id, private.json_uuid(p, 'table_id'), false);
  select * into v_order from public.open_orders where table_id = v_table.id and status = 'open';
  if not found then
    perform private.raise_error(
      'ORDER_CLOSED', 'That table has no open order any more.',
      jsonb_build_object('table_id', v_table.id)
    );
  end if;

  v_sent_at := private.json_timestamptz(p, 'sent_at');
  update public.open_order_items
  set sent_at = v_sent_at
  where order_id = v_order.id and sent_at is null and removed_at is null;
  get diagnostics v_affected = row_count;

  return private.order_record_store(
    v_profile.shop_id, v_id, 'order_send', v_hash, p, v_profile.user_id,
    jsonb_build_object('status', 'created', 'order_id', v_order.id, 'affected', v_affected)
  );
end;
$$;

-- p = { id, item_id, created_at, device_id, payload_hash }
-- The kitchen marking a ticket line done. Returns { status, order_id, affected }.
create or replace function public.order_item_prepare(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id uuid;
  v_hash text;
  v_replay jsonb;
  v_item_id uuid;
  v_item public.open_order_items;
  v_order public.open_orders;
  v_affected integer := 0;
begin
  v_profile := private.require_profile(array['admin', 'kitchen']);
  v_id := private.json_uuid(p, 'id');
  v_hash := private.json_hash(p);

  v_replay := private.order_replay(v_profile.shop_id, v_id, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  v_item_id := private.json_uuid(p, 'item_id');
  select * into v_item
  from public.open_order_items
  where id = v_item_id and shop_id = v_profile.shop_id
  for update;
  if not found then
    perform private.raise_error('ITEM_NOT_FOUND', 'That item is not on any table.', jsonb_build_object('item_id', v_item_id));
  end if;

  select * into v_order from public.open_orders where id = v_item.order_id;
  -- An item the kitchen was never told about, or one taken off the table while it cooked: the
  -- screen is out of date, which is exactly what ORDER_CHANGED means.
  if v_item.sent_at is null or v_item.removed_at is not null then
    perform private.raise_error(
      'ORDER_CHANGED', 'That item is no longer on the kitchen screen.',
      jsonb_build_object('table_id', v_order.table_id, 'item_id', v_item_id)
    );
  end if;

  if v_item.prepared_at is null then
    update public.open_order_items set prepared_at = now() where id = v_item_id;
    v_affected := 1;
  end if;

  return private.order_record_store(
    v_profile.shop_id, v_id, 'order_item_prepare', v_hash, p, v_profile.user_id,
    jsonb_build_object('status', 'created', 'order_id', v_order.id, 'affected', v_affected)
  );
end;
$$;

-- p = { id, table_id, reason, created_at, device_id, payload_hash }
-- Cancels the table's open order. Its active items are stamped removed with the cancel's reason, so
-- a cancel of a sent order still reaches the removed-after-sent report.
-- Returns { status, order_id, affected }.
create or replace function public.order_cancel(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id uuid;
  v_hash text;
  v_replay jsonb;
  v_table public.dining_tables;
  v_order public.open_orders;
  v_reason text;
  v_actor uuid;
  v_paid uuid;
  v_affected integer;
begin
  v_profile := private.require_profile(array['admin', 'cashier']);
  v_id := private.json_uuid(p, 'id');
  v_hash := private.json_hash(p);

  v_replay := private.order_replay(v_profile.shop_id, v_id, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  v_reason := private.json_reason(p, 'reason');
  v_table := private.lock_table(v_profile.shop_id, private.json_uuid(p, 'table_id'), false);
  select * into v_order from public.open_orders where table_id = v_table.id and status = 'open';
  if not found then
    perform private.raise_error(
      'ORDER_CLOSED', 'That table has no open order any more.',
      jsonb_build_object('table_id', v_table.id)
    );
  end if;

  select i.id into v_paid from public.open_order_items i where i.order_id = v_order.id and i.paid_sale_id is not null limit 1;
  if v_paid is not null then
    perform private.raise_error(
      'ORDER_CHANGED', 'Part of this order has already been paid for.',
      jsonb_build_object('table_id', v_table.id, 'order_id', v_order.id, 'item_id', v_paid)
    );
  end if;

  v_actor := private.order_actor(v_profile, p);
  update public.open_order_items
  set removed_at = now(), removed_by = v_actor, removed_reason = v_reason
  where order_id = v_order.id and removed_at is null;
  get diagnostics v_affected = row_count;

  update public.open_orders
  set status = 'cancelled', closed_at = now(), closed_reason = v_reason
  where id = v_order.id;

  return private.order_record_store(
    v_profile.shop_id, v_id, 'order_cancel', v_hash, p, v_profile.user_id,
    jsonb_build_object('status', 'created', 'order_id', v_order.id, 'affected', v_affected)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- p = { id, product_id, qty_delta, reason, created_at, device_id, payload_hash }   (admin)
-- The one manual way products.stock_qty moves. Returns { status, product_id, stock_qty }.
create or replace function public.adjust_stock(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id uuid;
  v_hash text;
  v_replay jsonb;
  v_product public.products;
  v_delta integer;
  v_reason text;
  v_actor uuid;
  v_stock integer;
begin
  v_profile := private.require_profile(array['admin']);
  v_id := private.json_uuid(p, 'id');
  v_hash := private.json_hash(p);

  v_replay := private.order_replay(v_profile.shop_id, v_id, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_product
  from public.products
  where id = private.json_uuid(p, 'product_id') and shop_id = v_profile.shop_id
  for update;
  if not found then
    perform private.raise_error(
      'NOT_FOUND', 'The product does not exist.',
      jsonb_build_object('product_id', private.json_uuid(p, 'product_id'))
    );
  end if;

  v_delta := private.json_int(p, 'qty_delta');
  if v_delta = 0 then
    perform private.raise_error('VALIDATION_ERROR', 'An adjustment moves stock up or down, never by nothing.', jsonb_build_object('field', 'qty_delta'));
  end if;
  v_reason := private.json_reason(p, 'reason');
  v_actor := private.order_actor(v_profile, p);

  v_stock := private.move_stock(v_profile.shop_id, v_product.id, v_delta, 'adjustment', null, v_reason, v_actor);

  return private.order_record_store(
    v_profile.shop_id, v_id, 'stock_adjustment', v_hash, p, v_profile.user_id,
    jsonb_build_object('status', 'created', 'product_id', v_product.id, 'stock_qty', v_stock)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Admin report: what was taken off a table after the kitchen had already been told, per waiter.
-- That is the classic waiter fraud, so it is a report and not a footnote. Both ends of the period
-- are required; the rows come back newest first.
create or replace function public.removed_after_sent(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  v_profile := private.require_profile(array['admin']);
  if p_from is null or p_to is null then
    perform private.raise_error('VALIDATION_ERROR', 'A report is always of a named period.', jsonb_build_object('field', 'from'));
  end if;
  if p_to < p_from then
    perform private.raise_error('VALIDATION_ERROR', 'The period ends before it starts.', jsonb_build_object('field', 'to'));
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'item_id', i.id,
          'table_name', t.name,
          'product_name', i.name_snapshot,
          'qty', i.qty,
          'unit_price_millimes', i.unit_price_millimes,
          'sent_at', i.sent_at,
          'removed_at', i.removed_at,
          'removed_by', i.removed_by,
          'removed_by_name', coalesce(pr.display_name, ''),
          'removed_reason', coalesce(i.removed_reason, '')
        )
        order by i.removed_at desc, i.id
      )
      from public.open_order_items i
      join public.open_orders o on o.id = i.order_id
      join public.dining_tables t on t.id = o.table_id
      left join public.profiles pr on pr.user_id = i.removed_by
      where i.shop_id = v_profile.shop_id
        and i.sent_at is not null
        and i.removed_at is not null
        and i.removed_at >= p_from
        and i.removed_at <= p_to
    ),
    '[]'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- record_sale, step 4 of docs/spec.md: a sale pays for named items of a table's open order.
--
-- p = { id, kind, terminal_code, epoch, seq, session_id, table_id?, created_at, payload_hash,
--       lines: [{ line_no, open_order_item_id?, product_id, product_name, qty, unit_price_millimes,
--                 line_discount_millimes, line_discount_reason?, allocated_discount_millimes,
--                 net_millimes, refunds_sale_line_id? }],
--       cart_discount_millimes, subtotal_millimes?, total_millimes,
--       payment: { method, tendered_millimes, change_millimes }, refunds_sale_id? }
-- Returns { sale_id, receipt_number, status: 'created' | 'replayed' | 'voided' }.
--
-- The order of checks is part of the contract (contracts/errors.md). Everything before step 7 is
-- unchanged from migration 20260911000006: the receipt sequence, the session and the terminal lock
-- behave exactly as they did.
create or replace function public.record_sale(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id uuid;
  v_hash text;
  v_terminal public.terminals;
  v_found record;
  v_session_id uuid;
  v_session public.cash_sessions;
  v_seq bigint;
  v_receipt text;
  v_kind text;
  v_lines jsonb;
  v_line jsonb;
  v_line_no integer := 0;
  v_product_id uuid;
  v_qty integer;
  v_unit bigint;
  v_line_discount bigint;
  v_line_reason text;
  v_share bigint;
  v_line_total bigint;
  v_table_id uuid;
  v_item_id uuid;
  v_item public.open_order_items;
  v_order_id uuid;
  v_item_ids uuid[] := '{}';
  v_refunds_line_id uuid;
  v_seen_refund_lines uuid[] := '{}';
  v_subtotal bigint := 0;
  v_discount bigint := 0;
  v_total bigint := 0;
  v_refunds_sale_id uuid;
  v_original public.sales;
  v_original_line public.sale_lines;
  v_prior_units bigint;
  v_prior_amount bigint;
  v_payment jsonb;
  v_method text;
  v_tendered bigint;
  v_change bigint;
  v_created_at timestamptz;
  v_constraint text;
begin
  -- 1. Who is calling. A waiter carries no register: selling is for the caisse and the admin.
  v_profile := private.require_profile(array['admin', 'cashier']);
  p := private.json_alias(p, 'cart_discount_millimes', array['discount_millimes']);
  v_id := private.json_uuid(p, 'id');
  v_hash := private.json_hash(p);

  -- 2. Serialise all writes for this terminal before reading anything else.
  v_terminal := private.lock_terminal(v_profile.shop_id, p);

  -- 3. Idempotency: a record already recorded or voided returns its stored outcome.
  select s.shop_id, s.payload_hash, s.receipt_number into v_found from public.sales s where s.id = v_id;
  if found then
    if v_found.shop_id <> v_profile.shop_id then
      perform private.raise_error('FORBIDDEN', 'This record belongs to another shop.');
    end if;
    if v_found.payload_hash <> v_hash then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different record was already stored under this id.', jsonb_build_object('id', v_id));
    end if;
    return jsonb_build_object('sale_id', v_id, 'receipt_number', v_found.receipt_number, 'status', 'replayed');
  end if;

  select rv.shop_id, rv.payload_hash, rv.receipt_number into v_found from public.receipt_voids rv where rv.id = v_id;
  if found then
    if v_found.shop_id <> v_profile.shop_id then
      perform private.raise_error('FORBIDDEN', 'This record belongs to another shop.');
    end if;
    if v_found.payload_hash <> v_hash then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different record was already stored under this id.', jsonb_build_object('id', v_id));
    end if;
    return jsonb_build_object('sale_id', v_id, 'receipt_number', v_found.receipt_number, 'status', 'voided');
  end if;

  -- 4. The device holds the current registration.
  perform private.require_epoch(v_terminal, p);

  -- 5. The session exists, is open and belongs to this terminal.
  v_session_id := private.json_uuid(p, 'session_id');
  select * into v_session from public.cash_sessions where id = v_session_id;
  if not found then
    perform private.raise_error('NOT_FOUND', 'The session does not exist.', jsonb_build_object('session_id', v_session_id));
  end if;
  if v_session.shop_id <> v_profile.shop_id or v_session.terminal_id <> v_terminal.id then
    perform private.raise_error('FORBIDDEN', 'The session does not belong to this terminal.', jsonb_build_object('session_id', v_session_id));
  end if;
  if v_session.closed_at is not null then
    perform private.raise_error('SESSION_CLOSED', 'The session was closed before this record arrived.', jsonb_build_object('session_id', v_session_id));
  end if;

  -- 6. Gapless numbering: exactly the next number of this terminal.
  v_seq := private.json_bigint(p, 'seq');
  if v_seq <> v_terminal.last_seq + 1 then
    perform private.raise_error(
      'SEQUENCE_GAP',
      format('Expected receipt %s-%s.', v_terminal.code, v_terminal.last_seq + 1),
      jsonb_build_object('expected_seq', v_terminal.last_seq + 1, 'received_seq', v_seq)
    );
  end if;
  v_receipt := v_terminal.code || '-' || v_seq;

  -- 7. The document: every amount is recomputed from the lines.
  v_kind := private.json_text(p, 'kind');
  if v_kind not in ('sale', 'refund') then
    perform private.raise_error('VALIDATION_ERROR', 'kind must be sale or refund.', jsonb_build_object('field', 'kind'));
  end if;

  v_lines := p -> 'lines';
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    perform private.raise_error('VALIDATION_ERROR', 'A record needs at least one line.', jsonb_build_object('field', 'lines'));
  end if;
  -- Line amounts under the names the café model uses, whatever the device called them.
  select jsonb_agg(
           private.json_alias(
             private.json_alias(e.value, 'allocated_discount_millimes', array['cart_discount_share_millimes']),
             'net_millimes', array['line_total_millimes']
           )
           order by e.ord
         )
  into v_lines
  from jsonb_array_elements(v_lines) with ordinality as e(value, ord);
  p := jsonb_set(p, '{lines}', v_lines);

  if v_kind = 'sale' then
    -- Every line of a sale pays for an item of this table's open order, so the table is part of the
    -- document and not an afterthought.
    v_table_id := private.json_uuid(p, 'table_id');
    if not exists (select 1 from public.dining_tables t where t.id = v_table_id and t.shop_id = v_profile.shop_id) then
      perform private.raise_error('FORBIDDEN', 'This table is not in your shop.', jsonb_build_object('table_id', v_table_id));
    end if;
    select o.id into v_order_id from public.open_orders o where o.table_id = v_table_id and o.status = 'open';
    if v_order_id is null then
      perform private.raise_error(
        'ORDER_CLOSED', 'That table has no open order any more.',
        jsonb_build_object('table_id', v_table_id)
      );
    end if;
  else
    if p ? 'table_id' and jsonb_typeof(p -> 'table_id') <> 'null' then
      perform private.raise_error('VALIDATION_ERROR', 'A refund is not paid at a table.', jsonb_build_object('field', 'table_id'));
    end if;
    v_refunds_sale_id := private.json_uuid(p, 'refunds_sale_id');
    -- Refunds of one sale can arrive from several terminals: take them one at a time, and sum the
    -- earlier refunds only after holding the lock.
    perform pg_advisory_xact_lock(hashtextextended(v_refunds_sale_id::text, 0));
    select * into v_original from public.sales where id = v_refunds_sale_id and shop_id = v_profile.shop_id;
    if not found then
      perform private.raise_error('NOT_FOUND', 'The sale to refund does not exist.', jsonb_build_object('sale_id', v_refunds_sale_id));
    end if;
    if v_original.kind <> 'sale' then
      perform private.raise_error('VALIDATION_ERROR', 'Only a sale can be refunded, not a refund.', jsonb_build_object('field', 'refunds_sale_id'));
    end if;
  end if;

  for v_line in select e.value from jsonb_array_elements(v_lines) e
  loop
    v_line_no := v_line_no + 1;
    if jsonb_typeof(v_line) <> 'object' or private.json_int(v_line, 'line_no') <> v_line_no then
      perform private.raise_error('VALIDATION_ERROR', 'Lines must be numbered 1, 2, 3 in order.', jsonb_build_object('field', 'lines'));
    end if;
    v_product_id := private.json_uuid(v_line, 'product_id');
    perform private.json_text(v_line, 'product_name');
    v_qty := private.json_int(v_line, 'qty');
    v_unit := private.json_bigint(v_line, 'unit_price_millimes');
    v_line_discount := private.json_bigint(v_line, 'line_discount_millimes');
    v_line_reason := nullif(trim(coalesce(private.json_text(v_line, 'line_discount_reason', false), '')), '');
    v_share := private.json_bigint(v_line, 'allocated_discount_millimes');
    v_line_total := private.json_bigint(v_line, 'net_millimes');

    -- Archived products can still be sold offline and refunded.
    if not exists (select 1 from public.products pr where pr.id = v_product_id and pr.shop_id = v_profile.shop_id) then
      perform private.raise_error('NOT_FOUND', 'A line names a product that does not exist.', jsonb_build_object('product_id', v_product_id));
    end if;

    -- A unit price is a product price: at most one billion dinars, the bound
    -- src/ports/catalog.ts reads products and sale lines back with. The line total is qty x unit
    -- price, so it is not bounded the same way, and neither are the discounts or the totals.
    if v_unit > 1000000000000 then
      perform private.raise_error('VALIDATION_ERROR', 'A unit price cannot be above one billion dinars.', jsonb_build_object('line_no', v_line_no));
    end if;

    if v_kind = 'sale' then
      if private.json_first(v_line, array['refunds_sale_line_id', 'refunds_line_no']) is not null then
        perform private.raise_error('VALIDATION_ERROR', 'A sale line cannot refund another line.', jsonb_build_object('line_no', v_line_no));
      end if;

      -- The order item this line pays for. Anything that moved under the terminal — paid, removed,
      -- on another table, or no longer the same product, quantity or price — is ORDER_CHANGED, and
      -- the terminal refreshes the table and pays again.
      v_item_id := private.json_uuid(v_line, 'open_order_item_id');
      if v_item_id = any (v_item_ids) then
        perform private.raise_error('VALIDATION_ERROR', 'An order item can appear on only one line.', jsonb_build_object('line_no', v_line_no));
      end if;
      v_item_ids := v_item_ids || v_item_id;

      select * into v_item
      from public.open_order_items
      where id = v_item_id and shop_id = v_profile.shop_id
      for update;
      if not found or v_item.order_id <> v_order_id or v_item.removed_at is not null or v_item.paid_sale_id is not null
         or v_item.product_id <> v_product_id or v_item.qty <> v_qty or v_item.unit_price_millimes <> v_unit then
        perform private.raise_error(
          'ORDER_CHANGED',
          'This table changed while it was being paid for. Look at it again.',
          jsonb_build_object('table_id', v_table_id, 'item_id', v_item_id, 'line_no', v_line_no)
        );
      end if;

      if v_qty < 1 or v_unit < 0 or v_line_discount < 0 or v_share < 0
         or v_line_discount + v_share > v_qty * v_unit
         or v_line_total <> v_qty * v_unit - v_line_discount - v_share then
        perform private.raise_error('VALIDATION_ERROR', 'Line amounts do not add up.', jsonb_build_object('line_no', v_line_no));
      end if;
      -- An offered item or a discounted line always says why.
      if v_line_discount > 0 and v_line_reason is null then
        perform private.raise_error('VALIDATION_ERROR', 'Say why this line is discounted.', jsonb_build_object('line_no', v_line_no, 'field', 'line_discount_reason'));
      end if;
      v_subtotal := v_subtotal + v_qty * v_unit - v_line_discount;
      v_discount := v_discount + v_share;
    else
      if v_line_reason is not null then
        perform private.raise_error('VALIDATION_ERROR', 'A refund line carries no discount.', jsonb_build_object('line_no', v_line_no));
      end if;
      if private.json_first(v_line, array['open_order_item_id']) is not null then
        perform private.raise_error('VALIDATION_ERROR', 'A refund line pays no order item.', jsonb_build_object('line_no', v_line_no));
      end if;

      -- The line being refunded, by its own id. A payload written before the café model names the
      -- line's number on the original sale instead; both end up at the same row.
      v_refunds_line_id := private.json_uuid(v_line, 'refunds_sale_line_id', false);
      if v_refunds_line_id is null then
        select sl.id into v_refunds_line_id
        from public.sale_lines sl
        where sl.sale_id = v_original.id and sl.line_no = private.json_int(v_line, 'refunds_line_no');
      end if;
      if v_refunds_line_id is null then
        perform private.raise_error('VALIDATION_ERROR', 'A refund line names a line that is not on the sale.', jsonb_build_object('line_no', v_line_no));
      end if;
      if v_refunds_line_id = any (v_seen_refund_lines) then
        perform private.raise_error('VALIDATION_ERROR', 'An original line can appear only once in a refund.', jsonb_build_object('line_no', v_line_no));
      end if;
      v_seen_refund_lines := v_seen_refund_lines || v_refunds_line_id;

      select * into v_original_line from public.sale_lines where id = v_refunds_line_id and sale_id = v_original.id;
      if not found then
        perform private.raise_error('VALIDATION_ERROR', 'A refund line names a line that is not on the sale.', jsonb_build_object('line_no', v_line_no));
      end if;
      if v_product_id <> v_original_line.product_id or v_unit <> v_original_line.unit_price_millimes
         or v_line_discount <> 0 or v_share <> 0 or v_qty > -1 or v_line_total > 0 then
        perform private.raise_error('VALIDATION_ERROR', 'A refund line must match its sale line, with a negative quantity and amount.', jsonb_build_object('line_no', v_line_no));
      end if;

      select coalesce(sum(-sl.qty), 0), coalesce(sum(-sl.line_total_millimes), 0)
      into v_prior_units, v_prior_amount
      from public.sale_lines sl
      join public.sales s on s.id = sl.sale_id
      where s.refunds_sale_id = v_original.id and sl.refunds_sale_line_id = v_refunds_line_id;

      -- Units and amount stay within what is left, and the refund that takes a line's last units
      -- pays exactly what is left of it, so the parts of a line always add up to its total.
      if v_prior_units - v_qty > v_original_line.qty
         or v_prior_amount - v_line_total > v_original_line.line_total_millimes then
        perform private.raise_error(
          'VALIDATION_ERROR',
          'The refund is more than what is left to refund on this line.',
          jsonb_build_object(
            'line_no', v_line_no,
            'remaining_qty', v_original_line.qty - v_prior_units,
            'remaining_millimes', v_original_line.line_total_millimes - v_prior_amount
          )
        );
      end if;
      if v_prior_units - v_qty = v_original_line.qty
         and v_prior_amount - v_line_total <> v_original_line.line_total_millimes then
        perform private.raise_error(
          'VALIDATION_ERROR',
          'A refund of the last units of a line pays exactly what is left of it.',
          jsonb_build_object(
            'line_no', v_line_no,
            'remaining_qty', v_original_line.qty - v_prior_units,
            'remaining_millimes', v_original_line.line_total_millimes - v_prior_amount
          )
        );
      end if;
      v_subtotal := v_subtotal + v_line_total;
      v_line := jsonb_set(v_line, '{refunds_sale_line_id}', to_jsonb(v_refunds_line_id));
      v_lines := jsonb_set(v_lines, array[(v_line_no - 1)::text], v_line);
    end if;
    v_total := v_total + v_line_total;
  end loop;

  -- subtotal_millimes is derived, so a payload that leaves it out is fine; one that states it has
  -- to state the same number the lines add up to.
  if (p ? 'subtotal_millimes' and jsonb_typeof(p -> 'subtotal_millimes') <> 'null'
      and private.json_bigint(p, 'subtotal_millimes') <> v_subtotal)
     or private.json_bigint(p, 'cart_discount_millimes') <> v_discount
     or private.json_bigint(p, 'total_millimes') <> v_total then
    perform private.raise_error(
      'VALIDATION_ERROR',
      'The document totals do not match its lines.',
      jsonb_build_object('subtotal_millimes', v_subtotal, 'cart_discount_millimes', v_discount, 'total_millimes', v_total)
    );
  end if;

  -- Payment. Change only exists for cash; a refund pays out exactly its total.
  v_payment := p -> 'payment';
  if v_payment is null or jsonb_typeof(v_payment) <> 'object' then
    perform private.raise_error('VALIDATION_ERROR', 'payment is required.', jsonb_build_object('field', 'payment'));
  end if;
  v_method := private.json_text(v_payment, 'method');
  v_tendered := private.json_bigint(v_payment, 'tendered_millimes');
  v_change := private.json_bigint(v_payment, 'change_millimes');
  if v_method not in ('cash', 'card') then
    perform private.raise_error('VALIDATION_ERROR', 'The payment method must be cash or card.', jsonb_build_object('field', 'payment.method'));
  end if;
  if v_kind = 'refund' or v_method = 'card' then
    if v_tendered <> v_total or v_change <> 0 then
      perform private.raise_error('VALIDATION_ERROR', 'Card payments and refunds are exactly the total, with no change.', jsonb_build_object('field', 'payment'));
    end if;
  elsif v_tendered < v_total or v_change <> v_tendered - v_total then
    perform private.raise_error('VALIDATION_ERROR', 'Change must be the amount tendered minus the total.', jsonb_build_object('field', 'payment'));
  end if;

  v_created_at := private.json_timestamptz(p, 'created_at');

  -- 8. Write. Products are locked in id order so two terminals never deadlock on stock.
  perform 1
  from public.products pr
  where pr.shop_id = v_profile.shop_id
    and pr.id in (select (e.value ->> 'product_id')::uuid from jsonb_array_elements(v_lines) e)
  order by pr.id
  for update;

  begin
    insert into public.sales (
      id, shop_id, terminal_id, session_id, kind, seq, receipt_number, refunds_sale_id, table_id, payment_method,
      subtotal_millimes, cart_discount_millimes, total_millimes, tendered_millimes, change_millimes,
      epoch, payload_hash, submitted_by, created_at
    )
    values (
      v_id, v_profile.shop_id, v_terminal.id, v_session.id, v_kind, v_seq, v_receipt, v_refunds_sale_id, v_table_id, v_method,
      v_subtotal, v_discount, v_total, v_tendered, v_change,
      v_terminal.epoch, v_hash, v_profile.user_id, v_created_at
    );
  exception when unique_violation then
    -- Another terminal stored a record under the same id after the idempotency check above.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint in ('sales_pkey', 'sales_id_shop_id_key') then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different record was already stored under this id.', jsonb_build_object('id', v_id));
    end if;
    raise;
  end;

  for v_line in select e.value from jsonb_array_elements(v_lines) e
  loop
    v_qty := (v_line ->> 'qty')::integer;
    v_product_id := (v_line ->> 'product_id')::uuid;
    insert into public.sale_lines (
      sale_id, shop_id, line_no, product_id, product_name, qty, unit_price_millimes,
      line_discount_millimes, line_discount_reason, allocated_discount_millimes, line_total_millimes,
      open_order_item_id, refunds_sale_line_id
    )
    values (
      v_id, v_profile.shop_id, (v_line ->> 'line_no')::integer, v_product_id, v_line ->> 'product_name', v_qty,
      (v_line ->> 'unit_price_millimes')::bigint, (v_line ->> 'line_discount_millimes')::bigint,
      nullif(trim(coalesce(v_line ->> 'line_discount_reason', '')), ''),
      (v_line ->> 'allocated_discount_millimes')::bigint, (v_line ->> 'net_millimes')::bigint,
      (v_line ->> 'open_order_item_id')::uuid, (v_line ->> 'refunds_sale_line_id')::uuid
    );
    -- A sale takes units out of stock; a refund puts them back, for the products the shop counts.
    -- Stock never blocks a sale and may go negative.
    if (select pr.track_stock from public.products pr where pr.id = v_product_id) then
      perform private.move_stock(
        v_profile.shop_id, v_product_id, -v_qty,
        case when v_kind = 'sale' then 'sale' else 'refund' end,
        v_id, '', v_profile.user_id
      );
    end if;
  end loop;

  -- The items this sale paid for, and the table it leaves behind: an order with nothing unpaid
  -- left on it closes, so a table can be paid in parts and is free when the last part is settled.
  if v_kind = 'sale' then
    update public.open_order_items set paid_sale_id = v_id where id = any (v_item_ids);
    perform private.close_order_if_settled(v_order_id);
  end if;

  update public.terminals set last_seq = v_seq where id = v_terminal.id;

  return jsonb_build_object('sale_id', v_id, 'receipt_number', v_receipt, 'status', 'created');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Functions created in public after migration 20260911000008 keep PUBLIC's default EXECUTE, which
-- a per-schema default cannot take away: every one of them revokes it for itself.
revoke all on function
  public.order_item_add(jsonb),
  public.order_item_remove(jsonb),
  public.order_send(jsonb),
  public.order_item_prepare(jsonb),
  public.order_cancel(jsonb),
  public.adjust_stock(jsonb),
  public.removed_after_sent(timestamptz, timestamptz)
from public, anon;

grant execute on function
  public.order_item_add(jsonb),
  public.order_item_remove(jsonb),
  public.order_send(jsonb),
  public.order_item_prepare(jsonb),
  public.order_cancel(jsonb),
  public.adjust_stock(jsonb),
  public.removed_after_sent(timestamptz, timestamptz)
to authenticated;

revoke all on all functions in schema private from public, anon;
grant execute on function private.current_shop_id(), private.current_roles(), private.current_is_admin() to authenticated;
