<?php

declare(strict_types=1);

namespace App\Api;

use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\KernelEvents;
use Symfony\Component\Security\Core\Exception\AccessDeniedException;
use Symfony\Component\Security\Core\Exception\AuthenticationException;
use Symfony\Bundle\SecurityBundle\Security;

/**
 * Every failure under /api leaves as the contract's shape: `{ error: { code, message, details } }`.
 * A client reads the code and decides: retry, pause its queue, or stop and show a person.
 *
 * What is not one of ours is classified by its status, exactly as contracts/errors.md says a client
 * classifies a response with no code in it, and a 5xx is logged with its cause.
 */
final readonly class ErrorSubscriber implements EventSubscriberInterface
{
    private const BY_STATUS = [
        401 => 'UNAUTHENTICATED',
        403 => 'FORBIDDEN',
        404 => 'NOT_FOUND',
        405 => 'VALIDATION_ERROR',
        409 => 'VALIDATION_ERROR',
        415 => 'VALIDATION_ERROR',
        422 => 'VALIDATION_ERROR',
        429 => 'RATE_LIMITED',
    ];

    public function __construct(
        private LoggerInterface $logger,
        private Security $security,
    ) {
    }

    public static function getSubscribedEvents(): array
    {
        return [KernelEvents::EXCEPTION => ['onException', 64]];
    }

    public function onException(ExceptionEvent $event): void
    {
        if (!str_starts_with($event->getRequest()->getPathInfo(), '/api/')) {
            return;
        }

        $error = $this->asApiError($event->getThrowable());
        $status = $error->statusCode();

        if ($status >= 500) {
            $this->logger->error('The API answered {code}: {message}', [
                'code' => $error->errorCode,
                'message' => $error->getMessage(),
                'exception' => $event->getThrowable(),
            ]);
        }

        $event->setResponse(new JsonResponse($error->toWire(), $status));
    }

    private function asApiError(\Throwable $thrown): ApiError
    {
        if ($thrown instanceof ApiError) {
            return $thrown;
        }

        // The firewall's two refusals, in the contract's words rather than the framework's: no
        // token at all is UNAUTHENTICATED, a token whose member may not be here is FORBIDDEN.
        if ($thrown instanceof AuthenticationException) {
            return ApiError::unauthenticated('This request carries no member the café knows.');
        }

        if ($thrown instanceof AccessDeniedException) {
            // Nobody signed in is not a refusal of the member: it is the absence of one, and a
            // device reads that as "pause the queue" rather than "stop and fetch a person".
            return null === $this->security->getUser()
                ? ApiError::unauthenticated('This request carries no member the café knows.')
                : ApiError::forbidden('Your role cannot do this.');
        }

        $raised = DatabaseErrors::raised($thrown);
        if (null !== $raised) {
            return $raised;
        }

        if ($thrown instanceof HttpExceptionInterface) {
            $status = $thrown->getStatusCode();

            return new ApiError(
                self::BY_STATUS[$status] ?? ($status >= 500 ? 'SERVER_ERROR' : 'VALIDATION_ERROR'),
                $thrown->getMessage(),
                [],
                $status,
                $thrown,
            );
        }

        return new ApiError('SERVER_ERROR', 'Something went wrong in the café server.', [], 500, $thrown);
    }
}
