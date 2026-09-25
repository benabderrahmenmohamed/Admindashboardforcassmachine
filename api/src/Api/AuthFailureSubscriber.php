<?php

declare(strict_types=1);

namespace App\Api;

use Lexik\Bundle\JWTAuthenticationBundle\Event\AuthenticationFailureEvent;
use Lexik\Bundle\JWTAuthenticationBundle\Event\JWTExpiredEvent;
use Lexik\Bundle\JWTAuthenticationBundle\Event\JWTInvalidEvent;
use Lexik\Bundle\JWTAuthenticationBundle\Event\JWTNotFoundEvent;
use Lexik\Bundle\JWTAuthenticationBundle\Events;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

/**
 * A missing, expired or forged token is UNAUTHENTICATED in the contract's words, not the bundle's.
 * The difference matters to a device: UNAUTHENTICATED pauses its queue and keeps every record in it,
 * while anything read as a conflict would stop the queue and call for a person.
 */
final readonly class AuthFailureSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            Events::JWT_NOT_FOUND => 'onMissing',
            Events::JWT_INVALID => 'onInvalid',
            Events::JWT_EXPIRED => 'onExpired',
            Events::AUTHENTICATION_FAILURE => 'onFailure',
        ];
    }

    public function onMissing(JWTNotFoundEvent $event): void
    {
        $event->setResponse($this->unauthenticated('This request carries no token.'));
    }

    public function onInvalid(JWTInvalidEvent $event): void
    {
        $event->setResponse($this->unauthenticated('This token was not signed by this café.'));
    }

    public function onExpired(JWTExpiredEvent $event): void
    {
        $event->setResponse($this->unauthenticated('This token has expired. Sign in again.'));
    }

    public function onFailure(AuthenticationFailureEvent $event): void
    {
        $event->setResponse($this->unauthenticated('That e-mail and password do not match a member of any café.'));
    }

    private function unauthenticated(string $message): Response
    {
        return new JsonResponse(ApiError::unauthenticated($message)->toWire(), Response::HTTP_UNAUTHORIZED);
    }
}
