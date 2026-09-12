create table public.terminals (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9]{1,8}$'),
  -- The last receipt number used by this terminal, across sales, refunds and voided receipts.
  last_seq bigint not null default 0 check (last_seq >= 0),
  -- Bumped by every registration. A device holding an older epoch has been replaced.
  epoch integer not null default 0 check (epoch >= 0),
  created_at timestamptz not null default now(),
  unique (shop_id, code),
  unique (id, shop_id)
);

-- A session id is chosen by the device (it may open the session offline). Opening and closing are
-- idempotent: a replayed request with the same payload hash returns the stored outcome.
create table public.cash_sessions (
  id uuid primary key,
  shop_id uuid not null,
  terminal_id uuid not null,
  opened_by uuid not null references auth.users (id) on delete restrict,
  open_submitted_by uuid not null references auth.users (id) on delete restrict,
  opened_at timestamptz not null,
  open_received_at timestamptz not null default now(),
  opening_float_millimes bigint not null check (opening_float_millimes >= 0),
  open_payload_hash text not null check (open_payload_hash ~ '^[0-9a-f]{64}$'),
  close_request_id uuid unique,
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete restrict,
  close_submitted_by uuid references auth.users (id) on delete restrict,
  close_received_at timestamptz,
  closing_counted_millimes bigint check (closing_counted_millimes >= 0),
  close_payload_hash text check (close_payload_hash ~ '^[0-9a-f]{64}$'),
  -- Set when an admin closes a session whose device lost its local state.
  force_close_reason text,
  server_z_report jsonb,
  client_z_report jsonb,
  unique (id, shop_id),
  foreign key (terminal_id, shop_id) references public.terminals (id, shop_id) on delete restrict,
  constraint cash_sessions_close_fields check (
    (
      closed_at is null and closed_by is null and close_submitted_by is null and close_received_at is null
      and closing_counted_millimes is null and close_payload_hash is null and close_request_id is null
      and force_close_reason is null and server_z_report is null
    )
    or (
      closed_at is not null and closed_by is not null and close_submitted_by is not null
      and close_received_at is not null and server_z_report is not null
      and (
        (force_close_reason is null and closing_counted_millimes is not null and close_payload_hash is not null and close_request_id is not null)
        or (force_close_reason is not null and closing_counted_millimes is null)
      )
    )
  )
);
create unique index cash_sessions_one_open_per_terminal on public.cash_sessions (terminal_id) where closed_at is null;
create index cash_sessions_shop_id_idx on public.cash_sessions (shop_id);

-- A closed session is final.
create or replace function private.reject_closed_session_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.closed_at is not null then
    raise exception using
      errcode = 'PT409',
      message = 'SESSION_CLOSED',
      detail = jsonb_build_object('session_id', old.id)::text,
      hint = 'A closed session cannot change.';
  end if;
  return new;
end;
$$;

create trigger cash_sessions_closed_are_final before update on public.cash_sessions
  for each row execute function private.reject_closed_session_update();

-- Locks the caller's terminal named in the payload. Every RPC that writes for a terminal takes this
-- lock first, before any other read, so concurrent and retried requests for one terminal run one at
-- a time and each later statement sees the committed result of the previous request.
create or replace function private.lock_terminal(p_shop_id uuid, p jsonb)
returns public.terminals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := private.json_text(p, 'terminal_code');
  v_terminal public.terminals;
begin
  select * into v_terminal from public.terminals where shop_id = p_shop_id and code = v_code for update;
  if not found then
    perform private.raise_error('FORBIDDEN', 'This terminal is not registered in your shop.', jsonb_build_object('terminal_code', v_code));
  end if;
  return v_terminal;
end;
$$;

create or replace function private.require_epoch(p_terminal public.terminals, p jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if private.json_int(p, 'epoch') <> p_terminal.epoch then
    perform private.raise_error(
      'TERMINAL_SUPERSEDED',
      'This terminal was registered again on another device. Register this device again.',
      jsonb_build_object('terminal_code', p_terminal.code, 'current_epoch', p_terminal.epoch)
    );
  end if;
end;
$$;

create or replace function private.session_json(v public.cash_sessions)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.id,
    'terminal_id', v.terminal_id,
    'terminal_code', (select t.code from public.terminals t where t.id = v.terminal_id),
    'opened_by', v.opened_by,
    'opened_at', v.opened_at,
    'opening_float_millimes', v.opening_float_millimes,
    'closed_at', v.closed_at,
    'closed_by', v.closed_by,
    'closing_counted_millimes', v.closing_counted_millimes,
    'force_close_reason', v.force_close_reason,
    'z_report', v.server_z_report
  )
$$;

-- The Z-report of a session. Documents belong to the session named on them (never grouped by
-- clock time). Refund totals are negative in the ledger and reported here as positive amounts.
--   gross    = sum of sale totals            refunds = -(sum of refund totals)     net = gross - refunds
--   expected_cash = opening float + cash sales - cash refunds
--   variance = counted - expected (null while the session is open)
create or replace function private.compute_z_report(p_session_id uuid, p_counted bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session public.cash_sessions;
  v_report jsonb;
begin
  select * into v_session from public.cash_sessions where id = p_session_id;

  with totals as (
    select
      count(*) filter (where s.kind = 'sale') as sales_count,
      count(*) filter (where s.kind = 'refund') as refunds_count,
      coalesce(sum(s.total_millimes) filter (where s.kind = 'sale'), 0) as gross,
      coalesce(-sum(s.total_millimes) filter (where s.kind = 'refund'), 0) as refunds,
      coalesce(sum(s.total_millimes) filter (where s.kind = 'sale' and s.payment_method = 'cash'), 0) as cash_sales,
      coalesce(-sum(s.total_millimes) filter (where s.kind = 'refund' and s.payment_method = 'cash'), 0) as cash_refunds,
      coalesce(sum(s.total_millimes) filter (where s.kind = 'sale' and s.payment_method = 'card'), 0) as card_sales,
      coalesce(-sum(s.total_millimes) filter (where s.kind = 'refund' and s.payment_method = 'card'), 0) as card_refunds
    from public.sales s
    where s.session_id = p_session_id
  )
  select jsonb_build_object(
    'session_id', v_session.id,
    'opening_float_millimes', v_session.opening_float_millimes,
    'sales_count', t.sales_count,
    'refunds_count', t.refunds_count,
    'gross_millimes', t.gross,
    'refunds_millimes', t.refunds,
    'net_millimes', t.gross - t.refunds,
    'by_method', jsonb_build_object(
      'cash', jsonb_build_object('sales_millimes', t.cash_sales, 'refunds_millimes', t.cash_refunds, 'net_millimes', t.cash_sales - t.cash_refunds),
      'card', jsonb_build_object('sales_millimes', t.card_sales, 'refunds_millimes', t.card_refunds, 'net_millimes', t.card_sales - t.card_refunds)
    ),
    'expected_cash_millimes', v_session.opening_float_millimes + t.cash_sales - t.cash_refunds,
    'counted_cash_millimes', p_counted,
    'variance_millimes', case
      when p_counted is null then null
      else p_counted - (v_session.opening_float_millimes + t.cash_sales - t.cash_refunds)
    end,
    'voids_count', (select count(*) from public.receipt_voids rv where rv.session_id = p_session_id)
  )
  into v_report
  from totals t;

  return v_report;
end;
$$;

-- Admin-only. Creates the terminal on first use and bumps its epoch on every registration, so the
-- device registered last is the only one whose records are accepted. Returns the counter to adopt
-- and the terminal's open session, if any, which the new device continues.
create or replace function public.register_terminal(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_terminal public.terminals;
  v_open public.cash_sessions;
begin
  v_profile := private.require_profile(array['admin']);
  if v_code !~ '^[A-Z0-9]{1,8}$' then
    perform private.raise_error('VALIDATION_ERROR', 'A terminal code is 1 to 8 letters or digits.', jsonb_build_object('field', 'code'));
  end if;

  insert into public.terminals as t (shop_id, code)
  values (v_profile.shop_id, v_code)
  on conflict (shop_id, code) do update set epoch = t.epoch + 1
  returning * into v_terminal;

  select * into v_open from public.cash_sessions where terminal_id = v_terminal.id and closed_at is null;

  return jsonb_build_object(
    'terminal_id', v_terminal.id,
    'code', v_terminal.code,
    'last_seq', v_terminal.last_seq,
    'epoch', v_terminal.epoch,
    'open_session', case when v_open.id is null then null else private.session_json(v_open) end
  );
end;
$$;

-- p = { id, terminal_code, epoch, actor_user_id, opened_at, opening_float_millimes, payload_hash }
-- Checks in the order of contracts/errors.md: caller, terminal lock, replay, epoch,
-- SESSION_ALREADY_OPEN, then the actor and the payload.
create or replace function public.open_session(p jsonb)
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
  v_existing public.cash_sessions;
  v_actor uuid;
  v_float bigint;
  v_opened_at timestamptz;
  v_open_id uuid;
  v_constraint text;
begin
  v_profile := private.require_profile();
  v_id := private.json_uuid(p, 'id');
  v_hash := private.json_hash(p);

  v_terminal := private.lock_terminal(v_profile.shop_id, p);

  select * into v_existing from public.cash_sessions where id = v_id;
  if found then
    if v_existing.shop_id <> v_profile.shop_id then
      perform private.raise_error('FORBIDDEN', 'This session belongs to another shop.');
    end if;
    if v_existing.open_payload_hash <> v_hash then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different session was already opened under this id.', jsonb_build_object('id', v_id));
    end if;
    return jsonb_build_object('session_id', v_id, 'status', 'replayed', 'session', private.session_json(v_existing));
  end if;

  perform private.require_epoch(v_terminal, p);

  select id into v_open_id from public.cash_sessions where terminal_id = v_terminal.id and closed_at is null;
  if v_open_id is not null then
    perform private.raise_error('SESSION_ALREADY_OPEN', 'This terminal already has an open session.', jsonb_build_object('open_session_id', v_open_id));
  end if;

  v_actor := private.require_member(v_profile.shop_id, p);
  v_float := private.json_bigint(p, 'opening_float_millimes');
  if v_float < 0 then
    perform private.raise_error('VALIDATION_ERROR', 'The opening float cannot be negative.', jsonb_build_object('field', 'opening_float_millimes'));
  end if;
  v_opened_at := private.json_timestamptz(p, 'opened_at');

  begin
    insert into public.cash_sessions (id, shop_id, terminal_id, opened_by, open_submitted_by, opened_at, opening_float_millimes, open_payload_hash)
    values (v_id, v_profile.shop_id, v_terminal.id, v_actor, v_profile.user_id, v_opened_at, v_float, v_hash)
    returning * into v_existing;
  exception when unique_violation then
    -- Another terminal stored a session under the same id after the replay check above.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint in ('cash_sessions_pkey', 'cash_sessions_id_shop_id_key') then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different session was already opened under this id.', jsonb_build_object('id', v_id));
    end if;
    raise;
  end;

  return jsonb_build_object('session_id', v_id, 'status', 'created', 'session', private.session_json(v_existing));
end;
$$;

-- p = { id (the close request), session_id, terminal_code, epoch, actor_user_id, closed_at,
--       closing_counted_millimes, client_z_report, payload_hash }
-- Only the terminal that owns the session can close it, so every record that terminal queued for
-- the session has already been accepted by the time its close arrives. Checks in the order of
-- contracts/errors.md: caller, terminal lock, replay, epoch, session, then the actor and the payload.
create or replace function public.close_session(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_request uuid;
  v_hash text;
  v_terminal public.terminals;
  v_session_id uuid;
  v_session public.cash_sessions;
  v_actor uuid;
  v_counted bigint;
  v_client_report jsonb;
  v_closed_at timestamptz;
  v_report jsonb;
  v_constraint text;
begin
  v_profile := private.require_profile();
  v_request := private.json_uuid(p, 'id');
  v_hash := private.json_hash(p);

  v_terminal := private.lock_terminal(v_profile.shop_id, p);

  select * into v_session from public.cash_sessions where close_request_id = v_request;
  if found then
    if v_session.shop_id <> v_profile.shop_id then
      perform private.raise_error('FORBIDDEN', 'This session belongs to another shop.');
    end if;
    if v_session.close_payload_hash <> v_hash then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different close was already stored under this id.', jsonb_build_object('id', v_request));
    end if;
    return jsonb_build_object('session_id', v_session.id, 'status', 'replayed', 'z_report', v_session.server_z_report);
  end if;

  perform private.require_epoch(v_terminal, p);

  -- Read at the session step, so a session_id that is not a UUID cannot answer before the terminal,
  -- the replay and the epoch (contracts/errors.md, order of checks).
  v_session_id := private.json_uuid(p, 'session_id');
  select * into v_session from public.cash_sessions where id = v_session_id;
  if not found then
    perform private.raise_error('NOT_FOUND', 'The session does not exist.', jsonb_build_object('session_id', v_session_id));
  end if;
  if v_session.shop_id <> v_profile.shop_id or v_session.terminal_id <> v_terminal.id then
    perform private.raise_error('FORBIDDEN', 'Only the terminal that opened a session can close it.', jsonb_build_object('session_id', v_session.id));
  end if;
  if v_session.closed_at is not null then
    perform private.raise_error('SESSION_CLOSED', 'The session is already closed.', jsonb_build_object('session_id', v_session.id));
  end if;

  v_actor := private.require_member(v_profile.shop_id, p);
  v_counted := private.json_bigint(p, 'closing_counted_millimes');
  if v_counted < 0 then
    perform private.raise_error('VALIDATION_ERROR', 'Counted cash cannot be negative.', jsonb_build_object('field', 'closing_counted_millimes'));
  end if;
  v_client_report := p -> 'client_z_report';
  if v_client_report is not null and jsonb_typeof(v_client_report) not in ('object', 'null') then
    perform private.raise_error('VALIDATION_ERROR', 'client_z_report must be an object.', jsonb_build_object('field', 'client_z_report'));
  end if;
  v_closed_at := private.json_timestamptz(p, 'closed_at');

  v_report := private.compute_z_report(v_session.id, v_counted);

  begin
    update public.cash_sessions
    set close_request_id = v_request,
        closed_at = v_closed_at,
        closed_by = v_actor,
        close_submitted_by = v_profile.user_id,
        close_received_at = now(),
        closing_counted_millimes = v_counted,
        close_payload_hash = v_hash,
        server_z_report = v_report,
        client_z_report = nullif(v_client_report, 'null'::jsonb)
    where id = v_session.id;
  exception when unique_violation then
    -- Another terminal stored a close under the same request id after the replay check above.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'cash_sessions_close_request_id_key' then
      perform private.raise_error('IDEMPOTENCY_CONFLICT', 'A different close was already stored under this id.', jsonb_build_object('id', v_request));
    end if;
    raise;
  end;

  return jsonb_build_object('session_id', v_session.id, 'status', 'created', 'z_report', v_report);
end;
$$;

-- Admin-only escape hatch for a session left open by a device that lost its local state (its
-- records then surface as SESSION_ALREADY_OPEN). Counted cash stays unknown.
create or replace function public.force_close_session(p_session_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_session public.cash_sessions;
  v_report jsonb;
begin
  v_profile := private.require_profile(array['admin']);
  if trim(coalesce(p_reason, '')) = '' then
    perform private.raise_error('VALIDATION_ERROR', 'Say why the session is being closed.', jsonb_build_object('field', 'reason'));
  end if;

  select * into v_session from public.cash_sessions where id = p_session_id;
  if not found then
    perform private.raise_error('NOT_FOUND', 'The session does not exist.', jsonb_build_object('session_id', p_session_id));
  end if;
  if v_session.shop_id <> v_profile.shop_id then
    perform private.raise_error('FORBIDDEN', 'This session belongs to another shop.', jsonb_build_object('session_id', p_session_id));
  end if;
  perform 1 from public.terminals where id = v_session.terminal_id for update;
  select * into v_session from public.cash_sessions where id = p_session_id;
  if v_session.closed_at is not null then
    perform private.raise_error('SESSION_CLOSED', 'The session is already closed.', jsonb_build_object('session_id', p_session_id));
  end if;

  v_report := private.compute_z_report(v_session.id, null);
  update public.cash_sessions
  set closed_at = now(),
      closed_by = v_profile.user_id,
      close_submitted_by = v_profile.user_id,
      close_received_at = now(),
      force_close_reason = trim(p_reason),
      server_z_report = v_report
  where id = v_session.id;

  return jsonb_build_object('session_id', v_session.id, 'status', 'created', 'z_report', v_report);
end;
$$;

-- The stored report of a closed session, or the running report of an open one.
create or replace function public.z_report(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_session public.cash_sessions;
begin
  v_profile := private.require_profile();
  select * into v_session from public.cash_sessions where id = p_session_id;
  if not found then
    perform private.raise_error('NOT_FOUND', 'The session does not exist.', jsonb_build_object('session_id', p_session_id));
  end if;
  if v_session.shop_id <> v_profile.shop_id then
    perform private.raise_error('FORBIDDEN', 'This session belongs to another shop.', jsonb_build_object('session_id', p_session_id));
  end if;
  if v_session.closed_at is not null then
    return v_session.server_z_report;
  end if;
  return private.compute_z_report(v_session.id, null);
end;
$$;

revoke all on all functions in schema private from public;
