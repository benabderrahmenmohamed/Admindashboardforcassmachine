<?php

declare(strict_types=1);

namespace App\Tests\Api;

/** What the café prints at the bottom of its receipts: everyone reads it, the admin changes it. */
final class SettingsTest extends ApiTestCase
{
    public function testTheFooterIsReadByTheFloorAndChangedByTheAdmin(): void
    {
        self::assertSame(
            ['receipt_footer' => 'Merci pour votre visite !'],
            $this->call('GET', '/api/v1/shop-settings', $this->tokenFor(self::WAITER)),
        );

        $refused = $this->call('PUT', '/api/v1/shop-settings', $this->tokenFor(self::CASHIER), [
            'receipt_footer' => 'À bientôt !',
        ]);
        self::assertSame(403, $this->httpStatus());
        self::assertSame('FORBIDDEN', $this->errorCode($refused));

        $saved = $this->call('PUT', '/api/v1/shop-settings', $this->tokenFor(self::ADMIN), [
            'receipt_footer' => 'À bientôt !',
        ]);
        self::assertSame(200, $this->httpStatus());
        self::assertSame(['receipt_footer' => 'À bientôt !'], $saved);
        self::assertSame($saved, $this->call('GET', '/api/v1/shop-settings', $this->tokenFor(self::KITCHEN)));
    }

    public function testAnotherCafeReadsItsOwnFooter(): void
    {
        self::assertSame(
            ['receipt_footer' => 'Thank you for your purchase!'],
            $this->call('GET', '/api/v1/shop-settings', $this->tokenFor(self::OTHER_ADMIN)),
        );
    }

    public function testAFooterLongerThanTheColumnIsRefusedWithTheFieldNamed(): void
    {
        $answer = $this->call('PUT', '/api/v1/shop-settings', $this->tokenFor(self::ADMIN), [
            'receipt_footer' => str_repeat('a', 501),
        ]);

        self::assertSame(422, $this->httpStatus());
        self::assertSame('VALIDATION_ERROR', $this->errorCode($answer));
        self::assertSame('receipt_footer', $answer['error']['details']['field']);
    }

    public function testAFormThatSendsNothingHasNotClearedTheFooter(): void
    {
        $answer = $this->call('PUT', '/api/v1/shop-settings', $this->tokenFor(self::ADMIN), ['footer' => 'Oops']);

        self::assertSame(422, $this->httpStatus());
        self::assertSame('receipt_footer', $answer['error']['details']['field']);
        self::assertSame(
            ['receipt_footer' => 'Merci pour votre visite !'],
            $this->call('GET', '/api/v1/shop-settings', $this->tokenFor(self::ADMIN)),
        );
    }

    public function testAnEmptyFooterIsAChoiceAndIsKept(): void
    {
        $saved = $this->call('PUT', '/api/v1/shop-settings', $this->tokenFor(self::ADMIN), ['receipt_footer' => '']);

        self::assertSame(200, $this->httpStatus());
        self::assertSame(['receipt_footer' => ''], $saved);
    }
}
