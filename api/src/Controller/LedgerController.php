<?php

declare(strict_types=1);

namespace App\Controller;

use App\Api\ApiError;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * The ledger: what was paid, what was given back, and the numbers an admin gave up on.
 *
 * Nothing here is ever changed or deleted - the tables refuse it, whoever asks - so both writes are
 * records a terminal wrote and handed over as written. `record_sale` recomputes every amount from the
 * lines, takes the next receipt number of that terminal and no other, and answers the same thing
 * however often the record arrives; `void_receipt` burns a number the ledger can never accept, so the
 * numbering stays gapless. This controller carries them and reads the result back.
 */
final readonly class LedgerController extends ApiController
{
    /** How many sales to answer with when a caisse does not say (contracts/openapi.yaml). */
    private const RECENT = 50;

    private const MOST = 200;

    /** The contract's Sale, from a row of `s` with its terminal `t` and its table `dt`. */
    private const SALE = <<<'SQL'
        json_build_object(
          'id', s.id, 'kind', s.kind, 'receipt_number', s.receipt_number, 'seq', s.seq,
          'terminal_id', s.terminal_id, 'terminal_code', t.code, 'session_id', s.session_id,
          'table_id', s.table_id, 'table_name', dt.name, 'refunds_sale_id', s.refunds_sale_id,
          'payment_method', s.payment_method, 'cart_discount_millimes', s.cart_discount_millimes,
          'total_millimes', s.total_millimes, 'tendered_millimes', s.tendered_millimes,
          'change_millimes', s.change_millimes, 'created_at', s.created_at, 'received_at', s.received_at,
          'lines', coalesce((
            select json_agg(
              json_build_object(
                'id', l.id, 'line_no', l.line_no, 'open_order_item_id', l.open_order_item_id,
                'product_id', l.product_id, 'product_name', l.product_name, 'qty', l.qty,
                'unit_price_millimes', l.unit_price_millimes,
                'line_discount_millimes', l.line_discount_millimes,
                'line_discount_reason', l.line_discount_reason,
                'allocated_discount_millimes', l.allocated_discount_millimes,
                -- net_millimes in the payload and in docs/spec.md; the column kept its first name.
                'net_millimes', l.line_total_millimes,
                'refunds_sale_line_id', l.refunds_sale_line_id,
                -- What refunds from any terminal have taken back of this line, as positive amounts.
                'refunded_qty', coalesce(back.qty, 0),
                'refunded_millimes', coalesce(back.millimes, 0)
              )
              order by l.line_no
            )
            from public.sale_lines l
            left join lateral (
              select (-sum(r.qty))::int as qty, (-sum(r.line_total_millimes))::bigint as millimes
              from public.sale_lines r
              where r.refunds_sale_line_id = l.id
            ) back on true
            where l.sale_id = s.id
          ), '[]'::json)
        )
        SQL;

    /** Sales and refunds, newest first, of one terminal or session or table, or of the whole café. */
    #[Route('/api/v1/sales', methods: ['GET'])]
    public function sales(Request $request): JsonResponse
    {
        $sale = self::SALE;
        $params = [];
        $only = '';
        foreach (['terminal_id' => 's.terminal_id', 'session_id' => 's.session_id', 'table_id' => 's.table_id'] as $field => $column) {
            $id = $this->id($request, $field, required: false);
            if (null !== $id) {
                $only .= sprintf(' and %s = cast(? as uuid)', $column);
                $params[] = $id;
            }
        }
        $params[] = $this->howMany($request);

        return $this->answer(<<<SQL
            select coalesce(json_agg(sale order by received_at desc, seq desc), '[]'::json) from (
              select s.received_at, s.seq, {$sale} as sale
              from public.sales s
              join public.terminals t on t.id = s.terminal_id
              left join public.dining_tables dt on dt.id = s.table_id
              where true {$only}
              order by s.received_at desc, s.seq desc
              limit ?
            ) newest
            SQL, $params);
    }

    #[Route('/api/v1/sales', methods: ['POST'])]
    public function recordSale(Request $request): JsonResponse
    {
        return $this->written($this->cafe->call('record_sale', Json::body($request)));
    }

    /** One sale, with how much of each line has been given back since. */
    #[Route('/api/v1/sales/{saleId}', methods: ['GET'])]
    public function sale(string $saleId): JsonResponse
    {
        $sale = self::SALE;
        $json = $this->cafe->value(<<<SQL
            select {$sale}
            from public.sales s
            join public.terminals t on t.id = s.terminal_id
            left join public.dining_tables dt on dt.id = s.table_id
            where s.id = cast(? as uuid)
            SQL, [Json::uuid($saleId, 'sale_id')]);

        if (!is_string($json)) {
            throw ApiError::notFound('The sale does not exist.', ['sale_id' => $saleId]);
        }

        return JsonResponse::fromJsonString($json);
    }

    #[Route('/api/v1/receipt-voids', methods: ['POST'])]
    public function voidReceipt(Request $request): JsonResponse
    {
        // 201 is the void this call made; 200 is one already stored, or a record that reached the
        // ledger after all - which is why the outcome that belongs to 201 is not `created` here.
        return $this->written($this->cafe->call('void_receipt', Json::body($request)), 'voided');
    }

    /** How many sales the caisse asked for: the contract's 1 to 200, fifty when it did not say. */
    private function howMany(Request $request): int
    {
        $asked = (string) $request->query->get('limit', '');
        if ('' === $asked) {
            return self::RECENT;
        }

        $limit = filter_var($asked, FILTER_VALIDATE_INT);
        if (false === $limit || $limit < 1 || $limit > self::MOST) {
            throw ApiError::field('limit', sprintf('limit is a whole number from 1 to %d.', self::MOST));
        }

        return $limit;
    }
}
