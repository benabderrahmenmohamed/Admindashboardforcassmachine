<?php

declare(strict_types=1);

namespace App\Api;

use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Every timestamp leaves in one form: `2026-09-25T14:03:11.250Z`.
 *
 * The contract says `format: date-time` (contracts/openapi.yaml, Timestamp) and its clients compare
 * timestamps as text - a kitchen ticket's `sent_at` is the `created_at` the device sent, to the
 * letter - so the form matters as much as the moment. Postgres writes a timestamptz in JSON as
 * `2026-09-25T14:03:11.25+00:00`: the same moment, another spelling, with the fraction trimmed to
 * whatever it needs. The one every client of this API already writes is JavaScript's: UTC, `Z`, three
 * digits of a second, always.
 *
 * Doing it here, once, on the way out, is why no query has to remember: the reads shape their JSON in
 * the database and the record functions were written for Supabase, and neither knows about this.
 * The pattern matches a complete JSON string and nothing else can look like one, so a value that is
 * not a timestamp cannot be caught by it. An offset other than UTC is left alone on purpose - the
 * connection is set to UTC (App\Db\Cafe), and a timestamp that arrives in another zone is a mistake
 * that should be seen rather than quietly rewritten.
 */
final readonly class WireTimestamps implements EventSubscriberInterface
{
    private const AS_POSTGRES_WRITES_IT = '/"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?\+00:00"/';

    public static function getSubscribedEvents(): array
    {
        return [KernelEvents::RESPONSE => 'onResponse'];
    }

    public function onResponse(ResponseEvent $event): void
    {
        $response = $event->getResponse();
        if (!$response instanceof JsonResponse || !str_starts_with($event->getRequest()->getPathInfo(), '/api/')) {
            return;
        }

        $body = $response->getContent();
        if (!is_string($body) || '' === $body) {
            return;
        }

        $answer = preg_replace_callback(
            self::AS_POSTGRES_WRITES_IT,
            static fn (array $timestamp): string => sprintf(
                '"%sT%s.%sZ"',
                $timestamp[1],
                $timestamp[2],
                // Three digits, whether Postgres wrote six, one or none at all.
                substr(str_pad($timestamp[3] ?? '', 3, '0'), 0, 3),
            ),
            $body,
        );

        if (null !== $answer) {
            $response->setContent($answer);
        }
    }
}
