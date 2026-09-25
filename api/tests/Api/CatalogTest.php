<?php

declare(strict_types=1);

namespace App\Tests\Api;

/**
 * The menu over HTTP: what a café sells, what is on it today, and what is counted. Who may change
 * what is the database's answer, not this server's, and these tests read it back through the API.
 */
final class CatalogTest extends ApiTestCase
{
    private const EXPRESS = '55555555-5555-4555-8555-555555555505';
    private const WATER = '55555555-5555-4555-8555-555555555501';

    public function testTheMenuIsTheCafesOwnAndCarriesWhatTheContractAsksFor(): void
    {
        $products = $this->call('GET', '/api/v1/products', $this->tokenFor(self::WAITER));

        self::assertSame(200, $this->httpStatus());
        self::assertCount(12, $products);
        // jsonb keeps no order of its own, so the contract's fields are a set, not a list.
        $fields = array_keys($products[0]);
        sort($fields);
        self::assertSame(
            ['barcode', 'category_id', 'category_name', 'created_at', 'description', 'id', 'image_url', 'is_available', 'name', 'price_millimes', 'stock_qty', 'track_stock', 'updated_at'],
            $fields,
        );
        $water = $this->find($products, self::WATER);
        self::assertSame('Eau minérale 50 cl', $water['name']);
        self::assertSame(850, $water['price_millimes']);
        self::assertSame('Boissons fraîches', $water['category_name']);
        self::assertTrue($water['track_stock']);
        self::assertSame(120, $water['stock_qty']);
    }

    public function testAnotherCafeReadsItsOwnMenuAndNeverThisOne(): void
    {
        $products = $this->call('GET', '/api/v1/products', $this->tokenFor(self::OTHER_ADMIN));

        self::assertCount(2, $products);
        self::assertSame(['Other product A', 'Other product B'], array_column($products, 'name'));
    }

    public function testAnAdminAddsSomethingToTheMenuAndACashierCannot(): void
    {
        $fields = [
            'name' => 'Bambalouni',
            'price_millimes' => 1500,
            'category_id' => null,
            'barcode' => '',
            'description' => 'Fried, with sugar',
            'image_url' => '',
            'is_available' => true,
            'track_stock' => true,
            'opening_stock' => 20,
        ];

        $refused = $this->call('POST', '/api/v1/products', $this->tokenFor(self::CASHIER), $fields);
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused));

        $created = $this->call('POST', '/api/v1/products', $this->tokenFor(self::ADMIN), $fields);

        self::assertSame(201, $this->httpStatus());
        self::assertSame('Bambalouni', $created['name']);
        self::assertTrue($created['track_stock'], 'what the form says about counting is what is saved');
        self::assertSame(20, $created['stock_qty'], 'and its opening stock is a movement, not a number typed in');

        $menu = $this->call('GET', '/api/v1/products', $this->tokenFor(self::WAITER));
        self::assertCount(13, $menu);
    }

    public function testAnEditMovesStockByTheDeltaAndNothingElse(): void
    {
        $token = $this->tokenFor(self::ADMIN);

        $updated = $this->call('PUT', '/api/v1/products/' . self::WATER, $token, [
            'name' => 'Eau minérale 50 cl',
            'price_millimes' => 900,
            'category_id' => '44444444-4444-4444-8444-444444444401',
            'barcode' => '6194000100015',
            'description' => '',
            'image_url' => '',
            'is_available' => true,
            'track_stock' => true,
            'stock_delta' => -20,
        ]);

        self::assertSame(200, $this->httpStatus());
        self::assertSame(900, $updated['price_millimes']);
        self::assertSame(100, $updated['stock_qty'], 'the shelf was counted twenty short, so twenty come off');
    }

    public function testTakingSomethingOffTheMenuIsTheFloorsToDoAndTheKitchensToLeaveAlone(): void
    {
        $refused = $this->call('PUT', '/api/v1/products/' . self::EXPRESS . '/availability', $this->tokenFor(self::KITCHEN), ['is_available' => false]);
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused));

        $soldOut = $this->call('PUT', '/api/v1/products/' . self::EXPRESS . '/availability', $this->tokenFor(self::WAITER), ['is_available' => false]);

        self::assertSame(200, $this->httpStatus());
        self::assertFalse($soldOut['is_available']);
        self::assertSame(1200, $soldOut['price_millimes'], 'the price of a dish that ran out is nobody else’s business');
    }

    public function testAnArchivedProductLeavesTheMenu(): void
    {
        $token = $this->tokenFor(self::ADMIN);

        $this->call('DELETE', '/api/v1/products/' . self::EXPRESS, $token);
        self::assertSame(204, $this->httpStatus());

        $menu = $this->call('GET', '/api/v1/products', $token);
        self::assertCount(11, $menu);
        self::assertSame([], array_filter($menu, static fn (array $p): bool => self::EXPRESS === $p['id']));
    }

    public function testAStockCorrectionCountsOnceHoweverOftenItArrives(): void
    {
        $token = $this->tokenFor(self::ADMIN);
        $record = [
            'id' => '99999999-9999-4999-8999-999999999901',
            'product_id' => self::WATER,
            'qty_delta' => -5,
            'reason' => 'Two broke, three went missing',
            'payload_hash' => str_repeat('a', 64),
        ];

        $first = $this->call('POST', '/api/v1/stock-adjustments', $token, $record);
        self::assertSame(201, $this->httpStatus());
        self::assertSame('created', $first['status']);
        self::assertSame(self::WATER, $first['product_id']);
        self::assertSame(115, $first['stock_qty']);

        $again = $this->call('POST', '/api/v1/stock-adjustments', $token, $record);
        self::assertSame(200, $this->httpStatus());
        self::assertSame('replayed', $again['status']);
        self::assertSame(115, $again['stock_qty'], 'a replay answers what it answered then, not what is true now');

        $menu = $this->call('GET', '/api/v1/products', $token);
        self::assertSame(115, $this->find($menu, self::WATER)['stock_qty'], 'the same correction never counts twice');
    }

    public function testACorrectionUnderTheSameIdWithAnotherPayloadIsARefusal(): void
    {
        $token = $this->tokenFor(self::ADMIN);
        $record = [
            'id' => '99999999-9999-4999-8999-999999999902',
            'product_id' => self::WATER,
            'qty_delta' => -5,
            'reason' => 'Breakage',
            'payload_hash' => str_repeat('b', 64),
        ];
        $this->call('POST', '/api/v1/stock-adjustments', $token, $record);

        $other = $this->call('POST', '/api/v1/stock-adjustments', $token, [
            'qty_delta' => -50,
            'payload_hash' => str_repeat('c', 64),
        ] + $record);

        self::assertSame(409, $this->httpStatus());
        self::assertSame('IDEMPOTENCY_CONFLICT', $this->errorCode($other));
        self::assertSame($record['id'], $other['error']['details']['id']);
    }

    public function testCategoriesAreListedCreatedAndDeletedByTheAdmin(): void
    {
        $admin = $this->tokenFor(self::ADMIN);

        $categories = $this->call('GET', '/api/v1/categories', $this->tokenFor(self::WAITER));
        self::assertSame(['Boissons fraîches', 'Boissons chaudes', 'Snacks', 'Pâtisserie'], array_column($categories, 'name'));

        $created = $this->call('POST', '/api/v1/categories', $admin, ['name' => 'Glaces', 'color' => '#22d3ee']);
        self::assertSame(201, $this->httpStatus());
        self::assertSame('Glaces', $created['name']);
        self::assertSame('#22d3ee', $created['color']);

        $this->call('DELETE', '/api/v1/categories/' . $created['id'], $admin);
        self::assertSame(204, $this->httpStatus());

        $after = $this->call('GET', '/api/v1/categories', $admin);
        self::assertCount(4, $after);
    }

    public function testDeletingACategoryThatIsNotThereIsNotFound(): void
    {
        $answer = $this->call('DELETE', '/api/v1/categories/44444444-4444-4444-8444-444444449999', $this->tokenFor(self::ADMIN));

        self::assertSame(404, $this->httpStatus());
        self::assertSame('NOT_FOUND', $this->errorCode($answer));
    }

    public function testAProductWithoutAPriceIsRefusedWithTheFieldNamed(): void
    {
        $answer = $this->call('POST', '/api/v1/products', $this->tokenFor(self::ADMIN), [
            'name' => 'Sans prix',
            'category_id' => null,
            'barcode' => '',
            'description' => '',
            'image_url' => '',
            'is_available' => true,
            'track_stock' => false,
            'opening_stock' => 0,
        ]);

        self::assertSame(422, $this->httpStatus());
        self::assertSame('VALIDATION_ERROR', $this->errorCode($answer));
        self::assertSame('price_millimes', $answer['error']['details']['field']);
    }

    private function find(array $products, string $id): array
    {
        foreach ($products as $product) {
            if ($product['id'] === $id) {
                return $product;
            }
        }

        self::fail("No product {$id} in the answer.");
    }
}
