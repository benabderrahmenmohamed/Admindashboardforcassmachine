<?php

declare(strict_types=1);

namespace App\Tests\Api;

use App\Tests\Support\CafeSchema;
use Doctrine\DBAL\Connection;
use Symfony\Bundle\FrameworkBundle\KernelBrowser;
use Symfony\Bundle\FrameworkBundle\Test\WebTestCase;

/**
 * A test that talks to the API the way a device does: over HTTP, with a token it had to sign in for,
 * and reading the JSON that comes back. Nothing reaches inside the server.
 */
abstract class ApiTestCase extends WebTestCase
{
    use CafeSchema;

    protected const OWNER = ['owner@demo.local', 'demo-owner-2026'];
    protected const ADMIN = ['admin@demo.local', 'demo-admin-2026'];
    protected const CASHIER = ['cashier@demo.local', 'demo-cashier-2026'];
    protected const WAITER = ['waiter@demo.local', 'demo-waiter-2026'];
    protected const KITCHEN = ['kitchen@demo.local', 'demo-kitchen-2026'];
    protected const OTHER_ADMIN = ['other-admin@demo.local', 'other-admin-2026'];

    protected KernelBrowser $client;
    protected Connection $db;

    protected function setUp(): void
    {
        $this->client = self::createClient();
        // One kernel for the whole test, so the requests and this test share a connection - and
        // therefore the transaction below.
        $this->client->disableReboot();
        $this->applySchemaOnce(self::getContainer()->get('doctrine.dbal.admin_connection'));

        // Every test starts from the seeded café and leaves it exactly as it found it.
        $this->db = self::getContainer()->get('doctrine.dbal.default_connection');
        $this->db->beginTransaction();
    }

    protected function tearDown(): void
    {
        if ($this->db->isTransactionActive()) {
            $this->db->rollBack();
        }

        parent::tearDown();
    }

    protected function admin(): Connection
    {
        return self::getContainer()->get('doctrine.dbal.admin_connection');
    }

    /** Signs in and answers the token, as a device keeps one. */
    protected function tokenFor(array $credentials): string
    {
        [$email, $password] = $credentials;
        $answer = $this->call('POST', '/api/v1/auth/token', null, ['email' => $email, 'password' => $password]);
        self::assertSame(200, $this->client->getResponse()->getStatusCode(), 'signing in should work: ' . json_encode($answer));

        return $answer['access_token'];
    }

    /** @return array<string, mixed>|list<mixed> the JSON body, decoded */
    protected function call(string $method, string $uri, ?string $token = null, ?array $body = null, array $query = []): array
    {
        $headers = ['CONTENT_TYPE' => 'application/json'];
        if (null !== $token) {
            $headers['HTTP_AUTHORIZATION'] = 'Bearer ' . $token;
        }

        // Each request stands on its own, as it does in a café: a refusal from the database rolls
        // back to here and the next request starts clean, rather than poisoning the transaction
        // this test runs inside.
        $this->db->beginTransaction();
        try {
            $this->client->request($method, $uri, $query, server: $headers, content: null === $body ? null : json_encode($body, JSON_THROW_ON_ERROR));
        } finally {
            $this->httpStatus() >= 400 ? $this->db->rollBack() : $this->db->commit();
        }

        $content = $this->client->getResponse()->getContent();

        if (!is_string($content) || '' === $content) {
            return [];
        }

        $decoded = json_decode($content, true);

        return is_array($decoded) ? $decoded : [];
    }

    protected function httpStatus(): int
    {
        return $this->client->getResponse()->getStatusCode();
    }

    /**
     * The last answer as it came, for the endpoints whose answer is not an object: a free table's
     * open order is `null`, and `call()` cannot tell that from an empty body.
     */
    protected function answer(): mixed
    {
        $content = $this->client->getResponse()->getContent();

        return is_string($content) && '' !== $content ? json_decode($content, true) : null;
    }

    /** The code of the error that came back, for a test that expects a refusal. */
    protected function errorCode(array $answer): string
    {
        return $answer['error']['code'] ?? 'no error in the body';
    }
}
