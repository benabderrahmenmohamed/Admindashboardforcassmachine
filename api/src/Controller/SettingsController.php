<?php

declare(strict_types=1);

namespace App\Controller;

use App\Api\ApiError;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * What the café puts at the bottom of its receipts.
 *
 * Who may change it is the policy's answer, not this controller's: `shop_settings_update` is for
 * admins of the café that owns the row, so a cashier's update touches nothing. Nothing touched is
 * all this server sees, so it then asks what the case actually is - no settings yet, or not an admin.
 */
final readonly class SettingsController extends ApiController
{
    /** The column's default, shown to a café whose settings row was never written. */
    private const UNTIL_A_CAFE_SAYS_OTHERWISE = 'Thank you for your purchase!';

    /** The length the column will take, checked here so it is a named field and not a 500. */
    private const AT_MOST = 500;

    #[Route('/api/v1/shop-settings', methods: ['GET'])]
    public function settings(): JsonResponse
    {
        $footer = $this->cafe->value('select receipt_footer from public.shop_settings');

        return new JsonResponse([
            'receipt_footer' => is_string($footer) ? $footer : self::UNTIL_A_CAFE_SAYS_OTHERWISE,
        ]);
    }

    #[Route('/api/v1/shop-settings', methods: ['PUT'])]
    public function save(Request $request): JsonResponse
    {
        $footer = Json::requiredText(Json::body($request), 'receipt_footer');
        if (mb_strlen($footer) > self::AT_MOST) {
            throw ApiError::field('receipt_footer', sprintf('A receipt footer is at most %d characters.', self::AT_MOST));
        }

        $saved = $this->cafe->value(
            'update public.shop_settings set receipt_footer = ? returning receipt_footer',
            [$footer],
        );

        if (!is_string($saved)) {
            throw null === $this->cafe->value('select 1 from public.shop_settings')
                ? ApiError::notFound('This café has no settings to change yet.')
                : ApiError::forbidden('Only an admin changes what the receipts say.');
        }

        return new JsonResponse(['receipt_footer' => $saved]);
    }
}
