# Runbook: moving a hosted project off the legacy edge function

The first version of this app kept everything in one key-value table (`kv_store_81f0b18a`) behind an edge function running with the service role key. This runbook moves a hosted Supabase project to the relational schema in `supabase/migrations/` and then deletes the function, which until then bypasses every row-level security rule.

Run each step yourself. Nothing here is automated against a hosted project.

## Before you start

- Supabase CLI logged in, and the project linked (`supabase link --project-ref <ref>`).
- Nobody sells during steps 5 to 7. Pick a quiet moment.
- Prices in the key-value store are **dinars**, as a number (`1.35`) or, after an edit in the old app, as text (`"1.350"`). The import converts both to millimes without rounding; a value with more than three decimals is rejected, never guessed.

## 1. Settle open orders in the old app

The old POS had a table mode that kept orders open until they were paid. They are archived as they are, and nothing settles them later.

1. Open the old app and switch Settings to table mode, so open orders are visible.
2. Pay the tables that were really paid.
3. Cancel the rest. The old UI has no cancel button; call `DELETE /functions/v1/make-server-81f0b18a/orders/<id>` with an admin's access token.
4. Check that `GET /functions/v1/make-server-81f0b18a/orders` returns an empty list.

## 2. Apply the schema

```bash
supabase db push
```

This creates the tables, the RPCs and `migration.kv_import`. It does not import anything, and the old app keeps working, because the edge function does not use the new tables.

## 3. Create the shop and its members

In the SQL editor, create the shop and give each real person a profile. Choose members by confirming who owns each account, never from `raw_user_meta_data` or `app_metadata`: earlier versions let anyone set a role there.

```sql
insert into public.shops (name) values ('<shop name>') returning id;

-- Once per person; check that one row comes back each time. A member holds one or more of admin,
-- cashier, waiter and kitchen: the owner who also works the counter is array['admin', 'cashier'].
insert into public.profiles (user_id, shop_id, roles, display_name)
select u.id, '<shop-id>', array['admin'], '<name>' from auth.users u where u.id = '<user-id>'
returning user_id;
```

Delete the `admin@pos.com` and `worker@pos.com` test accounts the old login page advertised, or at least never give them a profile.

## 4. Dry run and review the rejects

Run `supabase/scripts/kv_import_dry_run.sql` in the SQL editor (after putting in the shop id) and export the result as CSV. Every write is rolled back.

| Outcome    | Reason                                                                | What to do                                                                                                                                 |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `rejected` | `price_not_a_decimal`, `price_negative`, `price_more_than_3_decimals` | Fix the price in the old app, or re-create the product after the import.                                                                   |
| `rejected` | `price_above_maximum`                                                 | Above one billion dinars, the highest price the new schema holds. Fix the price in the old app, or re-create the product after the import. |
| `rejected` | `stock_not_a_whole_number`                                            | Fix the stock in the old app.                                                                                                              |
| `rejected` | `product_without_name`, `category_without_name`, `not_an_object`      | Nothing to import; recreate it by hand if it matters.                                                                                      |
| `imported` | `stock_missing_imported_as_0`                                         | Set the stock after the import.                                                                                                            |
| `imported` | `category_missing`, `category_not_found`, `category_name_ambiguous`   | Assign the category after the import. A product the old app saved as `uncategorized` imports without a category and without a warning.     |
| `imported` | `barcode_duplicate_dropped`                                           | Another product already has that barcode; decide which one keeps it.                                                                       |
| `imported` | `color_defaulted`, `receipt_footer_defaulted`                         | Cosmetic.                                                                                                                                  |
| `archived` | `order_still_active`                                                  | Go back to step 1.                                                                                                                         |
| `skipped`  | `already_imported`, `unknown_key`                                     | Nothing.                                                                                                                                   |

Repeat the dry run after any fix until the rejects are what you expect.

## 5. Import

Run `supabase/scripts/kv_import_apply.sql` (with the shop id). In one transaction it makes the key-value table read-only, so a late write from the old app fails loudly instead of being lost, and then imports. Keep the result.

## 6. Deploy the new app

Build with `VITE_BACKEND=supabase` and the project's URL and anon key, and deploy it. On each register:

1. An admin signs in and registers the device as a terminal in Settings.
2. The cashier signs in, opens a session with the opening float, and sells.

## 7. Delete the edge function

```bash
supabase functions delete make-server-81f0b18a
curl -i https://<project-ref>.supabase.co/functions/v1/make-server-81f0b18a/health
```

The request must return 404. Until the function is gone it can read and write with the service role key, whatever the row-level security rules say.

## 8. Close the remaining doors

- Authentication → Sign In / Providers: turn off "Allow new users to sign up". Members get accounts from an admin.
- The anon key has been in public git history since the Figma export. It is public by design, but rotate the project's API keys if you want old copies to stop working.
- After a few days of normal use, drop the frozen `kv_store_81f0b18a` table.
