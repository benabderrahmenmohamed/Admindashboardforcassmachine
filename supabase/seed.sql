-- Local development and CI data, loaded by `supabase db reset`. Never applied to a hosted project.
-- Shop B exists only so row-level security can be tested against a second shop.

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
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
);

insert into public.shops (id, name) values
  ('11111111-1111-4111-8111-111111111111', 'Épicerie du Coin'),
  ('22222222-2222-4222-8222-222222222222', 'Other Shop');

insert into public.profiles (user_id, shop_id, role, display_name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', 'admin', 'Demo Admin'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '11111111-1111-4111-8111-111111111111', 'cashier', 'Demo Cashier'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', '22222222-2222-4222-8222-222222222222', 'admin', 'Other Admin'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', '22222222-2222-4222-8222-222222222222', 'cashier', 'Other Cashier');

insert into public.shop_settings (shop_id, receipt_footer) values
  ('11111111-1111-4111-8111-111111111111', 'Merci pour votre visite !'),
  ('22222222-2222-4222-8222-222222222222', 'Thank you for your purchase!');

insert into public.terminals (id, shop_id, code) values
  ('33333333-3333-4333-8333-333333333331', '11111111-1111-4111-8111-111111111111', 'T1'),
  ('33333333-3333-4333-8333-333333333332', '22222222-2222-4222-8222-222222222222', 'T1');

insert into public.categories (id, shop_id, name, color) values
  ('44444444-4444-4444-8444-444444444401', '11111111-1111-4111-8111-111111111111', 'Boissons', '#3b82f6'),
  ('44444444-4444-4444-8444-444444444402', '11111111-1111-4111-8111-111111111111', 'Produits laitiers', '#10b981'),
  ('44444444-4444-4444-8444-444444444403', '11111111-1111-4111-8111-111111111111', 'Épicerie', '#f59e0b'),
  ('44444444-4444-4444-8444-444444444404', '11111111-1111-4111-8111-111111111111', 'Boulangerie', '#ef4444'),
  ('44444444-4444-4444-8444-444444444411', '22222222-2222-4222-8222-222222222222', 'General', '#6366f1');

insert into public.products (id, shop_id, category_id, name, price_millimes, barcode) values
  ('55555555-5555-4555-8555-555555555501', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444401', 'Eau minérale 1,5 L', 850, '6194000100015'),
  ('55555555-5555-4555-8555-555555555502', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444402', 'Lait demi-écrémé 1 L', 1350, '6194000200012'),
  ('55555555-5555-4555-8555-555555555503', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444402', 'Yaourt nature x4', 1900, '6194000200029'),
  ('55555555-5555-4555-8555-555555555504', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444403', 'Harissa 380 g', 2450, '6194000300019'),
  ('55555555-5555-4555-8555-555555555505', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444403', 'Couscous moyen 1 kg', 2100, '6194000300026'),
  ('55555555-5555-4555-8555-555555555506', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444403', 'Huile d''olive 1 L', 18500, '6194000300033'),
  ('55555555-5555-4555-8555-555555555507', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444403', 'Dattes Deglet Nour 500 g', 7800, '6194000300040'),
  ('55555555-5555-4555-8555-555555555508', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444403', 'Thé vert 250 g', 4200, '6194000300057'),
  ('55555555-5555-4555-8555-555555555509', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444404', 'Baguette', 200, null),
  ('55555555-5555-4555-8555-555555555510', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444404', 'Tabouna', 450, null),
  ('55555555-5555-4555-8555-555555555511', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444401', 'Jus d''orange 1 L', 3950, '6194000100022'),
  ('55555555-5555-4555-8555-555555555512', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444403', 'Café moulu 250 g', 6700, '6194000300064'),
  ('66666666-6666-4666-8666-666666666601', '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444411', 'Other product A', 1000, '9990000000011'),
  ('66666666-6666-4666-8666-666666666602', '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444411', 'Other product B', 2500, '9990000000028');

-- Opening stock goes through the movement log like every other stock change.
select private.move_stock(p.shop_id, p.id, s.qty, 'opening', null, 'Seed data', null)
from (values
  ('55555555-5555-4555-8555-555555555501'::uuid, 120),
  ('55555555-5555-4555-8555-555555555502'::uuid, 60),
  ('55555555-5555-4555-8555-555555555503'::uuid, 8),
  ('55555555-5555-4555-8555-555555555504'::uuid, 40),
  ('55555555-5555-4555-8555-555555555505'::uuid, 55),
  ('55555555-5555-4555-8555-555555555506'::uuid, 25),
  ('55555555-5555-4555-8555-555555555507'::uuid, 0),
  ('55555555-5555-4555-8555-555555555508'::uuid, 30),
  ('55555555-5555-4555-8555-555555555509'::uuid, 150),
  ('55555555-5555-4555-8555-555555555510'::uuid, 80),
  ('55555555-5555-4555-8555-555555555511'::uuid, 35),
  ('55555555-5555-4555-8555-555555555512'::uuid, 20),
  ('66666666-6666-4666-8666-666666666601'::uuid, 10),
  ('66666666-6666-4666-8666-666666666602'::uuid, 10)
) as s (id, qty)
join public.products p on p.id = s.id;
