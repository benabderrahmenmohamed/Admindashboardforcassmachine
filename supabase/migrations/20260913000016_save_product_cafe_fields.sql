-- save_product writes what the product form sends: whether the dish is on the menu, and whether its
-- stock is counted.
--
-- Migration 20260911000010 gave products `is_available` and `track_stock` and changed product_json to
-- answer them, but save_product kept the shape migration 20260911000004 wrote: it read neither key.
-- A product created from the form was never counted, however the admin set it, so a sale never
-- moved its stock; and an edit could not switch counting on or off. The contract suite on a local
-- stack found it: the memory backend saves both, as src/ports/catalog.ts says.
--
-- A payload that leaves a key out is from a client older than the café model. A new product is then
-- on the menu and not counted, as the columns' defaults have it, and a saved product keeps what it
-- had. Nothing else about the function changes.

-- A boolean field of a payload: null when the payload does not carry it, VALIDATION_ERROR naming the
-- field when it carries anything but true or false.
create or replace function private.json_bool(p jsonb, p_key text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if not (p ? p_key) or jsonb_typeof(p -> p_key) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p -> p_key) <> 'boolean' then
    perform private.raise_error('VALIDATION_ERROR', format('%s must be true or false.', p_key), jsonb_build_object('field', p_key));
  end if;
  return (p -> p_key)::boolean;
end;
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
  v_available boolean;
  v_track boolean;
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
  v_available := private.json_bool(p, 'is_available');
  v_track := private.json_bool(p, 'track_stock');

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
      insert into public.products (
        shop_id, category_id, name, price_millimes, barcode, description, image_url, is_available, track_stock
      )
      values (
        v_profile.shop_id, v_category, v_name, v_price, v_barcode, v_description, v_image_url,
        coalesce(v_available, true), coalesce(v_track, false)
      )
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
          is_available = coalesce(v_available, is_available),
          track_stock = coalesce(v_track, track_stock),
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

revoke all on function private.json_bool(jsonb, text) from public, anon;

revoke all on function public.save_product(jsonb) from public, anon;
grant execute on function public.save_product(jsonb) to authenticated;
