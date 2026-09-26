<?php

declare(strict_types=1);

namespace App\Security;

use Symfony\Component\Security\Core\User\PasswordAuthenticatedUserInterface;
use Symfony\Component\Security\Core\User\UserInterface;

/**
 * Who is signed in: a row of `users` joined to the `profiles` row that says which café they work in
 * and what they may do there.
 *
 * Roles and shop come from that profile on every request, never from the token. The token names the
 * member by e-mail and carries a copy of the roles they had when it was signed, which this server
 * ignores: the firewall loads the member again through App\Security\MemberProvider, so a member whose
 * roles changed this morning gets the new ones on their next call, and nothing a token says about a
 * café or a role is believed.
 */
final readonly class Member implements UserInterface, PasswordAuthenticatedUserInterface
{
    /** @param list<string> $cafeRoles admin, cashier, waiter or kitchen */
    public function __construct(
        public string $userId,
        public string $email,
        public string $shopId,
        public string $displayName,
        public array $cafeRoles,
        private string $passwordHash = '',
    ) {
    }

    public function getUserIdentifier(): string
    {
        return $this->email;
    }

    /** Symfony wants ROLE_ prefixes; the café says admin, cashier, waiter, kitchen. */
    public function getRoles(): array
    {
        return array_map(static fn (string $role): string => 'ROLE_' . strtoupper($role), $this->cafeRoles);
    }

    public function getPassword(): string
    {
        return $this->passwordHash;
    }

    public function eraseCredentials(): void
    {
    }

    /** The member as the contract writes them (`Member` in contracts/openapi.yaml). */
    public function toWire(): array
    {
        return [
            'user_id' => $this->userId,
            'shop_id' => $this->shopId,
            'roles' => $this->cafeRoles,
            'display_name' => $this->displayName,
            'email' => $this->email,
        ];
    }
}
