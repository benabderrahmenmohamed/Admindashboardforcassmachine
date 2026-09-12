-- The sales ledger. Rows are written only by record_sale and never updated or deleted: a refund is
-- a new document with negative quantities and amounts that points at the sale it refunds.
create table public.sales (
  id uuid primary key,
  shop_id uuid not null,
  terminal_id uuid not null,
  session_id uuid not null,
  kind text not null check (kind in ('sale', 'refund')),
  seq bigint not null check (seq > 0),
  receipt_number text not null,
  refunds_sale_id uuid references public.sales (id) on delete restrict,
  payment_method text not null check (payment_method in ('cash', 'card')),
  subtotal_millimes bigint not null,
  discount_millimes bigint not null check (discount_millimes >= 0),
  total_millimes bigint not null,
  tendered_millimes bigint not null,
  change_millimes bigint not null check (change_millimes >= 0),
  epoch integer not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  submitted_by uuid not null references auth.users (id) on delete restrict,
  -- Written by the device and not trusted for anything; received_at is the server's clock.
  created_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (terminal_id, seq),
  unique (id, shop_id),
  foreign key (terminal_id, shop_id) references public.terminals (id, shop_id) on delete restrict,
  foreign key (session_id, shop_id) references public.cash_sessions (id, shop_id) on delete restrict,
  constraint sales_totals check (
    total_millimes = subtotal_millimes - discount_millimes
    and tendered_millimes - change_millimes = total_millimes
  ),
  constraint sales_kind_shape check (
    (kind = 'sale' and refunds_sale_id is null and total_millimes >= 0)
    or (kind = 'refund' and refunds_sale_id is not null and total_millimes <= 0 and discount_millimes = 0 and change_millimes = 0)
  ),
  constraint sales_card_without_change check (payment_method = 'cash' or change_millimes = 0)
);
create index sales_session_id_idx on public.sales (session_id);
create index sales_shop_id_received_at_idx on public.sales (shop_id, received_at desc);
create index sales_refunds_sale_id_idx on public.sales (refunds_sale_id) where refunds_sale_id is not null;

create table public.sale_lines (
  sale_id uuid not null,
  shop_id uuid not null,
  line_no integer not null check (line_no >= 1),
  product_id uuid not null,
  -- What the receipt showed, kept even if the product is renamed later.
  product_name text not null,
  qty integer not null check (qty <> 0),
  -- A product price, so up to one billion dinars like products.price_millimes and
  -- MAX_PRICE_MILLIMES in src/ports/catalog.ts, which reads this column back.
  unit_price_millimes bigint not null check (unit_price_millimes >= 0 and unit_price_millimes <= 1000000000000),
  line_discount_millimes bigint not null check (line_discount_millimes >= 0),
  -- This line's part of the cart discount, allocated at sale time (largest remainder).
  cart_discount_share_millimes bigint not null check (cart_discount_share_millimes >= 0),
  -- qty x unit price less the discounts, so a large enough quantity is legitimately above the price
  -- cap: only the per-unit price is bounded. The same for the discounts and the document totals.
  line_total_millimes bigint not null,
  refunds_line_no integer,
  primary key (sale_id, line_no),
  foreign key (sale_id, shop_id) references public.sales (id, shop_id) on delete restrict,
  foreign key (product_id, shop_id) references public.products (id, shop_id) on delete restrict,
  constraint sale_lines_shape check (
    (
      qty > 0 and refunds_line_no is null
      and line_discount_millimes + cart_discount_share_millimes <= qty * unit_price_millimes
      and line_total_millimes = qty * unit_price_millimes - line_discount_millimes - cart_discount_share_millimes
    )
    or (
      qty < 0 and refunds_line_no is not null
      and line_discount_millimes = 0 and cart_discount_share_millimes = 0 and line_total_millimes <= 0
    )
  )
);
create index sale_lines_product_id_idx on public.sale_lines (product_id);

-- A numbered record that could never be accepted (for example a refund of more than was left,
-- recorded offline), voided by an admin so the terminal's numbering stays gapless and its queue can
-- move on. Every receipt number is either in sales or here, never both.
create table public.receipt_voids (
  id uuid primary key,
  shop_id uuid not null,
  terminal_id uuid not null,
  session_id uuid references public.cash_sessions (id) on delete restrict,
  seq bigint not null check (seq > 0),
  receipt_number text not null,
  payload jsonb not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  error_code text not null check (length(trim(error_code)) > 0),
  reason text not null check (length(trim(reason)) > 0),
  voided_by uuid not null references auth.users (id) on delete restrict,
  voided_at timestamptz not null default now(),
  unique (terminal_id, seq),
  foreign key (terminal_id, shop_id) references public.terminals (id, shop_id) on delete restrict
);
create index receipt_voids_session_id_idx on public.receipt_voids (session_id) where session_id is not null;

alter table public.stock_movements
  add constraint stock_movements_sale_id_fkey foreign key (sale_id) references public.sales (id) on delete restrict;

-- p = { id, kind, terminal_code, epoch, seq, session_id, created_at, payload_hash,
--       lines: [{ line_no, product_id, product_name, qty, unit_price_millimes, line_discount_millimes,
--                 cart_discount_share_millimes, line_total_millimes, refunds_line_no? }],
--       subtotal_millimes, discount_millimes, total_millimes,
--       payment: { method, tendered_millimes, change_millimes },
--       refunds_sale_id? }
-- Returns { sale_id, receipt_number, status: 'created' | 'replayed' | 'voided' }.
-- The order of checks is part of the contract (contracts/errors.md); a Spring service implementing
-- POST /api/v1/sales follows the same order in one READ COMMITTED transaction.
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
  v_share bigint;
  v_line_total bigint;
  v_refunds_line_no integer;
  v_seen_refund_lines integer[] := '{}';
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
  -- 1. Who is calling. No session is UNAUTHENTICATED; no shop membership is FORBIDDEN.
  v_profile := private.require_profile();
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

  if v_kind = 'refund' then
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
  elsif p ? 'refunds_sale_id' and jsonb_typeof(p -> 'refunds_sale_id') <> 'null' then
    perform private.raise_error('VALIDATION_ERROR', 'Only a refund names a sale to refund.', jsonb_build_object('field', 'refunds_sale_id'));
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
    v_share := private.json_bigint(v_line, 'cart_discount_share_millimes');
    v_line_total := private.json_bigint(v_line, 'line_total_millimes');

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
      if v_line ? 'refunds_line_no' and jsonb_typeof(v_line -> 'refunds_line_no') <> 'null' then
        perform private.raise_error('VALIDATION_ERROR', 'A sale line cannot refund another line.', jsonb_build_object('line_no', v_line_no));
      end if;
      if v_qty < 1 or v_unit < 0 or v_line_discount < 0 or v_share < 0
         or v_line_discount + v_share > v_qty * v_unit
         or v_line_total <> v_qty * v_unit - v_line_discount - v_share then
        perform private.raise_error('VALIDATION_ERROR', 'Line amounts do not add up.', jsonb_build_object('line_no', v_line_no));
      end if;
      v_subtotal := v_subtotal + v_qty * v_unit - v_line_discount;
      v_discount := v_discount + v_share;
    else
      v_refunds_line_no := private.json_int(v_line, 'refunds_line_no');
      if v_refunds_line_no = any (v_seen_refund_lines) then
        perform private.raise_error('VALIDATION_ERROR', 'An original line can appear only once in a refund.', jsonb_build_object('line_no', v_line_no));
      end if;
      v_seen_refund_lines := v_seen_refund_lines || v_refunds_line_no;

      select * into v_original_line from public.sale_lines where sale_id = v_original.id and line_no = v_refunds_line_no;
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
      where s.refunds_sale_id = v_original.id and sl.refunds_line_no = v_refunds_line_no;

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
    end if;
    v_total := v_total + v_line_total;
  end loop;

  if private.json_bigint(p, 'subtotal_millimes') <> v_subtotal
     or private.json_bigint(p, 'discount_millimes') <> v_discount
     or private.json_bigint(p, 'total_millimes') <> v_total then
    perform private.raise_error(
      'VALIDATION_ERROR',
      'The document totals do not match its lines.',
      jsonb_build_object('subtotal_millimes', v_subtotal, 'discount_millimes', v_discount, 'total_millimes', v_total)
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
      id, shop_id, terminal_id, session_id, kind, seq, receipt_number, refunds_sale_id, payment_method,
      subtotal_millimes, discount_millimes, total_millimes, tendered_millimes, change_millimes,
      epoch, payload_hash, submitted_by, created_at
    )
    values (
      v_id, v_profile.shop_id, v_terminal.id, v_session.id, v_kind, v_seq, v_receipt, v_refunds_sale_id, v_method,
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
      line_discount_millimes, cart_discount_share_millimes, line_total_millimes, refunds_line_no
    )
    values (
      v_id, v_profile.shop_id, (v_line ->> 'line_no')::integer, v_product_id, v_line ->> 'product_name', v_qty,
      (v_line ->> 'unit_price_millimes')::bigint, (v_line ->> 'line_discount_millimes')::bigint,
      (v_line ->> 'cart_discount_share_millimes')::bigint, (v_line ->> 'line_total_millimes')::bigint,
      (v_line ->> 'refunds_line_no')::integer
    );
    -- A sale takes units out of stock; a refund puts them back. Stock may go negative: a sale that
    -- happened is never refused for stock.
    perform private.move_stock(
      v_profile.shop_id, v_product_id, -v_qty,
      case when v_kind = 'sale' then 'sale' else 'refund' end,
      v_id, '', v_profile.user_id
    );
  end loop;

  update public.terminals set last_seq = v_seq where id = v_terminal.id;

  return jsonb_build_object('sale_id', v_id, 'receipt_number', v_receipt, 'status', 'created');
end;
$$;

-- p = { record: <the numbered record exactly as queued>, error_code, reason }
-- Admin-only and audited. Voids the terminal's next receipt number so the queue behind it can
-- drain. The same record (same id and hash) that did reach the ledger comes back as 'recorded'
-- instead; another record stored under that id is IDEMPOTENCY_CONFLICT.
create or replace function public.void_receipt(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_record jsonb := p -> 'record';
  v_id uuid;
  v_hash text;
  v_reason text;
  v_error_code text;
  v_terminal public.terminals;
  v_found record;
  v_seq bigint;
  v_receipt text;
  v_session_id uuid;
  v_constraint text;
begin
  v_profile := private.require_profile(array['admin']);
  if v_record is null or jsonb_typeof(v_record) <> 'object' then
    perform private.raise_error('VALIDATION_ERROR', 'record is required.', jsonb_build_object('field', 'record'));
  end if;
  v_id := private.json_uuid(v_record, 'id');
  v_hash := private.json_hash(v_record);
  v_error_code := private.json_text(p, 'error_code');
  v_reason := trim(private.json_text(p, 'reason'));
  if v_reason = '' then
    perform private.raise_error('VALIDATION_ERROR', 'Say why this receipt is being voided.', jsonb_build_object('field', 'reason'));
  end if;

  v_terminal := private.lock_terminal(v_profile.shop_id, v_record);

  select s.shop_id, s.payload_hash, s.receipt_number into v_found from public.sales s where s.id = v_id;
  if found then
    if v_found.shop_id <> v_profile.shop_id then
      perform private.raise_error('FORBIDDEN', 'This record belongs to another shop.');
    end if;
    if v_found.payload_hash <> v_hash then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different record was already stored under this id.', jsonb_build_object('id', v_id));
    end if;
    return jsonb_build_object('sale_id', v_id, 'receipt_number', v_found.receipt_number, 'status', 'recorded');
  end if;

  select rv.shop_id, rv.receipt_number, rv.payload_hash into v_found from public.receipt_voids rv where rv.id = v_id;
  if found then
    if v_found.shop_id <> v_profile.shop_id then
      perform private.raise_error('FORBIDDEN', 'This record belongs to another shop.');
    end if;
    if v_found.payload_hash <> v_hash then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different record was already voided under this id.', jsonb_build_object('id', v_id));
    end if;
    return jsonb_build_object('sale_id', v_id, 'receipt_number', v_found.receipt_number, 'status', 'replayed');
  end if;

  v_seq := private.json_bigint(v_record, 'seq');
  if v_seq <> v_terminal.last_seq + 1 then
    perform private.raise_error(
      'SEQUENCE_GAP',
      format('Receipts are voided in order: the next one is %s-%s.', v_terminal.code, v_terminal.last_seq + 1),
      jsonb_build_object('expected_seq', v_terminal.last_seq + 1, 'received_seq', v_seq)
    );
  end if;
  v_receipt := v_terminal.code || '-' || v_seq;

  -- The record may be malformed (that can be why it is voided): a session id that is not a UUID of
  -- this terminal's sessions leaves the void without a session.
  v_session_id := private.try_uuid(v_record ->> 'session_id');
  select cs.id into v_session_id
  from public.cash_sessions cs
  where cs.id = v_session_id and cs.terminal_id = v_terminal.id;

  begin
    insert into public.receipt_voids (id, shop_id, terminal_id, session_id, seq, receipt_number, payload, payload_hash, error_code, reason, voided_by)
    values (v_id, v_profile.shop_id, v_terminal.id, v_session_id, v_seq, v_receipt, v_record, v_hash, v_error_code, v_reason, v_profile.user_id);
  exception when unique_violation then
    -- Another terminal voided a record under the same id after the checks above.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'receipt_voids_pkey' then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different record was already voided under this id.', jsonb_build_object('id', v_id));
    end if;
    raise;
  end;

  update public.terminals set last_seq = v_seq where id = v_terminal.id;

  return jsonb_build_object('sale_id', v_id, 'receipt_number', v_receipt, 'status', 'voided');
end;
$$;
