<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;
use RuntimeException;

/** The change log the polling endpoint reads: see migrations/sql/0002_changes.sql. */
final class Version20260925000002 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'What changed and when, per café and topic, for clients that poll.';
    }

    public function up(Schema $schema): void
    {
        $this->connection->getNativeConnection()->exec($this->sql('0002_changes.sql'));
    }

    public function down(Schema $schema): void
    {
        $this->addSql('drop table if exists private.shop_changes cascade');
        $this->addSql('drop function if exists private.note_change() cascade');
    }

    private function sql(string $name): string
    {
        $path = __DIR__ . '/sql/' . $name;
        $sql = file_get_contents($path);
        if ($sql === false) {
            throw new RuntimeException("The file {$path} cannot be read.");
        }

        return $sql;
    }
}
