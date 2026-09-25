<?php

declare(strict_types=1);

namespace App\Controller;

use App\Api\ApiError;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/**
 * The register: the device that prints receipts, and the drawer it counts at the end of a shift.
 *
 * Registering a terminal hands the device the receipt counter it continues from, and bumps the
 * terminal's epoch so that a device registered earlier is told to register again rather than printing
 * a number twice. The opening and the closing of a session are records the terminal wrote, possibly
 * with no signal, and go to their functions as written.
 */
final readonly class RegisterController extends ApiController
{
    #[Route('/api/v1/terminals/{terminalCode}/registrations', methods: ['POST'])]
    public function register(string $terminalCode): JsonResponse
    {
        // The code is the address, and register_terminal says what a code may be.
        return new JsonResponse(
            $this->cafe->json('select public.register_terminal(?)', [$terminalCode]),
            Response::HTTP_CREATED,
        );
    }

    /** The sessions of one terminal, newest first. `status=open` answers with at most one. */
    #[Route('/api/v1/cash-sessions', methods: ['GET'])]
    public function sessions(Request $request): JsonResponse
    {
        $status = (string) $request->query->get('status', '');
        $drawer = match ($status) {
            '' => '',
            'open' => 'and cs.closed_at is null',
            'closed' => 'and cs.closed_at is not null',
            default => throw ApiError::field('status', 'status is open or closed.'),
        };

        return $this->answer(<<<SQL
            select coalesce(json_agg(private.session_json(cs) order by cs.opened_at desc, cs.id desc), '[]'::json)
            from public.cash_sessions cs
            where cs.terminal_id = cast(? as uuid) {$drawer}
            SQL, [$this->id($request, 'terminal_id')]);
    }

    #[Route('/api/v1/cash-sessions', methods: ['POST'])]
    public function openSession(Request $request): JsonResponse
    {
        return $this->written($this->cafe->call('open_session', Json::body($request)));
    }

    #[Route('/api/v1/cash-sessions/{sessionId}/closures', methods: ['POST'])]
    public function closeSession(string $sessionId, Request $request): JsonResponse
    {
        $record = Json::body($request);
        $this->mustBeAbout('session_id', $sessionId, $record);

        return $this->written($this->cafe->call('close_session', $record));
    }

    /** The stored report of a closed session, or the running one of a session still open. */
    #[Route('/api/v1/cash-sessions/{sessionId}/z-report', methods: ['GET'])]
    public function zReport(string $sessionId): JsonResponse
    {
        // The function answers NOT_FOUND itself for a session this café does not have.
        return new JsonResponse($this->cafe->json(
            'select public.z_report(cast(? as uuid))',
            [Json::uuid($sessionId, 'session_id')],
        ));
    }
}
