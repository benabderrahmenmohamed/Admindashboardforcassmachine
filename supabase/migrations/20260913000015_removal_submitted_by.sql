-- The login a removal was sent under, beside the person it names.
--
-- An order record names its author (actor_user_id, read by private.order_actor), and the server can
-- only check that the author belongs to the shop: a phone passed from one waiter to the next sends the
-- first one's records under the second one's login, and that is the case the author is for. It also
-- means removed_by is the device's word. order_records.submitted_by has always kept the login each
-- record was sent under, but nothing tied a removed item to its record, so the removed-after-sent
-- report could not show it.
--
-- This stamps that login on the item as a removal or a cancel takes it off, and the report returns it
-- next to the author: an admin sees when a removal names someone other than the login that sent it.
-- An item taken off before this migration has none — who sent it was never written down — and the
-- report says nothing about it. Nothing else about the three functions migration 20260911000011
-- wrote changes.

alter table public.open_order_items
  add column removal_submitted_by uuid references auth.users (id) on delete restrict,
  add constraint open_order_items_submitted_is_removed
    check (removal_submitted_by is null or removed_at is not null);

-- ---------------------------------------------------------------------------------------------
-- p = { id, item_id, reason, created_at, device_id, payload_hash, actor_user_id? }
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
    set removed_at = now(), removed_by = v_actor, removed_reason = v_reason,
        removal_submitted_by = v_profile.user_id
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

-- ---------------------------------------------------------------------------------------------
-- p = { id, table_id, reason, created_at, device_id, payload_hash, actor_user_id? }
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
  set removed_at = now(), removed_by = v_actor, removed_reason = v_reason,
      removal_submitted_by = v_profile.user_id
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
-- Admin report: what was taken off a table after the kitchen had already been told, per waiter.
-- That is the classic waiter fraud, so it is a report and not a footnote. Both ends of the period
-- are required; the rows come back newest first. submitted_by is the login the removal was sent
-- under, null for an item taken off before that was recorded.
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
          'removed_reason', coalesce(i.removed_reason, ''),
          'submitted_by', i.removal_submitted_by,
          'submitted_by_name', case when i.removal_submitted_by is null then null else coalesce(sp.display_name, '') end
        )
        order by i.removed_at desc, i.id
      )
      from public.open_order_items i
      join public.open_orders o on o.id = i.order_id
      join public.dining_tables t on t.id = o.table_id
      left join public.profiles pr on pr.user_id = i.removed_by
      left join public.profiles sp on sp.user_id = i.removal_submitted_by
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

revoke all on function
  public.order_item_remove(jsonb),
  public.order_cancel(jsonb),
  public.removed_after_sent(timestamptz, timestamptz)
from public, anon;

grant execute on function
  public.order_item_remove(jsonb),
  public.order_cancel(jsonb),
  public.removed_after_sent(timestamptz, timestamptz)
to authenticated;
