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
 * The menu: what the café sells, what is on it today, and what is counted.
 *
 * Who may do what is not decided here. `save_product` and `adjust_stock` ask for the admin role
 * themselves, the availability toggle takes admins, cashiers and waiters because a dish runs out
 * while the owner is away, and row-level security keeps every read to the caller's own café. A
 * controller that also checked would be a second opinion on the same question, and the two would
 * drift.
 */
final readonly class CatalogController
{
    public function __construct(private Cafe $cafe)
    {
    }

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
        return new JsonResponse($answer, 'replayed' === ($answer['status'] ?? '') ? Response::HTTP_OK : Response::HTTP_CREATED);
    }

    #[Route('/api/v1/categories', methods: ['GET'])]
    public function categories(): JsonResponse
    {
        return new JsonResponse($this->cafe->rows(
            'select id, name, color, created_at from public.categories order by created_at, id',
        ));
    }

    #[Route('/api/v1/categories', methods: ['POST'])]
    public function createCategory(Request $request): JsonResponse
    {
        $body = Json::body($request);
        $name = trim(Json::string($body, 'name'));
        $color = Json::text($body, 'color', '#3b82f6');

        // The shop is the column's default and the policy's condition: a category cannot be created
        // in a café the caller does not work in, whatever this controller sends.
        $category = $this->cafe->row(
            'insert into public.categories (name, color) values (?, ?) returning id, name, color, created_at',
            [$name, $color],
        );

        return new JsonResponse($category, Response::HTTP_CREATED);
    }

    #[Route('/api/v1/categories/{categoryId}', methods: ['DELETE'])]
    public function deleteCategory(string $categoryId): Response
    {
        $deleted = $this->cafe->run(
            'delete from public.categories where id = cast(? as uuid)',
            [Json::uuid($categoryId, 'category_id')],
        );
        if (0 === $deleted) {
            throw ApiError::notFound('That category does not exist.', ['category_id' => $categoryId]);
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
