import re, pathlib, sys

REPO = pathlib.Path("C:/Users/shini/Desktop/pos-admin-dashboard")
SRC = REPO / "supabase" / "migrations"
DIR = REPO / "api" / "migrations" / "sql"
OUT = DIR / "0001_schema.sql"

# The schema this server started from, replayed into 0001_schema.sql. It is history: Doctrine has run
# Version20260925000001 on every database this server has ever had, and will never run it again, so a
# statement added here reaches a fresh database and no other. Never add a migration to this list.
BASELINE = [
    "20260911000002_private_helpers.sql",
    "20260911000003_shops_and_profiles.sql",
    "20260911000004_catalog.sql",
    "20260911000005_terminals_and_sessions.sql",
    "20260911000006_sales_ledger.sql",
    "20260911000008_rls_and_grants.sql",
    "20260911000010_cafe_schema.sql",
    "20260911000011_order_rpcs.sql",
    "20260911000013_counter_sales_and_tables.sql",
    "20260913000014_dining_table_names.sql",
    "20260913000015_removal_submitted_by.sql",
    "20260913000016_save_product_cafe_fields.sql",
]

# Every Supabase migration written after that, each converted into a file of its own. Each one also
# needs a Doctrine migration (api/migrations/VersionYYYYMMDDNNNNNN.php) that runs its file, and a
# line in api/tests/Support/CafeSchema.php, so that an existing database gets it the way Supabase's
# does: as the next migration, once.
LATER = [
    ("20260926000017_malformed_payloads.sql", "0004_malformed_payloads.sql"),
]

PREAMBLE = """-- The café's schema, for the Symfony server.
--
-- Derived from supabase/migrations, replayed in order, with the three things that were Supabase's
-- and are now ours:
--
--   auth.users   -> public.users, written by this server (Symfony hashes the passwords)
--   auth.uid()   -> private.current_user_id(), read from `app.user_id`, which the API sets on the
--                   connection for the member making the request
--   authenticated/anon/service_role -> cafe_app, the one role the API connects as
--
-- What was left behind: the key-value import of the old app, the nightly demo reset, and the
-- Supabase Realtime publication. Row-level security stays exactly as it was: cafe_app reads only its
-- own shop's rows, and the ledger takes writes through its functions alone.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'cafe_app') then
    create role cafe_app login password 'cafe_app';
  end if;
end;
$$;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  constraint users_email_not_blank check (length(trim(email)) > 0)
);
create unique index users_email_key on public.users (lower(email));

alter table public.users enable row level security;
revoke all on public.users from public, cafe_app;

"""

CURRENT_USER = """
-- Who is making this request. The API sets `app.user_id` on the connection right after it has
-- checked the token; nothing else can read a row of another member's shop, whatever the code above
-- forgets. Null when the setting is missing, which is what every policy compares against.
create or replace function private.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

"""

def statements(sql: str):
    """Split on semicolons that end a statement, keeping $$-quoted bodies whole."""
    out, buf, dollar = [], [], None
    i = 0
    while i < len(sql):
        if dollar is None:
            m = re.match(r"\$[A-Za-z_]*\$", sql[i:])
            if m:
                dollar = m.group(0)
                buf.append(dollar)
                i += len(dollar)
                continue
            if sql[i] == ";":
                buf.append(";")
                out.append("".join(buf))
                buf = []
                i += 1
                continue
        else:
            if sql.startswith(dollar, i):
                buf.append(dollar)
                i += len(dollar)
                dollar = None
                continue
        buf.append(sql[i])
        i += 1
    if "".join(buf).strip():
        out.append("".join(buf))
    return out

DROP_IF_MENTIONS = ("legacy_orders", "kv_import", "kv_store_81f0b18a", "supabase_realtime", "schema migration")

def convert(text: str) -> str:
    text = text.replace("auth.users", "public.users")
    text = text.replace("auth.uid()", "private.current_user_id()")
    text = re.sub(r"\bfrom public, anon, authenticated\b", "from public, cafe_app", text)
    text = re.sub(r"\bfrom anon, authenticated\b", "from public, cafe_app", text)
    text = re.sub(r"\bfrom public, anon\b", "from public", text)
    text = re.sub(r"\bfrom anon\b", "from public", text)
    text = re.sub(r"\bto anon, authenticated\b", "to cafe_app", text)
    text = re.sub(r"\bto authenticated\b", "to cafe_app", text)
    text = re.sub(r"\bfrom service_role\b", "from public", text)
    return text

kept = dropped = 0

def replay(name: str) -> str:
    """One Supabase migration, converted, with what belonged to Supabase left out."""
    global kept, dropped
    body = (SRC / name).read_text(encoding="utf-8")
    chunk = [f"\n-- ---------------------------------------------------------------------------------------------\n-- from {name}\n"]
    for stmt in statements(body):
        # The legacy table only ever appears inside a list of tables; take the name out and keep
        # the grant that names the others.
        stmt = re.sub(r",\s*public\.legacy_orders", "", stmt)
        stmt = re.sub(r"public\.legacy_orders,\s*", "", stmt)
        low = stmt.lower()
        if any(word in low for word in DROP_IF_MENTIONS):
            dropped += 1
            first = next((l.strip() for l in stmt.splitlines() if l.strip() and not l.strip().startswith('--')), '')
            print(f"  dropped from {name}: {first[:90]}")
            continue
        chunk.append(convert(stmt))
        kept += 1
    return "".join(chunk)

parts = [PREAMBLE]
for name in BASELINE:
    parts.append(replay(name))
    if name.endswith("private_helpers.sql"):
        parts.append(CURRENT_USER)

FOOTER = """
-- ---------------------------------------------------------------------------------------------
-- Last, because the grants above revoke every function of the private schema from everyone: the
-- role the API connects as may ask which member it is acting for. It reads a setting that role put
-- there itself, so there is nothing to hide, and a support session can see who a connection is.
grant execute on function private.current_user_id() to cafe_app;

-- The shape of a product on the wire is one function, so a read and a save answer the same thing.
grant execute on function private.product_json(public.products) to cafe_app;
"""

parts.append(FOOTER)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text("".join(parts), encoding="utf-8")
print(f"kept {kept} statements, dropped {dropped}, wrote {OUT} ({OUT.stat().st_size} bytes)")

LATER_HEADER = """-- {name}, for the Symfony server.
--
-- Converted by build_from_supabase.py exactly as 0001_schema.sql was: auth.users is public.users,
-- auth.uid() is private.current_user_id(), and the API roles are cafe_app. A migration of its own
-- rather than more lines in 0001_schema.sql, because Doctrine has already run that one everywhere
-- and a database that has will never run it again.
"""

for name, target in LATER:
    kept = dropped = 0
    path = DIR / target
    path.write_text(LATER_HEADER.format(name=name) + replay(name), encoding="utf-8")
    print(f"kept {kept} statements, dropped {dropped}, wrote {path} ({path.stat().st_size} bytes)")
