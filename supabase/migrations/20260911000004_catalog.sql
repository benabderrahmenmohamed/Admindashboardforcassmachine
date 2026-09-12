create table public.categories (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null default private.current_shop_id() references public.shops (id) on delete restrict,
  name text not null check (length(trim(name)) > 0),
  color text not null default '#3b82f6' check (color ~ '^#[0-9a-fA-F]{6}$'),
  legacy_kv_key text unique,
  created_at timestamptz not null default now(),
  unique (id, shop_id)
);
create index categories_shop_id_idx on public.categories (shop_id);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete restrict,
  category_id uuid,
  name text not null check (length(trim(name)) > 0),
  -- Up to one billion dinars: the same bound as MAX_PRICE_MILLIMES in src/ports/catalog.ts, so a
  -- price that is stored here always reads back through the port.
  price_millimes bigint not null check (price_millimes >= 0 and price_millimes <= 1000000000000),
  barcode text check (barcode is null or length(trim(barcode)) > 0),
  description text not null default '',
  image_url text not null default '',
  -- Changed only by private.move_stock, together with an append-only stock_movements row.
  stock integer not null default 0,
  available boolean not null default true,
  -- Products that appear on receipts are never deleted, only archived.
  archived_at timestamptz,
  legacy_kv_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, shop_id),
  foreign key (category_id, shop_id) references public.categories (id, shop_id) on delete set null (category_id)
);
create index products_shop_id_idx on public.products (shop_id);
create unique index products_shop_barcode_key on public.products (shop_id, barcode)
  where barcode is not null and archived_at is null;

-- Every stock change, append-only. products.stock always equals the sum of a product's deltas.
create table public.stock_movements (
  id bigint generated always as identity primary key,
  shop_id uuid not null,
  product_id uuid not null,
  delta integer not null check (delta <> 0),
  reason text not null check (reason in ('opening', 'adjustment', 'sale', 'refund')),
  sale_id uuid,
  note text not null default '',
  created_by uuid references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (product_id, shop_id) references public.products (id, shop_id) on delete restrict
);
create index stock_movements_product_id_idx on public.stock_movements (product_id);
create index stock_movements_sale_id_idx on public.stock_movements (sale_id) where sale_id is not null;

create table public.shop_settings (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  receipt_footer text not null default 'Thank you for your purchase!' check (length(receipt_footer) <= 500),
  updated_at timestamptz not null default now()
);

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger shop_settings_touch before update on public.shop_settings
  for each row execute function private.touch_updated_at();

-- The only writer of products.stock.
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
    update public.products set stock = stock + p_delta
    where id = p_product_id and shop_id = p_shop_id
    returning stock into v_stock;
  else
    select stock into v_stock from public.products where id = p_product_id and shop_id = p_shop_id;
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
    'stock', v.stock,
    'available', v.available,
    'created_at', v.created_at,
    'updated_at', v.updated_at
  )
$$;

-- Creates (no id) or updates (id) a product. Stock changes only by `stock_delta`, written as an
-- 'opening' movement for a new product or an 'adjustment' for an existing one, in this transaction.
create or replace function public.save_product(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id uuid;
  v_name text;
  v_price bigint;
  v_category uuid;
  v_barcode text;
  v_description text;
  v_image_url text;
  v_delta integer;
  v_product public.products;
begin
  v_profile := private.require_profile(array['admin']);

  v_id := private.json_uuid(p, 'id', false);
  v_name := trim(private.json_text(p, 'name'));
  v_price := private.json_bigint(p, 'price_millimes');
  v_category := private.json_uuid(p, 'category_id', false);
  v_barcode := nullif(trim(coalesce(private.json_text(p, 'barcode', false), '')), '');
  v_description := coalesce(private.json_text(p, 'description', false), '');
  v_image_url := coalesce(private.json_text(p, 'image_url', false), '');
  v_delta := private.json_int(p, 'stock_delta');

  if v_name = '' then
    perform private.raise_error('VALIDATION_ERROR', 'Product name is required.', jsonb_build_object('field', 'name'));
  end if;
  if v_price < 0 then
    perform private.raise_error('VALIDATION_ERROR', 'Price cannot be negative.', jsonb_build_object('field', 'price_millimes'));
  end if;
  -- One billion dinars, the bound src/ports/catalog.ts reads rows back with.
  if v_price > 1000000000000 then
    perform private.raise_error('VALIDATION_ERROR', 'Price cannot be above one billion dinars.', jsonb_build_object('field', 'price_millimes'));
  end if;
  if v_category is not null and not exists (
    select 1 from public.categories c where c.id = v_category and c.shop_id = v_profile.shop_id
  ) then
    perform private.raise_error('VALIDATION_ERROR', 'The category does not exist.', jsonb_build_object('field', 'category_id'));
  end if;

  begin
    if v_id is null then
      if v_delta < 0 then
        perform private.raise_error('VALIDATION_ERROR', 'A new product cannot start with negative stock.', jsonb_build_object('field', 'stock_delta'));
      end if;
      insert into public.products (shop_id, category_id, name, price_millimes, barcode, description, image_url)
      values (v_profile.shop_id, v_category, v_name, v_price, v_barcode, v_description, v_image_url)
      returning * into v_product;
      perform private.move_stock(v_profile.shop_id, v_product.id, v_delta, 'opening', null, '', v_profile.user_id);
    else
      update public.products
      set category_id = v_category,
          name = v_name,
          price_millimes = v_price,
          barcode = v_barcode,
          description = v_description,
          image_url = v_image_url,
          updated_at = now()
      where id = v_id and shop_id = v_profile.shop_id and archived_at is null
      returning * into v_product;
      if not found then
        perform private.raise_error('NOT_FOUND', 'The product does not exist.', jsonb_build_object('product_id', v_id));
      end if;
      perform private.move_stock(v_profile.shop_id, v_product.id, v_delta, 'adjustment', null, '', v_profile.user_id);
    end if;
  exception when unique_violation then
    perform private.raise_error('VALIDATION_ERROR', 'Another product already uses this barcode.', jsonb_build_object('field', 'barcode'));
  end;

  select * into v_product from public.products where id = v_product.id;
  return private.product_json(v_product);
end;
$$;

-- Deleting a product archives it: sale lines keep pointing at it.
create or replace function public.archive_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  v_profile := private.require_profile(array['admin']);
  update public.products set archived_at = now(), updated_at = now()
  where id = p_product_id and shop_id = v_profile.shop_id and archived_at is null;
  if not found then
    perform private.raise_error('NOT_FOUND', 'The product does not exist.', jsonb_build_object('product_id', p_product_id));
  end if;
end;
$$;

revoke all on all functions in schema private from public;
