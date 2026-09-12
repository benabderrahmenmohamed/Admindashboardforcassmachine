-- Two tables of one café cannot share a name.
--
-- dining_tables has held unique (shop_id, name) since migration 20260911000010, but save_dining_table
-- let a clash out as a bare unique_violation, which reaches the app as UNKNOWN: an error the admin's
-- form cannot explain and the error contract (contracts/errors.md) does not allow. This answers it the
-- way save_product answers a barcode already in use — VALIDATION_ERROR naming the field — and changes
-- nothing else about the function migration 20260911000013 wrote.

create or replace function public.save_dining_table(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_id uuid;
  v_name text;
  v_sort integer;
  v_active boolean;
  v_table public.dining_tables;
begin
  v_profile := private.require_profile(array['admin']);
  v_id := private.json_uuid(p, 'id', false);
  v_name := nullif(trim(private.json_text(p, 'name')), '');
  if v_name is null then
    perform private.raise_error('VALIDATION_ERROR', 'A table needs a name.', jsonb_build_object('field', 'name'));
  end if;
  v_sort := private.json_int(p, 'sort_order');
  if v_sort < 0 then
    perform private.raise_error('VALIDATION_ERROR', 'A table cannot sort before the first one.', jsonb_build_object('field', 'sort_order'));
  end if;
  v_active := coalesce((p ->> 'is_active')::boolean, true);

  begin
    if v_id is null then
      insert into public.dining_tables (shop_id, name, sort_order, is_active)
      values (v_profile.shop_id, v_name, v_sort, v_active)
      returning * into v_table;
    else
      update public.dining_tables
      set name = v_name, sort_order = v_sort, is_active = v_active
      where id = v_id and shop_id = v_profile.shop_id
      returning * into v_table;
      if not found then
        perform private.raise_error('NOT_FOUND', 'The table does not exist.', jsonb_build_object('table_id', v_id));
      end if;
    end if;
  exception when unique_violation then
    -- The only unique key a save can break besides the generated id is (shop_id, name).
    perform private.raise_error('VALIDATION_ERROR', 'Another table already has this name.', jsonb_build_object('field', 'name'));
  end;

  return jsonb_build_object(
    'id', v_table.id,
    'name', v_table.name,
    'sort_order', v_table.sort_order,
    'is_active', v_table.is_active
  );
end;
$$;

revoke all on function public.save_dining_table(jsonb) from public, anon;
grant execute on function public.save_dining_table(jsonb) to authenticated;
