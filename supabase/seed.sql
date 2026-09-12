-- Local development and CI data, loaded by `supabase db reset`. Never applied to a hosted project.
--
-- One café: a caisse terminal (C1) and a terminal in the room (S1), a user per role plus the owner
-- who is admin and cashier at once, eight tables and a dozen things to sell. Shop B is not a second
-- demo shop; it holds the minimum a second shop needs so row-level security can be tested against
-- one, and every isolation test in supabase/tests/database uses it.

-- Accounts. Passwords are for the local stack only.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'authenticated', 'authenticated',
   'admin@demo.local', extensions.crypt('demo-admin-2026', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Demo Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'authenticated', 'authenticated',
   'cashier@demo.local', extensions.crypt('demo-cashier-2026', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Demo Cashier"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'authenticated', 'authenticated',
   'waiter@demo.local', extensions.crypt('demo-waiter-2026', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Demo Waiter"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'authenticated', 'authenticated',
   'kitchen@demo.local', extensions.crypt('demo-kitchen-2026', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Demo Kitchen"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 'authenticated', 'authenticated',
   'owner@demo.local', extensions.crypt('demo-owner-2026', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Demo Owner"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'authenticated', 'authenticated',
   'other-admin@demo.local', extensions.crypt('other-admin-2026', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Other Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'authenticated', 'authenticated',
   'other-cashier@demo.local', extensions.crypt('other-cashier-2026', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Other Cashier"}', now(), now(), '', '', '', '');

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', now(), now(), now()
from auth.users u
where u.id in (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
);

insert into public.shops (id, name) values
  ('11111111-1111-4111-8111-111111111111', 'Café de la Marsa'),
  ('22222222-2222-4222-8222-222222222222', 'Other Shop');

-- One member per role, and the owner who is both an admin and a cashier: holding several roles is
-- the ordinary case in a café, not an edge one.
insert into public.profiles (user_id, shop_id, roles, display_name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', array['admin'], 'Demo Admin'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '11111111-1111-4111-8111-111111111111', array['cashier'], 'Demo Cashier'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '11111111-1111-4111-8111-111111111111', array['waiter'], 'Demo Waiter'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', '11111111-1111-4111-8111-111111111111', array['kitchen'], 'Demo Kitchen'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', '11111111-1111-4111-8111-111111111111', array['admin', 'cashier'], 'Demo Owner'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', '22222222-2222-4222-8222-222222222222', array['admin'], 'Other Admin'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', '22222222-2222-4222-8222-222222222222', array['cashier'], 'Other Cashier');

insert into public.shop_settings (shop_id, receipt_footer) values
  ('11111111-1111-4111-8111-111111111111', 'Merci pour votre visite !'),
  ('22222222-2222-4222-8222-222222222222', 'Thank you for your purchase!');

-- C1 is the counter, S1 the device that takes payment in the room. Each has its own receipt
-- sequence and its own cash session.
insert into public.terminals (id, shop_id, code) values
  ('33333333-3333-4333-8333-333333333331', '11111111-1111-4111-8111-111111111111', 'C1'),
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'S1'),
  ('33333333-3333-4333-8333-333333333332', '22222222-2222-4222-8222-222222222222', 'C1');

insert into public.dining_tables (id, shop_id, name, sort_order) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddd01', '11111111-1111-4111-8111-111111111111', 'Table 1', 1),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddd02', '11111111-1111-4111-8111-111111111111', 'Table 2', 2),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddd03', '11111111-1111-4111-8111-111111111111', 'Table 3', 3),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddd04', '11111111-1111-4111-8111-111111111111', 'Table 4', 4),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddd05', '11111111-1111-4111-8111-111111111111', 'Terrasse 1', 5),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddd06', '11111111-1111-4111-8111-111111111111', 'Terrasse 2', 6),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddd07', '11111111-1111-4111-8111-111111111111', 'Terrasse 3', 7),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddd08', '11111111-1111-4111-8111-111111111111', 'Comptoir', 8),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddb1', '22222222-2222-4222-8222-222222222222', 'Other table', 1);

insert into public.categories (id, shop_id, name, color) values
  ('44444444-4444-4444-8444-444444444401', '11111111-1111-4111-8111-111111111111', 'Boissons fraîches', '#3b82f6'),
  ('44444444-4444-4444-8444-444444444402', '11111111-1111-4111-8111-111111111111', 'Boissons chaudes', '#10b981'),
  ('44444444-4444-4444-8444-444444444403', '11111111-1111-4111-8111-111111111111', 'Snacks', '#f59e0b'),
  ('44444444-4444-4444-8444-444444444404', '11111111-1111-4111-8111-111111111111', 'Pâtisserie', '#ef4444'),
  ('44444444-4444-4444-8444-444444444411', '22222222-2222-4222-8222-222222222222', 'General', '#6366f1');

-- Bottled drinks are counted because running out of them is real; everything the machine or the
-- kitchen makes to order is not, which is what track_stock is for.
insert into public.products (id, shop_id, category_id, name, price_millimes, barcode, track_stock) values
  ('55555555-5555-4555-8555-555555555501', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444401', 'Eau minérale 50 cl', 850, '6194000100015', true),
  ('55555555-5555-4555-8555-555555555502', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444401', 'Boisson gazeuse 33 cl', 1350, '6194000200012', true),
  ('55555555-5555-4555-8555-555555555503', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444401', 'Eau minérale 1,5 L', 1900, '6194000200029', true),
  ('55555555-5555-4555-8555-555555555504', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444401', 'Jus d''orange en brique', 2450, '6194000300019', true),
  ('55555555-5555-4555-8555-555555555505', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444402', 'Express', 1200, null, false),
  ('55555555-5555-4555-8555-555555555506', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444402', 'Capucin', 1800, null, false),
  ('55555555-5555-4555-8555-555555555507', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444402', 'Direct', 2000, null, false),
  ('55555555-5555-4555-8555-555555555508', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444402', 'Thé à la menthe', 1500, null, false),
  ('55555555-5555-4555-8555-555555555509', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444401', 'Citronnade', 3500, null, false),
  ('55555555-5555-4555-8555-555555555510', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444404', 'Croissant', 1200, null, false),
  ('55555555-5555-4555-8555-555555555511', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444404', 'Mille-feuille', 2600, null, false),
  ('55555555-5555-4555-8555-555555555512', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444403', 'Sandwich thon', 5500, null, false),
  ('66666666-6666-4666-8666-666666666601', '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444411', 'Other product A', 1000, '9990000000011', true),
  ('66666666-6666-4666-8666-666666666602', '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444411', 'Other product B', 2500, '9990000000028', true);

-- Opening stock goes through the movement log like every other stock change, and only the products
-- the shop counts have any.
select private.move_stock(p.shop_id, p.id, s.qty, 'opening', null, 'Seed data', null)
from (values
  ('55555555-5555-4555-8555-555555555501'::uuid, 120),
  ('55555555-5555-4555-8555-555555555502'::uuid, 60),
  ('55555555-5555-4555-8555-555555555503'::uuid, 8),
  ('55555555-5555-4555-8555-555555555504'::uuid, 40),
  ('66666666-6666-4666-8666-666666666601'::uuid, 10),
  ('66666666-6666-4666-8666-666666666602'::uuid, 10)
) as s (id, qty)
join public.products p on p.id = s.id;
