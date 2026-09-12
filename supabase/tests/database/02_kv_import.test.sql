-- The legacy key-value import, against the data shapes the Figma Make code actually wrote.
begin;

create extension if not exists pgtap with schema extensions;

select plan(32);

insert into public.shops (id, name) values ('12121212-1212-4212-8212-121212121212', 'Import target');

insert into public.kv_store_81f0b18a (key, value) values
  ('category:c1', '{"id":"c1","name":"Drinks","color":"#10b981","createdAt":"2026-02-10T12:00:00.000Z"}'),
  ('category:c2', '{"id":"c2","name":"Snacks","color":"not-a-colour"}'),
  ('category:c3', '{"id":"c3","name":"Snacks"}'),
  ('category:c4', '{"id":"c4","name":"   "}'),
  -- created through POST: float price, integer stock
  ('product:p1', '{"id":"p1","name":"Water","price":0.85,"category":"Drinks","barcode":"111","stock":120,"available":true}'),
  -- edited through PUT: price and stock saved as text
  ('product:p2', '{"id":"p2","name":"Juice","price":"3.95","category":"Drinks","barcode":"","stock":"35"}'),
  -- a float artefact is never rounded
  ('product:p3', '{"id":"p3","name":"Chips","price":0.30000000000000004,"category":"Snacks","stock":5}'),
  ('product:p4', '{"id":"p4","name":"Cookies","price":-1,"stock":5}'),
  ('product:p5', '{"id":"p5","name":"Bread","price":"1,2","stock":5}'),
  -- stock cleared in the form
  ('product:p6', '{"id":"p6","name":"Tea","price":4.2,"category":"Snacks","barcode":"111","stock":""}'),
  ('product:p7', '{"id":"p7","name":"Cake","price":12,"category":"Deleted category","stock":2.5}'),
  ('product:p8', '{"id":"p8","name":"","price":1,"stock":1}'),
  -- no category key at all
  ('product:p9', '{"id":"p9","name":"Mint","price":"0.500","stock":3}'),
  -- text prices get the same decimal and sign checks as numbers
  ('product:p10', '{"id":"p10","name":"Saffron","price":"12.3456","category":"Snacks","stock":1}'),
  -- the old app's default category
  ('product:p11', '{"id":"p11","name":"Sugar","price":1.1,"category":"uncategorized","stock":0}'),
  ('product:p12', '{"id":"p12","name":"Salt","price":"-2.5","stock":1}'),
  -- exactly one billion dinars: the highest price the schema holds
  ('product:p13', '{"id":"p13","name":"Safe","price":1000000000,"category":"Drinks","stock":0}'),
  -- one millime above it, in the middle of the run
  ('product:p14', '{"id":"p14","name":"Vault","price":"1000000000.001","stock":1}'),
  ('pos:settings', '{"mode":"table","currency":"$","receiptFooter":"Shukran!"}'),
  ('order:o1', '{"id":"o1","status":"completed","total":1.7,"items":[]}'),
  ('order:o2', '{"id":"o2","status":"active","total":0.85,"items":[]}'),
  ('mystery', '{"x":1}');

create temporary table dry as
select * from migration.kv_import('12121212-1212-4212-8212-121212121212', true);

select is((select count(*)::integer from dry), 22, 'the dry run reports every key');
select is(
  (select count(*)::integer from public.products where shop_id = '12121212-1212-4212-8212-121212121212'),
  0,
  'the dry run writes nothing'
);

create temporary table applied as
select * from migration.kv_import('12121212-1212-4212-8212-121212121212', false);

select is(
  (select jsonb_object_agg(kv_key, outcome || ':' || reason) from applied),
  (select jsonb_object_agg(kv_key, outcome || ':' || reason) from dry),
  'the dry run and the real import classify every key the same way'
);

select is((select outcome || ':' || reason from applied where kv_key = 'category:c2'), 'imported:color_defaulted', 'a bad colour is defaulted with a warning');
select is((select outcome || ':' || reason from applied where kv_key = 'category:c4'), 'rejected:category_without_name', 'a blank category name is rejected');

select is((select price_millimes from public.products where legacy_kv_key = 'product:p1'), 850::bigint, 'a float price in dinars becomes exact millimes');
select is((select price_millimes from public.products where legacy_kv_key = 'product:p2'), 3950::bigint, 'a text price becomes exact millimes');
select is((select stock from public.products where legacy_kv_key = 'product:p2'), 35, 'a text stock is imported');
select is((select barcode from public.products where legacy_kv_key = 'product:p2'), null, 'an empty barcode becomes none');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p3'), 'rejected:price_more_than_3_decimals', 'a float artefact is rejected, not rounded');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p4'), 'rejected:price_negative', 'a negative price is rejected');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p5'), 'rejected:price_not_a_decimal', 'a comma price in storage is rejected');
select is(
  (select outcome || ':' || reason from applied where kv_key = 'product:p6'),
  'imported:stock_missing_imported_as_0,category_name_ambiguous,barcode_duplicate_dropped',
  'empty stock, an ambiguous category and a duplicate barcode are imported with warnings'
);
select is((select outcome || ':' || reason from applied where kv_key = 'product:p7'), 'rejected:stock_not_a_whole_number', 'a fractional stock is rejected');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p8'), 'rejected:product_without_name', 'a product without a name is rejected');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p9'), 'imported:category_missing', 'a product that names no category is imported with a warning');
select is((select price_millimes from public.products where legacy_kv_key = 'product:p9'), 500::bigint, 'a text price with three decimals becomes exact millimes');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p10'), 'rejected:price_more_than_3_decimals', 'a text price with more than 3 decimals is rejected, not rounded');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p11'), 'imported:', 'uncategorized, the old default, imports without a category and without a warning');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p12'), 'rejected:price_negative', 'a negative text price is rejected as negative');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p13'), 'imported:', 'a price of exactly one billion dinars is imported');
select is((select price_millimes from public.products where legacy_kv_key = 'product:p13'), 1000000000000::bigint, 'the highest price the schema holds survives the import');
select is((select outcome || ':' || reason from applied where kv_key = 'product:p14'), 'rejected:price_above_maximum', 'a price one millime above the maximum is rejected, not clamped');
select is(
  (select count(*)::integer from applied where outcome = 'imported'),
  10,
  'a price above the maximum rejects its own row only; the rest of the run still imports'
);

select is(
  (select c.name from public.products p join public.categories c on c.id = p.category_id where p.legacy_kv_key = 'product:p1'),
  'Drinks',
  'a unique category name is linked'
);
select is(
  (select count(*)::integer from public.stock_movements m join public.products p on p.id = m.product_id
   where p.shop_id = '12121212-1212-4212-8212-121212121212' and m.reason = 'opening'),
  3,
  'imported stock is written as opening movements (zero stock writes none)'
);
select is(
  (select receipt_footer from public.shop_settings where shop_id = '12121212-1212-4212-8212-121212121212'),
  'Shukran!',
  'the receipt footer is imported'
);
select is((select outcome || ':' || reason from applied where kv_key = 'order:o2'), 'archived:order_still_active', 'an active order is archived and flagged');
select is((select count(*)::integer from public.legacy_orders where shop_id = '12121212-1212-4212-8212-121212121212'), 2, 'orders are archived raw');
select is((select outcome || ':' || reason from applied where kv_key = 'mystery'), 'skipped:unknown_key', 'an unknown key is reported and skipped');

select is(
  (select count(*)::integer from migration.kv_import('12121212-1212-4212-8212-121212121212', false) where outcome in ('imported', 'archived')),
  1,
  'running the import again only re-applies the settings'
);

select is(
  (select pr.provolatile::text from pg_catalog.pg_proc pr where pr.oid = 'migration.try_timestamptz(text)'::regprocedure),
  's',
  'try_timestamptz is stable: the cast reads the TimeZone setting'
);

select * from finish();
rollback;
