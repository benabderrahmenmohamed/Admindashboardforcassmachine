<?php

declare(strict_types=1);

namespace App\Controller;

use App\Api\ApiError;
use App\Db\Cafe;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/**
 * The room: the tables, what is on them, and what the kitchen still has to make.
 *
 * Each read is one query that Postgres shapes into the contract's JSON, so a board or a ticket
 * arrives whole rather than as rows a controller stitches back together.
 *
 * Each write is one of the five order records, handed to the function that owns its rules exactly as
 * the device wrote it. Nothing here picks the record apart: the payload hash is computed over those
 * keys, the append-only log keeps the payload, and a controller that rebuilt it would store
 * something the device never wrote. The functions validate every field and answer in the codes of
 * contracts/errors.md; a record that arrives twice answers what it answered the first time.
 */
final readonly class RoomController
{
    /** The contract's OpenOrderItem, from a row of `i`. */
    private const ITEM = <<<'SQL'
        json_build_object(
          'id', i.id, 'order_id', i.order_id, 'product_id', i.product_id,
          'name_snapshot', i.name_snapshot, 'unit_price_millimes', i.unit_price_millimes,
          'qty', i.qty, 'note', i.note, 'added_by', i.added_by, 'added_at', i.added_at,
          'sent_at', i.sent_at, 'prepared_at', i.prepared_at, 'removed_at', i.removed_at,
          'removed_by', i.removed_by, 'removed_reason', i.removed_reason, 'paid_sale_id', i.paid_sale_id
        )
        SQL;

    /** The contract's DiningTable, from a row of `t`. */
    private const TABLE = <<<'SQL'
        json_build_object('id', t.id, 'name', t.name, 'sort_order', t.sort_order, 'is_active', t.is_active)
        SQL;

    public function __construct(private Cafe $cafe)
    {
    }

    #[Route('/api/v1/dining-tables', methods: ['GET'])]
    public function tables(): JsonResponse
    {
        $table = self::TABLE;

        // Retired tables included: the admin's list is the whole room, past and present.
        return $this->answer(<<<SQL
            select coalesce(json_agg({$table} order by t.sort_order, t.id), '[]'::json)
            from public.dining_tables t
            SQL);
    }

    #[Route('/api/v1/dining-tables', methods: ['POST'])]
    public function createTable(Request $request): JsonResponse
    {
        return new JsonResponse(
            $this->cafe->call('save_dining_table', $this->tableInput(Json::body($request))),
            Response::HTTP_CREATED,
        );
    }

    #[Route('/api/v1/dining-tables/{tableId}', methods: ['PUT'])]
    public function updateTable(string $tableId, Request $request): JsonResponse
    {
        // The id comes from the address, so a body cannot rename another table than the one asked for.
        return new JsonResponse($this->cafe->call(
            'save_dining_table',
            ['id' => $tableId] + $this->tableInput(Json::body($request)),
        ));
    }

    /** One tile per table in service: what it owes, and what is still to send or to pay. */
    #[Route('/api/v1/table-board', methods: ['GET'])]
    public function board(): JsonResponse
    {
        $table = self::TABLE;

        return $this->answer(<<<SQL
            select coalesce(json_agg(entry order by sort_order, id), '[]'::json) from (
              select t.sort_order, t.id,
                json_build_object(
                  'table', {$table},
                  'order_id', o.id,
                  'opened_at', o.opened_at,
                  'due_millimes', coalesce(sum(i.qty * i.unit_price_millimes)
                    filter (where i.removed_at is null and i.paid_sale_id is null), 0)::bigint,
                  'active_count', count(i.id) filter (where i.removed_at is null),
                  'unsent_count', count(i.id) filter (where i.removed_at is null and i.sent_at is null),
                  'unpaid_count', count(i.id) filter (where i.removed_at is null and i.paid_sale_id is null)
                ) as entry
              from public.dining_tables t
              left join public.open_orders o on o.table_id = t.id and o.status = 'open'
              left join public.open_order_items i on i.order_id = o.id
              where t.is_active
              group by t.id, t.name, t.sort_order, t.is_active, o.id, o.opened_at
            ) tiles
            SQL);
    }

    /** The table's open order with every line it ever had, or null when the table is free. */
    #[Route('/api/v1/dining-tables/{tableId}/open-order', methods: ['GET'])]
    public function openOrder(string $tableId): JsonResponse
    {
        $item = self::ITEM;

        return $this->answer(<<<SQL
            select json_build_object(
              'id', o.id, 'table_id', o.table_id, 'status', o.status,
              'opened_at', o.opened_at, 'closed_at', o.closed_at,
              'items', coalesce((
                select json_agg({$item} order by i.added_at, i.id)
                from public.open_order_items i
                where i.order_id = o.id
              ), '[]'::json)
            )
            from public.open_orders o
            where o.table_id = cast(? as uuid) and o.status = 'open'
            SQL, [Json::uuid($tableId, 'table_id')], 'null');
    }

    /** One card per send, oldest first: what the kitchen has been told about and not yet made. */
    #[Route('/api/v1/kitchen-tickets', methods: ['GET'])]
    public function kitchenTickets(): JsonResponse
    {
        $item = self::ITEM;

        // A paid table keeps its ticket - the coffee still has to be made - and a cancelled one
        // loses it, because its items left the table with it.
        return $this->answer(<<<SQL
            select coalesce(json_agg(ticket order by sent_at, order_id), '[]'::json) from (
              select o.id as order_id, i.sent_at,
                json_build_object(
                  'order_id', o.id, 'table_id', o.table_id, 'table_name', t.name, 'sent_at', i.sent_at,
                  'items', json_agg({$item} order by i.added_at, i.id)
                ) as ticket
              from public.open_order_items i
              join public.open_orders o on o.id = i.order_id
              join public.dining_tables t on t.id = o.table_id
              where i.sent_at is not null and i.prepared_at is null and i.removed_at is null
                and o.status <> 'cancelled'
              group by o.id, o.table_id, t.name, i.sent_at
            ) tickets
            SQL);
    }

    #[Route('/api/v1/order-items', methods: ['POST'])]
    public function addItem(Request $request): JsonResponse
    {
        // The record names the table, never an order: two devices adding to the same free table
        // cannot race on creating one, because the function finds the open order or opens it.
        return $this->written($this->cafe->call('order_item_add', Json::body($request)));
    }

    #[Route('/api/v1/order-items/{itemId}/removals', methods: ['POST'])]
    public function removeItem(string $itemId, Request $request): JsonResponse
    {
        $record = Json::body($request);
        $this->mustBeAbout('item_id', $itemId, $record);

        return $this->written($this->cafe->call('order_item_remove', $record));
    }

    #[Route('/api/v1/order-items/{itemId}/preparations', methods: ['POST'])]
    public function prepareItem(string $itemId, Request $request): JsonResponse
    {
        $record = Json::body($request);
        $this->mustBeAbout('item_id', $itemId, $record);

        return $this->written($this->cafe->call('order_item_prepare', $record));
    }

    #[Route('/api/v1/dining-tables/{tableId}/sends', methods: ['POST'])]
    public function send(string $tableId, Request $request): JsonResponse
    {
        $record = Json::body($request);
        $this->mustBeAbout('table_id', $tableId, $record);

        return $this->written($this->cafe->call('order_send', $record));
    }

    #[Route('/api/v1/dining-tables/{tableId}/cancellations', methods: ['POST'])]
    public function cancel(string $tableId, Request $request): JsonResponse
    {
        $record = Json::body($request);
        $this->mustBeAbout('table_id', $tableId, $record);

        return $this->written($this->cafe->call('order_cancel', $record));
    }

    /**
     * What changed in this café since `since`, by name. Supabase pushed these names down a live
     * connection; this server holds none, so a screen asks. The answer carries no rows: a screen that
     * hears its topic reads again, so a missed poll costs a read and never a wrong screen.
     *
     * The cursor is read before the changes, never after: a change landing between the two is
     * answered twice rather than never.
     */
    #[Route('/api/v1/open-orders', methods: ['GET'])]
    public function changes(Request $request): JsonResponse
    {
        // Opaque, and to the microsecond: the wire's timestamps are rounded to the millisecond
        // (App\Api\WireTimestamps), and a cursor rounded down would answer the same change twice.
        $cursor = (string) $this->cafe->value(
            "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
        );
        $since = $request->query->get('since');

        if (null === $since || '' === $since) {
            // The first poll: what changed before a screen opened is already in what it read.
            return new JsonResponse(['cursor' => $cursor, 'topics' => []]);
        }

        $topics = $this->cafe->rows(
            'select topic from private.shop_changes where changed_at > cast(? as timestamptz) order by topic',
            [$this->moment($since, 'since')],
        );

        return new JsonResponse(['cursor' => $cursor, 'topics' => array_column($topics, 'topic')]);
    }

    /** The admin's report: what was taken off a table after the kitchen had been told. */
    #[Route('/api/v1/reports/removed-after-sent-items', methods: ['GET'])]
    public function removedAfterSent(Request $request): JsonResponse
    {
        return $this->answer(
            'select public.removed_after_sent(cast(? as timestamptz), cast(? as timestamptz))',
            [$this->period($request, 'from'), $this->period($request, 'to')],
        );
    }

    /** The fields a table's form sends. `save_dining_table` decides whether each one is good. */
    private function tableInput(array $body): array
    {
        return array_intersect_key($body, array_flip(['name', 'sort_order', 'is_active']));
    }

    /** A record addressed to one item or table has to be about that one. */
    private function mustBeAbout(string $field, string $fromTheAddress, array $record): void
    {
        $inTheRecord = $record[$field] ?? null;
        if (is_string($inTheRecord) && strtolower($inTheRecord) !== strtolower($fromTheAddress)) {
            throw ApiError::field($field, sprintf('This record is about another %s than the address it was sent to.', $field));
        }
    }

    /** A record answers 201 the first time and 200 when the server has seen it before. */
    private function written(array $stored): JsonResponse
    {
        return new JsonResponse(
            $stored,
            'replayed' === ($stored['status'] ?? '') ? Response::HTTP_OK : Response::HTTP_CREATED,
        );
    }

    /** A query whose one column is already the contract's JSON. */
    private function answer(string $sql, array $params = [], string $whenEmpty = '[]'): JsonResponse
    {
        $json = $this->cafe->value($sql, $params);

        return JsonResponse::fromJsonString(is_string($json) ? $json : $whenEmpty);
    }

    /** One end of a report's period. Both are required, and a report is always of a named one. */
    private function period(Request $request, string $field): string
    {
        $value = (string) $request->query->get($field, '');
        if ('' === $value) {
            throw ApiError::field($field, sprintf('%s is required.', $field));
        }

        return $this->moment($value, $field);
    }

    /**
     * A timestamp from the query string, read here and passed on in one form, so the database is
     * never handed free text to interpret.
     */
    private function moment(string $value, string $field): string
    {
        try {
            $moment = new \DateTimeImmutable($value);
        } catch (\Exception) {
            throw ApiError::field($field, sprintf('%s must be an ISO 8601 timestamp.', $field));
        }

        return $moment->format('Y-m-d\TH:i:s.uP');
    }
}
