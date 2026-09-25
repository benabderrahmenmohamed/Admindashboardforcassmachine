<?php

declare(strict_types=1);

namespace App\Security;

use Doctrine\DBAL\Connection;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\Security\Core\Exception\UnsupportedUserException;
use Symfony\Component\Security\Core\Exception\UserNotFoundException;
use Symfony\Component\Security\Core\User\PasswordAuthenticatedUserInterface;
use Symfony\Component\Security\Core\User\PasswordUpgraderInterface;
use Symfony\Component\Security\Core\User\UserInterface;
use Symfony\Component\Security\Core\User\UserProviderInterface;

/**
 * Members come from the database, by e-mail when they sign in and by id when a token brings them
 * back. An account without a profile belongs to no café and cannot be loaded at all, which is how
 * the old app's leftover logins stay out.
 *
 * It reads through the owner's connection: row-level security hides every profile from a request
 * that has not said who it is yet, and at sign-in nobody has.
 */
final readonly class MemberProvider implements UserProviderInterface, PasswordUpgraderInterface
{
    private const SELECT = <<<'SQL'
        select u.id, u.email, u.password_hash, p.shop_id, p.display_name, p.roles
        from public.users u
        join public.profiles p on p.user_id = u.id
        SQL;

    public function __construct(
        #[Autowire(service: 'doctrine.dbal.admin_connection')]
        private Connection $db,
    ) {
    }

    public function loadUserByIdentifier(string $identifier): UserInterface
    {
        $row = $this->db->fetchAssociative(self::SELECT . ' where lower(u.email) = lower(?)', [$identifier]);

        return $this->member($row, $identifier);
    }

    public function loadUserById(string $userId): Member
    {
        $row = $this->db->fetchAssociative(self::SELECT . ' where u.id = ?', [$userId]);

        return $this->member($row, $userId);
    }

    public function refreshUser(UserInterface $user): UserInterface
    {
        if (!$user instanceof Member) {
            throw new UnsupportedUserException(sprintf('This provider only knows members, not %s.', $user::class));
        }

        return $this->loadUserById($user->userId);
    }

    public function supportsClass(string $class): bool
    {
        return Member::class === $class;
    }

    public function upgradePassword(PasswordAuthenticatedUserInterface|UserInterface $user, string $newHashedPassword): void
    {
        if ($user instanceof Member) {
            $this->db->executeStatement('update public.users set password_hash = ? where id = ?', [$newHashedPassword, $user->userId]);
        }
    }

    private function member(array|false $row, string $who): Member
    {
        if (false === $row) {
            throw new UserNotFoundException(sprintf('No member of any café is called %s.', $who));
        }

        return new Member(
            userId: (string) $row['id'],
            email: (string) $row['email'],
            shopId: (string) $row['shop_id'],
            displayName: (string) $row['display_name'],
            cafeRoles: $this->roles((string) $row['roles']),
            passwordHash: (string) $row['password_hash'],
        );
    }

    /** Postgres hands a text[] over as `{admin,cashier}`. */
    private function roles(string $array): array
    {
        $inside = trim($array, '{}');

        return '' === $inside ? [] : array_map(
            static fn (string $role): string => trim($role, '"'),
            explode(',', $inside),
        );
    }
}
