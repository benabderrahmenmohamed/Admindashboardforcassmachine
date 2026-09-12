-- Orders from the legacy key-value store, archived as they were. They have no session, terminal or
-- receipt number, so they never enter the sales ledger.
create table public.legacy_orders (
  kv_key text primary key,
  shop_id uuid not null references public.shops (id) on delete restrict,
  status text,
  raw jsonb not null,
  imported_at timestamptz not null default now()
);

-- Import tooling lives in a schema the Data API does not expose. It is run by a person in the SQL
-- editor (see docs/runbooks/kv-import.md), never by a migration.
create schema if not exists migration;
revoke all on schema migration from public;

-- Stable, not immutable: text becomes a timestamptz according to the session's TimeZone setting.
create or replace function migration.try_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  return p_value::timestamptz;
exception when others then
  return null;
end;
$$;

-- Imports the legacy key-value store into p_shop_id and returns one row per key:
-- outcome imported | archived | rejected | skipped, with a reason (warnings for imported rows).
-- With p_dry_run every write is rolled back and only the report is returned. Re-running is safe:
-- keys already imported are skipped.
--
-- Rules (ADR 0002 and docs/runbooks/kv-import.md):
--   price     dinars as a JSON number or decimal text, >= 0, at most 3 decimals, at most one
--             billion dinars (the bound public.products.price_millimes carries), else rejected
--             (price_not_a_decimal, price_negative, price_more_than_3_decimals,
--             price_above_maximum); never rounded, never clamped and never classified by magnitude
--   stock     a whole number (or whole-number text); missing or empty imports as 0 with a warning;
--             anything else is rejected. Imported stock is written as one 'opening' movement.
--   category  exactly one category with that name, else no category and a warning; a product that
--             names no category gets category_missing ('uncategorized', the old app's default, is
--             no category without a warning)
--   barcode   empty becomes none; a barcode already used keeps its first product, with a warning
--   orders    archived raw into legacy_orders, still-active orders flagged
create or replace function migration.kv_import(p_shop_id uuid, p_dry_run boolean)
returns table (kv_key text, outcome text, reason text, raw jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_results jsonb := '[]'::jsonb;
  r record;
  v_name text;
  v_color text;
  v_warnings text[];
  v_price numeric;
  v_price_text text;
  v_stock_json jsonb;
  v_stock integer;
  v_category_name text;
  v_category_id uuid;
  v_matches integer;
  v_barcode text;
  v_product_id uuid;
  v_footer text;
begin
  if not exists (select 1 from public.shops s where s.id = p_shop_id) then
    raise exception 'kv_import: shop % does not exist', p_shop_id;
  end if;

  begin
    for r in select kv.key as k, kv.value as v from public.kv_store_81f0b18a kv where kv.key like 'category:%' order by kv.key
    loop
      if exists (select 1 from public.categories c where c.legacy_kv_key = r.k) then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'skipped', 'reason', 'already_imported', 'raw', r.v);
        continue;
      end if;
      v_name := case when jsonb_typeof(r.v) = 'object' then trim(coalesce(r.v ->> 'name', '')) else '' end;
      if v_name = '' then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'rejected', 'reason', 'category_without_name', 'raw', r.v);
        continue;
      end if;
      v_warnings := '{}';
      v_color := r.v ->> 'color';
      if v_color is null or v_color !~ '^#[0-9a-fA-F]{6}$' then
        v_color := '#3b82f6';
        v_warnings := array_append(v_warnings, 'color_defaulted');
      end if;
      insert into public.categories (shop_id, name, color, legacy_kv_key, created_at)
      values (p_shop_id, v_name, v_color, r.k, coalesce(migration.try_timestamptz(r.v ->> 'createdAt'), now()));
      v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'imported', 'reason', array_to_string(v_warnings, ','), 'raw', r.v);
    end loop;

    for r in select kv.key as k, kv.value as v from public.kv_store_81f0b18a kv where kv.key like 'product:%' order by kv.key
    loop
      if exists (select 1 from public.products pr where pr.legacy_kv_key = r.k) then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'skipped', 'reason', 'already_imported', 'raw', r.v);
        continue;
      end if;
      if jsonb_typeof(r.v) <> 'object' then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'rejected', 'reason', 'not_an_object', 'raw', r.v);
        continue;
      end if;
      v_warnings := '{}';

      v_name := trim(coalesce(r.v ->> 'name', ''));
      if v_name = '' then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'rejected', 'reason', 'product_without_name', 'raw', r.v);
        continue;
      end if;

      -- Text prices go through the same sign and decimal checks as JSON numbers.
      v_price := null;
      if jsonb_typeof(r.v -> 'price') = 'number' then
        v_price := (r.v ->> 'price')::numeric;
      elsif jsonb_typeof(r.v -> 'price') = 'string' then
        v_price_text := trim(r.v ->> 'price');
        if v_price_text ~ '^-?[0-9]+(\.[0-9]+)?$' then
          v_price := v_price_text::numeric;
        end if;
      end if;
      if v_price is null then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'rejected', 'reason', 'price_not_a_decimal', 'raw', r.v);
        continue;
      end if;
      if v_price < 0 then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'rejected', 'reason', 'price_negative', 'raw', r.v);
        continue;
      end if;
      if v_price * 1000 <> trunc(v_price * 1000) then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'rejected', 'reason', 'price_more_than_3_decimals', 'raw', r.v);
        continue;
      end if;
      -- One billion dinars: the bound public.products.price_millimes and src/ports/catalog.ts share.
      -- A row above it is rejected like any other price the new schema cannot hold, never clamped.
      if v_price * 1000 > 1000000000000 then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'rejected', 'reason', 'price_above_maximum', 'raw', r.v);
        continue;
      end if;

      v_stock_json := r.v -> 'stock';
      v_stock := null;
      if v_stock_json is null or jsonb_typeof(v_stock_json) = 'null'
         or (jsonb_typeof(v_stock_json) = 'string' and trim(v_stock_json #>> '{}') = '') then
        v_stock := 0;
        v_warnings := array_append(v_warnings, 'stock_missing_imported_as_0');
      elsif jsonb_typeof(v_stock_json) = 'number'
            and (v_stock_json #>> '{}')::numeric = trunc((v_stock_json #>> '{}')::numeric)
            and abs((v_stock_json #>> '{}')::numeric) <= 2147483647 then
        v_stock := (v_stock_json #>> '{}')::numeric::integer;
      elsif jsonb_typeof(v_stock_json) = 'string' and trim(v_stock_json #>> '{}') ~ '^-?[0-9]{1,9}$' then
        v_stock := trim(v_stock_json #>> '{}')::integer;
      end if;
      if v_stock is null then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'rejected', 'reason', 'stock_not_a_whole_number', 'raw', r.v);
        continue;
      end if;

      v_category_name := trim(coalesce(r.v ->> 'category', ''));
      v_category_id := null;
      if v_category_name = '' then
        v_warnings := array_append(v_warnings, 'category_missing');
      elsif lower(v_category_name) <> 'uncategorized' then
        select count(*), (array_agg(c.id))[1]
        into v_matches, v_category_id
        from public.categories c
        where c.shop_id = p_shop_id and c.name = v_category_name;
        if v_matches <> 1 then
          v_category_id := null;
          v_warnings := array_append(v_warnings, case when v_matches = 0 then 'category_not_found' else 'category_name_ambiguous' end);
        end if;
      end if;

      v_barcode := nullif(trim(coalesce(r.v ->> 'barcode', '')), '');
      if v_barcode is not null and exists (
        select 1 from public.products pr where pr.shop_id = p_shop_id and pr.barcode = v_barcode and pr.archived_at is null
      ) then
        v_barcode := null;
        v_warnings := array_append(v_warnings, 'barcode_duplicate_dropped');
      end if;

      insert into public.products (
        shop_id, category_id, name, price_millimes, barcode, description, image_url, available,
        legacy_kv_key, created_at, updated_at
      )
      values (
        p_shop_id, v_category_id, v_name, (v_price * 1000)::bigint, v_barcode,
        coalesce(r.v ->> 'description', ''), coalesce(r.v ->> 'image', ''),
        case when jsonb_typeof(r.v -> 'available') = 'boolean' then (r.v ->> 'available')::boolean else true end,
        r.k,
        coalesce(migration.try_timestamptz(r.v ->> 'createdAt'), now()),
        coalesce(migration.try_timestamptz(r.v ->> 'updatedAt'), now())
      )
      returning id into v_product_id;

      perform private.move_stock(p_shop_id, v_product_id, v_stock, 'opening', null, 'Imported from the legacy key-value store', null);

      v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'imported', 'reason', array_to_string(v_warnings, ','), 'raw', r.v);
    end loop;

    insert into public.shop_settings (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
    for r in select kv.key as k, kv.value as v from public.kv_store_81f0b18a kv where kv.key = 'pos:settings'
    loop
      v_footer := case when jsonb_typeof(r.v -> 'receiptFooter') = 'string' then r.v ->> 'receiptFooter' end;
      if v_footer is null or length(v_footer) > 500 then
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'imported', 'reason', 'receipt_footer_defaulted', 'raw', r.v);
      else
        update public.shop_settings set receipt_footer = v_footer where shop_id = p_shop_id;
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'imported', 'reason', '', 'raw', r.v);
      end if;
    end loop;

    for r in select kv.key as k, kv.value as v from public.kv_store_81f0b18a kv where kv.key like 'order:%' order by kv.key
    loop
      insert into public.legacy_orders (kv_key, shop_id, status, raw)
      values (r.k, p_shop_id, r.v ->> 'status', r.v)
      on conflict (kv_key) do nothing;
      if found then
        v_results := v_results || jsonb_build_object(
          'kv_key', r.k, 'outcome', 'archived',
          'reason', case when r.v ->> 'status' = 'active' then 'order_still_active' else '' end,
          'raw', r.v
        );
      else
        v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'skipped', 'reason', 'already_imported', 'raw', r.v);
      end if;
    end loop;

    for r in
      select kv.key as k, kv.value as v from public.kv_store_81f0b18a kv
      where kv.key not like 'category:%' and kv.key not like 'product:%' and kv.key not like 'order:%' and kv.key <> 'pos:settings'
      order by kv.key
    loop
      v_results := v_results || jsonb_build_object('kv_key', r.k, 'outcome', 'skipped', 'reason', 'unknown_key', 'raw', r.v);
    end loop;

    if p_dry_run then
      raise exception using errcode = 'KVDRY', message = 'kv_import dry run: rolling back every write';
    end if;
  exception when sqlstate 'KVDRY' then
    -- Dry run: the writes above are undone; the report in v_results survives.
    null;
  end;

  return query
  select e ->> 'kv_key', e ->> 'outcome', e ->> 'reason', e -> 'raw'
  from jsonb_array_elements(v_results) e;
end;
$$;

revoke all on all functions in schema migration from public;
