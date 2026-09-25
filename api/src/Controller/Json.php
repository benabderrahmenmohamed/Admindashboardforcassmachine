<?php

declare(strict_types=1);

namespace App\Controller;

use App\Api\ApiError;
use Symfony\Component\HttpFoundation\Request;

/**
 * Reading a request body without trusting it. Everything a controller takes out of a payload comes
 * through here, so a missing field or the wrong kind of value is VALIDATION_ERROR naming the field
 * rather than a type error deep in the call.
 */
final class Json
{
    /** @return array<string, mixed> */
    public static function body(Request $request): array
    {
        $raw = $request->getContent();
        if ('' === trim($raw)) {
            throw ApiError::validation('This request needs a JSON body.');
        }

        $body = json_decode($raw, true);
        if (!is_array($body)) {
            throw ApiError::validation('This request body is not a JSON object.');
        }

        return $body;
    }

    public static function string(array $body, string $field): string
    {
        $value = $body[$field] ?? null;
        if (!is_string($value) || '' === trim($value)) {
            throw ApiError::field($field, sprintf('%s is required.', $field));
        }

        return $value;
    }

    public static function text(array $body, string $field, string $fallback = ''): string
    {
        $value = $body[$field] ?? null;

        return is_string($value) ? $value : $fallback;
    }

    public static function integer(array $body, string $field): int
    {
        $value = $body[$field] ?? null;
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && '' !== $value && (string) (int) $value === $value) {
            return (int) $value;
        }

        throw ApiError::field($field, sprintf('%s must be a whole number.', $field));
    }

    public static function boolean(array $body, string $field): bool
    {
        $value = $body[$field] ?? null;
        if (!is_bool($value)) {
            throw ApiError::field($field, sprintf('%s must be true or false.', $field));
        }

        return $value;
    }

    /** A field that may be null, such as the category a product has none of. */
    public static function nullableString(array $body, string $field): ?string
    {
        $value = $body[$field] ?? null;
        if (null === $value) {
            return null;
        }
        if (!is_string($value)) {
            throw ApiError::field($field, sprintf('%s must be text or null.', $field));
        }

        return $value;
    }
}
