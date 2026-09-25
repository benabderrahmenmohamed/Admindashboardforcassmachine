<?php

declare(strict_types=1);

namespace App\Db;

use App\Api\ApiError;
use App\Security\Member;
use Doctrine\DBAL\Connection;
use Symfony\Bundle\SecurityBundle\Security;

/**
 * The café's database, as a request sees it: the `cafe_app` connection with the signed-in member
 * written on it, so every policy and every function knows who is asking. Nothing here decides what
 * a member may do — the database does, and answers in the codes of contracts/errors.md.
 */
final class Cafe
{
    private ?string $acting = null;

    public function __construct(
        private readonly Connection $db,
        private readonly Security $security,
    ) {
    }

    public function member(): Member
    {
        $member = $this->security->getUser();
        if (!$member instanceof Member) {
            throw ApiError::unauthenticated('This request carries no member.');
        }

        return $member;
    }

    /** @return list<array<string, mixed>> */
    public function rows(string $sql, array $params = []): array
    {
        $this->actAsTheMember();

        return $this->db->fetchAllAssociative($sql, $params);
    }

    public function row(string $sql, array $params = []): ?array
    {
        $this->actAsTheMember();
        $row = $this->db->fetchAssociative($sql, $params);

        return false === $row ? null : $row;
    }

    public function value(string $sql, array $params = []): mixed
    {
        $this->actAsTheMember();
        $value = $this->db->fetchOne($sql, $params);

        return false === $value ? null : $value;
    }

    public function run(string $sql, array $params = []): int
    {
        $this->actAsTheMember();

        return (int) $this->db->executeStatement($sql, $params);
    }

    /** A column of JSON, as the functions and the shape helpers answer. */
    public function json(string $sql, array $params = []): ?array
    {
        $value = $this->value($sql, $params);
        if (null === $value) {
            return null;
        }

        $decoded = json_decode((string) $value, true);

        return is_array($decoded) ? $decoded : null;
    }

    /** @return list<array<string, mixed>> each row a decoded JSON column */
    public function jsonRows(string $sql, array $params = []): array
    {
        $this->actAsTheMember();

        return array_map(
            static function (array $row): array {
                $decoded = json_decode((string) reset($row), true);

                return is_array($decoded) ? $decoded : [];
            },
            $this->db->fetchAllNumeric($sql, $params),
        );
    }

    /**
     * One of the record functions — `record_sale`, `order_item_add`, `save_product` — which take the
     * payload as it was written on the device and answer with JSON.
     */
    public function call(string $function, array $payload): array
    {
        $answer = $this->json(
            sprintf('select public.%s(cast(? as jsonb))', $function),
            [json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)],
        );

        return $answer ?? [];
    }

    /**
     * Says who the request is for, once per connection. Every policy reads it, and a connection that
     * has not been told sees nothing at all.
     */
    private function actAsTheMember(): void
    {
        $member = $this->member();
        if ($this->acting === $member->userId) {
            return;
        }

        $this->db->executeStatement('select set_config(?, ?, false)', ['app.user_id', $member->userId]);
        $this->acting = $member->userId;
    }
}
