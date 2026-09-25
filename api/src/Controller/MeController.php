<?php

declare(strict_types=1);

namespace App\Controller;

use App\Db\Cafe;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

/** Who the token belongs to, read fresh: roles and café come from the profile, never from the token. */
final readonly class MeController
{
    public function __construct(private Cafe $cafe)
    {
    }

    #[Route('/api/v1/me', methods: ['GET'])]
    public function me(): JsonResponse
    {
        return new JsonResponse($this->cafe->member()->toWire());
    }
}
