<?php

declare(strict_types=1);

namespace App\Tests\Api;

/**
 * Signing in, and what a request without a token is told. The codes matter more than the words: a
 * device reads UNAUTHENTICATED and pauses its queue rather than giving up on what is in it.
 */
final class AuthTest extends ApiTestCase
{
    public function testAMemberSignsInAndIsToldWhoTheyAre(): void
    {
        $answer = $this->call('POST', '/api/v1/auth/token', null, [
            'email' => 'owner@demo.local',
            'password' => 'demo-owner-2026',
        ]);

        self::assertSame(200, $this->httpStatus());
        self::assertSame('bearer', $answer['token_type']);
        self::assertGreaterThan(0, $answer['expires_in']);
        self::assertNotSame('', $answer['access_token']);
        self::assertSame([
            'user_id' => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
            'shop_id' => '11111111-1111-4111-8111-111111111111',
            'roles' => ['admin', 'cashier'],
            'display_name' => 'Demo Owner',
            'email' => 'owner@demo.local',
        ], $answer['member'], 'the owner holds both roles, as a café owner who also works the counter does');
    }

    public function testAWrongPasswordAndAnUnknownEmailAnswerTheSameThing(): void
    {
        $wrongPassword = $this->call('POST', '/api/v1/auth/token', null, [
            'email' => 'owner@demo.local',
            'password' => 'not-the-password',
        ]);
        $refusedStatus = $this->httpStatus();
        $refusedCode = $this->errorCode($wrongPassword);

        $unknown = $this->call('POST', '/api/v1/auth/token', null, [
            'email' => 'nobody@demo.local',
            'password' => 'not-the-password',
        ]);

        self::assertSame(401, $refusedStatus);
        self::assertSame('UNAUTHENTICATED', $refusedCode);
        self::assertSame(401, $this->httpStatus());
        self::assertSame('UNAUTHENTICATED', $this->errorCode($unknown));
        self::assertSame(
            $wrongPassword['error']['message'],
            $unknown['error']['message'],
            'a stranger must not learn which e-mails the café uses',
        );
    }

    public function testSigningInNeedsBothFields(): void
    {
        $answer = $this->call('POST', '/api/v1/auth/token', null, ['email' => 'owner@demo.local']);

        self::assertSame(422, $this->httpStatus());
        self::assertSame('VALIDATION_ERROR', $this->errorCode($answer));
        self::assertSame('password', $answer['error']['details']['field']);
    }

    public function testATokenSaysWhoItBelongsTo(): void
    {
        $token = $this->tokenFor(self::WAITER);

        $me = $this->call('GET', '/api/v1/me', $token);

        self::assertSame(200, $this->httpStatus());
        self::assertSame('Demo Waiter', $me['display_name']);
        self::assertSame(['waiter'], $me['roles']);
    }

    public function testWithoutATokenTheApiSaysSoInTheContractsWords(): void
    {
        $answer = $this->call('GET', '/api/v1/me');

        self::assertSame(401, $this->httpStatus());
        self::assertSame('UNAUTHENTICATED', $this->errorCode($answer));
    }

    public function testATokenThatWasNotSignedHereIsNoToken(): void
    {
        $answer = $this->call('GET', '/api/v1/me', 'not.a.token');

        self::assertSame(401, $this->httpStatus());
        self::assertSame('UNAUTHENTICATED', $this->errorCode($answer));
    }
}
