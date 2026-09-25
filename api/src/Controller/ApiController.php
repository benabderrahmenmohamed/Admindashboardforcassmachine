<?php

declare(strict_types=1);

namespace App\Controller;

use App\Api\ApiError;
use App\Db\Cafe;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * What every endpoint of this API has in common: the café's database, and the three answers the
 * contract repeats — a read whose JSON the database already built, a record that may be a replay, and
 * the one thing a controller checks before a record reaches the database.
 *
 * Nothing here decides who may do what. The functions and the policies do (App\Db\Cafe).
 */
abstract readonly class ApiController
{
    public function __construct(protected Cafe $cafe)
    {
    }

    /** A query whose one column is already the contract's JSON. */
    protected function answer(string $sql, array $params = [], string $whenEmpty = '[]'): JsonResponse
    {
        $json = $this->cafe->value($sql, $params);

        return JsonResponse::fromJsonString(is_string($json) ? $json : $whenEmpty);
    }

    /**
     * A record answers 201 the first time and 200 when the server has seen it before — a replay, a
     * number an admin gave up on, or a record that reached the ledger after all (contracts/errors.md).
     */
    protected function written(array $stored, string $whenNew = 'created'): JsonResponse
    {
        return new JsonResponse(
            $stored,
            $whenNew === ($stored['status'] ?? '') ? Response::HTTP_CREATED : Response::HTTP_OK,
        );
    }

    /**
     * A record addressed to one item, table or session has to be about that one. The address is not
     * written into the record: the payload hash was taken over the record as the device wrote it.
     */
    protected function mustBeAbout(string $field, string $fromTheAddress, array $record): void
    {
        $inTheRecord = $record[$field] ?? null;
        if (is_string($inTheRecord) && strtolower($inTheRecord) !== strtolower($fromTheAddress)) {
            throw ApiError::field($field, sprintf('This record is about another %s than the address it was sent to.', $field));
        }
    }

    /**
     * A timestamp from the query string, read here and passed on in one form, so the database is
     * never handed free text to interpret.
     */
    protected function moment(Request $request, string $field, bool $required = true): ?string
    {
        $value = (string) $request->query->get($field, '');
        if ('' === $value) {
            if ($required) {
                throw ApiError::field($field, sprintf('%s is required.', $field));
            }

            return null;
        }

        try {
            $moment = new \DateTimeImmutable($value);
        } catch (\Exception) {
            throw ApiError::field($field, sprintf('%s must be an ISO 8601 timestamp.', $field));
        }

        return $moment->format('Y-m-d\TH:i:s.uP');
    }

    /** An id from the query string, for a filter that names one row. */
    protected function id(Request $request, string $field, bool $required = true): ?string
    {
        $value = (string) $request->query->get($field, '');
        if ('' === $value) {
            if ($required) {
                throw ApiError::field($field, sprintf('%s is required.', $field));
            }

            return null;
        }

        return Json::uuid($value, $field);
    }
}
