<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;
use RuntimeException;

/** What this server's own reads are allowed to call: see migrations/sql/0003_reads.sql. */
final class Version20260925000003 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'The café model’s session shape, for the reads of this server.';
    }

    public function up(Schema $schema): void
    {
        $this->connection->getNativeConnection()->exec($this->sql('0003_reads.sql'));
    }

    public function down(Schema $schema): void
    {
        $this->addSql('revoke execute on function private.session_json(public.cash_sessions) from cafe_app');
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
