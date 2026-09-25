<?php

declare(strict_types=1);

namespace App\Api;

use RuntimeException;
use Throwable;

/**
 * A failure the contract has a name for (contracts/errors.md). The client decides what to do from
 * the code alone — retry, pause, or stop and ask a person — so the code is the part that matters and
 * the message is only for whoever reads it.
 */
final class ApiError extends RuntimeException
{
    private const STATUS = [
        'UNAUTHENTICATED' => 401,
        'FORBIDDEN' => 403,
        'NOT_FOUND' => 404,
        'ITEM_NOT_FOUND' => 404,
        'VALIDATION_ERROR' => 422,
        'IDEMPOTENCY_CONFLICT' => 409,
        'SEQUENCE_GAP' => 409,
        'SESSION_CLOSED' => 409,
        'SESSION_ALREADY_OPEN' => 409,
        'TERMINAL_SUPERSEDED' => 409,
        'ORDER_CHANGED' => 409,
        'ORDER_CLOSED' => 409,
        'TABLE_INACTIVE' => 409,
        'RATE_LIMITED' => 429,
        'SERVER_ERROR' => 500,
    ];

    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly array $details = [],
        public readonly ?int $status = null,
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }

    public function statusCode(): int
    {
        return $this->status ?? self::STATUS[$this->errorCode] ?? 500;
    }

    /** The body of every failure: `{ error: { code, message, details } }`. */
    public function toWire(): array
    {
        $error = ['code' => $this->errorCode, 'message' => $this->getMessage()];
        if ([] !== $this->details) {
            $error['details'] = $this->details;
        }

        return ['error' => $error];
    }

    public static function validation(string $message, array $details = []): self
    {
        return new self('VALIDATION_ERROR', $message, $details);
    }

    public static function field(string $field, string $message): self
    {
        return new self('VALIDATION_ERROR', $message, ['field' => $field]);
    }

    public static function unauthenticated(string $message = 'Sign in first.'): self
    {
        return new self('UNAUTHENTICATED', $message);
    }

    public static function forbidden(string $message, array $details = []): self
    {
        return new self('FORBIDDEN', $message, $details);
    }

    public static function notFound(string $message, array $details = []): self
    {
        return new self('NOT_FOUND', $message, $details);
    }
}
