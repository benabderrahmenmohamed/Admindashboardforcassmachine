<?php

declare(strict_types=1);

namespace App\Tests\Support;

use App\Demo\DemoSeeder;
use Doctrine\DBAL\Connection;

/**
 * The café a test starts from: the schema applied once to the test database, and the demo shop in
 * it. Tests that write clean up after themselves — nothing here empties the database between tests,
 * because most of them only read, and the ledger cannot be emptied anyway.
 */
trait CafeSchema
{
    protected function applySchemaOnce(Connection $admin): void
    {
        if (null === $admin->fetchOne("select to_regclass('public.shops')")) {
            $schema = file_get_contents(\dirname(__DIR__, 2) . '/migrations/sql/0001_schema.sql');
            self::assertIsString($schema, 'The schema file must be readable.');
            $admin->getNativeConnection()->exec($schema);
        }

        $seeder = new DemoSeeder();
        if (!$seeder->isSeeded($admin)) {
            $seeder->seed($admin);
        }
    }
}
