<?php

declare(strict_types=1);

namespace App\Tests\Database;

use App\Demo\DemoSeeder;
use Doctrine\DBAL\Connection;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;

/**
 * A test with the café in front of it: the schema applied and the demo shop seeded once, then two
 * connections — `app`, the role a request uses and row-level security applies to, and `admin`, the
 * owner, which is how a migration or a fixture writes.
 */
abstract class DatabaseTestCase extends KernelTestCase
{
    protected Connection $app;
    protected Connection $admin;

    protected function setUp(): void
    {
        self::bootKernel();
        $container = self::getContainer();
        $this->app = $container->get('doctrine.dbal.default_connection');
        $this->admin = $container->get('doctrine.dbal.admin_connection');

        $this->applySchemaOnce();
        $this->actAs(null);
    }

    /**
     * Who the request is by, as the API sets it once it has read the token. Null is nobody signed
     * in, which every policy reads as "no rows".
     */
    protected function actAs(?string $userId): void
    {
        $this->app->executeStatement('select set_config(?, ?, false)', ['app.user_id', $userId ?? '']);
    }

    private function applySchemaOnce(): void
    {
        if (null === $this->admin->fetchOne("select to_regclass('public.shops')")) {
            $schema = file_get_contents(\dirname(__DIR__, 2) . '/migrations/sql/0001_schema.sql');
            self::assertIsString($schema, 'The schema file must be readable.');
            $this->admin->getNativeConnection()->exec($schema);
        }

        $seeder = new DemoSeeder();
        if (!$seeder->isSeeded($this->admin)) {
            $seeder->seed($this->admin);
        }
    }
}
