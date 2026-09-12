-- Run once in the SQL editor of the hosted demo project, never on a real shop's project.
-- Requires the pg_cron extension (Database → Extensions → pg_cron).
-- Replace <demo-shop-id> with the id of the shop whose credentials are published as the demo.

insert into private.demo_shops (shop_id)
values ('<demo-shop-id>')
on conflict (shop_id) do nothing;

-- Every night at 03:00 UTC.
select cron.schedule(
  'reset-demo-shop',
  '0 3 * * *',
  $$ select private.reset_demo_shop('<demo-shop-id>') $$
);

-- To stop it: select cron.unschedule('reset-demo-shop');
