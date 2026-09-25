<?php

declare(strict_types=1);

namespace App\Controller;

use App\Api\ApiError;
use App\Security\Member;
use App\Security\MemberProvider;
use Lexik\Bundle\JWTAuthenticationBundle\Services\JWTTokenManagerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\PasswordHasher\Hasher\UserPasswordHasherInterface;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Core\Exception\AuthenticationException;

/**
 * Signing in: e-mail and password for a token the device keeps. A wrong password and an unknown
 * e-mail answer exactly the same thing, so nobody can learn which e-mails a café uses by guessing.
 */
final class AuthController
{
    public function __construct(
        private readonly MemberProvider $members,
        private readonly UserPasswordHasherInterface $hasher,
        private readonly JWTTokenManagerInterface $tokens,
        #[Autowire('%lexik_jwt_authentication.token_ttl%')]
        private readonly int $ttl,
    ) {
    }

    #[Route('/api/v1/auth/token', methods: ['POST'])]
    public function token(Request $request): JsonResponse
    {
        $body = Json::body($request);
        $email = Json::string($body, 'email');
        $password = Json::string($body, 'password');

        $member = $this->signIn($email, $password);

        return new JsonResponse([
            'access_token' => $this->tokens->create($member),
            'token_type' => 'bearer',
            'expires_in' => $this->ttl,
            'member' => $member->toWire(),
        ]);
    }

    private function signIn(string $email, string $password): Member
    {
        try {
            $member = $this->members->loadUserByIdentifier($email);
        } catch (AuthenticationException) {
            throw ApiError::unauthenticated('That e-mail and password do not match a member of any café.');
        }

        if (!$member instanceof Member || !$this->hasher->isPasswordValid($member, $password)) {
            throw ApiError::unauthenticated('That e-mail and password do not match a member of any café.');
        }

        return $member;
    }
}
