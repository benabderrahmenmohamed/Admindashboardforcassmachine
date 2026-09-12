create table public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now()
);

-- Membership and role. Rows are created by seed.sql locally and by a documented SQL step in hosted
-- projects: never from user_metadata or app_metadata, and never by a signup trigger. A signed-in
-- user without a profile is denied everywhere.
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete restrict,
  role text not null check (role in ('admin', 'cashier')),
  display_name text not null default '',
  created_at timestamptz not null default now()
);
create index profiles_shop_id_idx on public.profiles (shop_id);

-- Lookups used by row-level security. security definer so a policy on profiles does not recurse.
create or replace function private.current_shop_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.shop_id from public.profiles p where p.user_id = auth.uid()
$$;

create or replace function private.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.user_id = auth.uid()
$$;

-- The first statement of every RPC: no user is UNAUTHENTICATED, no profile or the wrong role is
-- FORBIDDEN.
create or replace function private.require_profile(p_roles text[] default array['admin', 'cashier'])
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  if auth.uid() is null then
    perform private.raise_error('UNAUTHENTICATED', 'Sign in to continue.');
  end if;
  select * into v_profile from public.profiles where user_id = auth.uid();
  if not found then
    perform private.raise_error('FORBIDDEN', 'This account is not a member of any shop.');
  end if;
  if not (v_profile.role = any (p_roles)) then
    perform private.raise_error('FORBIDDEN', 'Your role cannot do this.', jsonb_build_object('role', v_profile.role));
  end if;
  return v_profile;
end;
$$;

-- Records carry the person who did the work (an offline session may be replayed later under
-- someone else's login) as `actor_user_id`; that person must belong to the same shop. Returns the
-- person's user id.
create or replace function private.require_member(p_shop_id uuid, p jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.json_uuid(p, 'actor_user_id');
begin
  if not exists (select 1 from public.profiles pr where pr.user_id = v_user_id and pr.shop_id = p_shop_id) then
    perform private.raise_error(
      'FORBIDDEN',
      'The person on this record is not a member of your shop.',
      jsonb_build_object('actor_user_id', v_user_id)
    );
  end if;
  return v_user_id;
end;
$$;

-- The signed-in user's own profile, used by the web app after login to learn its role.
create or replace function public.my_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_email text;
begin
  v_profile := private.require_profile();
  select u.email into v_email from auth.users u where u.id = v_profile.user_id;
  return jsonb_build_object(
    'user_id', v_profile.user_id,
    'shop_id', v_profile.shop_id,
    'role', v_profile.role,
    'display_name', v_profile.display_name,
    'email', coalesce(v_email, '')
  );
end;
$$;

revoke all on all functions in schema private from public;
