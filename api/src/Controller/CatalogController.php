<?php

declare(strict_types=1);

namespace App\Controller;

use App\Api\ApiError;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/**
 * The menu: what the café sells, what is on it today, and what is counted.
 *
 * Who may do what is not decided here. `save_product` and `adjust_stock` ask for the admin role
 * themselves, the availability toggle takes admins, cashiers and waiters because a dish runs out
 * while the owner is away, and row-level security keeps every read to the caller's own café. A
 * controller that also checked would be a second opinion on the same question, and the two would
 * drift.
 */
final readonly class CatalogController extends ApiController
{
    /**
     * The contract's Category, from a row of `c`. Built in the database like every other read here,
     * so that `created_at` leaves as the contract's date-time: a timestamp handed straight from the
     * driver is Postgres's own spelling, which is not the one this API answers with
     * (App\Api\WireTimestamps).
     */
    private const CATEGORY = <<<'SQL'
        json_build_object('id', c.id, 'name', c.name, 'color', c.color, 'created_at', c.created_at)
        SQL;

    #[Route('/api/v1/products', methods: ['GET'])]
    public function products(): JsonResponse
    {
        return new JsonResponse($this->cafe->jsonRows(
            'select private.product_json(p) from public.products p where p.archived_at is null order by p.created_at, p.id',
        ));
    }

    #[Route('/api/v1/products', methods: ['POST'])]
    public function createProduct(Request $request): JsonResponse
    {
        $body = Json::body($request);

        return new JsonResponse(
            $this->cafe->call('save_product', $this->productFields($body) + ['stock_delta' => Json::integer($body, 'opening_stock')]),
            Response::HTTP_CREATED,
        );
    }

    #[Route('/api/v1/products/{productId}', methods: ['PUT'])]
    public function updateProduct(string $productId, Request $request): JsonResponse
    {
        $body = Json::body($request);

        return new JsonResponse($this->cafe->call('save_product', $this->productFields($body) + [
            'id' => $productId,
            'stock_delta' => Json::integer($body, 'stock_delta'),
        ]));
    }

    #[Route('/api/v1/products/{productId}', methods: ['DELETE'])]
    public function archiveProduct(string $productId): Response
    {
        $this->cafe->value('select public.archive_product(cast(? as uuid))', [Json::uuid($productId, 'product_id')]);

        return new Response(status: Response::HTTP_NO_CONTENT);
    }

    #[Route('/api/v1/products/{productId}/availability', methods: ['PUT'])]
    public function availability(string $productId, Request $request): JsonResponse
    {
        $isAvailable = Json::boolean(Json::body($request), 'is_available');

        return new JsonResponse($this->cafe->json(
            'select public.set_product_availability(cast(? as uuid), cast(? as boolean))',
            [Json::uuid($productId, 'product_id'), $isAvailable ? 'true' : 'false'],
        ));
    }

    #[Route('/api/v1/stock-adjustments', methods: ['POST'])]
    public function adjustStock(Request $request): JsonResponse
    {
        $body = Json::body($request);
        $answer = $this->cafe->call('adjust_stock', [
            'id' => Json::string($body, 'id'),
            'product_id' => Json::string($body, 'product_id'),
            'qty_delta' => Json::integer($body, 'qty_delta'),
            'reason' => Json::string($body, 'reason'),
            'payload_hash' => Json::string($body, 'payload_hash'),
        ]);

        // A record that arrives twice answers what it answered the first time, and says so.
        return $this->written($answer);
    }

    #[Route('/api/v1/categories', methods: ['GET'])]
    public function categories(): JsonResponse
    {
        $category = self::CATEGORY;

        return $this->answer(<<<SQL
            select coalesce(json_agg({$category} order by c.created_at, c.id), '[]'::json)
            from public.categories c
            SQL);
    }

    #[Route('/api/v1/categories', methods: ['POST'])]
    public function createCategory(Request $request): JsonResponse
    {
        $body = Json::body($request);
        $name = trim(Json::string($body, 'name'));
        $color = Json::string($body, 'color');
        // The column says the same thing, but a check constraint raises no code the contract knows,
        // and a device told SERVER_ERROR would retry a colour that can never be accepted.
        if (1 !== preg_match('/^#[0-9a-fA-F]{6}$/', $color)) {
            throw ApiError::field('color', 'A colour is a hash and six hexadecimal digits.');
        }

        // The shop is the column's default and the policy's condition, and that policy takes admins
        // only: a cashier's insert matches nothing and Postgres refuses it, which leaves here as
        // FORBIDDEN (App\Api\DatabaseErrors). This controller decides neither.
        $category = self::CATEGORY;

        return new JsonResponse(
            $this->cafe->json(<<<SQL
                insert into public.categories as c (name, color) values (?, ?)
                returning {$category}
                SQL, [$name, $color]),
            Response::HTTP_CREATED,
        );
    }

    #[Route('/api/v1/categories/{categoryId}', methods: ['DELETE'])]
    public function deleteCategory(string $categoryId): Response
    {
        $id = Json::uuid($categoryId, 'category_id');
        $deleted = $this->cafe->run('delete from public.categories where id = cast(? as uuid)', [$id]);
        if (0 === $deleted) {
            // Nothing deleted is two different answers. The delete policy takes admins only and a
            // policy that matches nothing deletes nothing quietly, so a category the caller can see
            // but not delete would otherwise be reported as one that does not exist.
            throw null === $this->cafe->value('select 1 from public.categories where id = cast(? as uuid)', [$id])
                ? ApiError::notFound('That category does not exist.', ['category_id' => $categoryId])
                : ApiError::forbidden('Only an admin can delete a category.', ['category_id' => $categoryId]);
        }

        return new Response(status: Response::HTTP_NO_CONTENT);
    }

    /** The fields both saves share, straight from the contract's ProductFields. */
    private function productFields(array $body): array
    {
        return [
            'name' => Json::string($body, 'name'),
            'price_millimes' => Json::integer($body, 'price_millimes'),
            'category_id' => Json::nullableString($body, 'category_id'),
            'barcode' => Json::text($body, 'barcode'),
            'description' => Json::text($body, 'description'),
            'image_url' => Json::text($body, 'image_url'),
            'is_available' => Json::boolean($body, 'is_available'),
            'track_stock' => Json::boolean($body, 'track_stock'),
        ];
    }
}
