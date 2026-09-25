<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;
use RuntimeException;

/**
 * The café's schema, kept as SQL in migrations/sql/0001_schema.sql: tables, row-level security, the
 * functions that record a sale or move an order, and the triggers that keep the ledger append-only.
 *
 * It is SQL rather than entities because that is where the rules live and where they are tested. A
 * receipt number with no gaps, a sale that can never be edited and a payment that refuses a table
 * somebody changed underneath it are decided inside one transaction, by the database.
 */
final class Version20260925000001 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'The café schema: members, menu, room, orders and the append-only ledger.';
    }

    public function up(Schema $schema): void
    {
        // Straight to the driver, not through addSql: DBAL prepares every statement it is given,
        // and Postgres refuses a prepared statement that holds more than one command. The file is
        // hundreds of commands, so Postgres parses it, as psql would.
        $this->connection->getNativeConnection()->exec($this->sql('0001_schema.sql'));
    }

    public function down(Schema $schema): void
    {
        $this->throwIrreversibleMigrationException('This is the first schema: drop the database instead.');
    }

    private function sql(string $name): string
    {
        $path = __DIR__ . '/sql/' . $name;
        $sql = file_get_contents($path);
        if ($sql === false) {
            throw new RuntimeException("The schema file {$path} cannot be read.");
        }

        return $sql;
    }
}
