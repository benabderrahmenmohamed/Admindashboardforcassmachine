<?php

declare(strict_types=1);

namespace App\Tests;

use Doctrine\DBAL\Connection;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;

/** The kernel boots and the test database answers: everything else is built on these two. */
final class SmokeTest extends KernelTestCase
{
    public function testTheKernelBootsAndItsDatabaseAnswers(): void
    {
        self::bootKernel();

        $connection = self::getContainer()->get(Connection::class);

        self::assertSame(1, (int) $connection->fetchOne('select 1'));
        self::assertSame('cafe_test', $connection->fetchOne('select current_database()'));
    }
}
