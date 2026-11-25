<?php

declare(strict_types=1);

namespace Marram\Tests;

use GuzzleHttp\Psr7\HttpFactory;
use PHPUnit\Framework\TestCase;
use Marram\Client;
use Marram\ConnectionRedirect;
use Marram\Pkce;
use Marram\MarramException;

final class ClientTest extends TestCase
{
    private static function client(FakeHttpClient $http): Client
    {
        $factory = new HttpFactory();

        return new Client('sk_test_01ENV', 'staging', httpClient: $http, requestFactory: $factory, streamFactory: $factory);
    }

    /** @return array<string, mixed> */
    private static function connection(): array
    {
        return [
            'externalUserId' => 'user-1',
            'providerKey' => 'google',
            'integrationKey' => 'primary',
            'authType' => 'oAuth2',
            'status' => 'active',
            'createdAt' => '2026-10-21T00:00:00Z',
            'updatedAt' => '2026-10-21T00:00:00Z',
        ];
    }

    public function testRequiresAnApiKey(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Client('  ', httpClient: new FakeHttpClient(), requestFactory: new HttpFactory(), streamFactory: new HttpFactory());
    }

    public function testRejectsAnUnknownEnvironment(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Client('k', 'prod', httpClient: new FakeHttpClient(), requestFactory: new HttpFactory(), streamFactory: new HttpFactory());
    }

    public function testFindsAnInstalledHttpClientWhenNoneIsPassed(): void
    {
        // Guzzle is a dev dependency here, so discovery has something to find.
        self::assertSame('https://api.marram.dev/v1', (new Client('k'))->baseUrl);
        self::assertSame('http://localhost:8787/v1', (new Client('k', baseUrl: 'http://localhost:8787/v1/'))->baseUrl);
    }

    public function testConnectionsInitPostsTheBodyWithApiKeyAndIntegrationKey(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, ['flowId' => 'flow_1', 'authorizationUrl' => 'https://provider/auth']));

        $body = ['auth' => 'oAuth2', 'redirectUrl' => 'https://app.test/back', 'codeChallenge' => 'challenge', 'codeChallengeMethod' => 'S256', 'externalUserId' => 'user-1'];
        $result = self::client($http)->connections->init('google-calendar', $body, integrationKey: 'primary');

        self::assertSame(['flowId' => 'flow_1', 'authorizationUrl' => 'https://provider/auth'], $result);
        $request = $http->requests[0];
        self::assertSame('POST', $request->getMethod());
        self::assertSame('https://api-staging.marram.dev/v1/connections/google-calendar/init', (string) $request->getUri());
        self::assertSame('Bearer sk_test_01ENV', $request->getHeaderLine('Authorization'));
        self::assertSame('primary', $request->getHeaderLine('x-marram-integration-key'));
        self::assertSame('application/json', $request->getHeaderLine('Content-Type'));
        self::assertSame($body, $http->body(0));
    }

    public function testConnectionsClaimSendsTheFlowIdAndVerifierInTheBody(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, ['connection' => self::connection(), 'jti' => null]));

        self::assertSame(self::connection(), self::client($http)->connections->claim('google', 'flow_1', 'verifier', 'cc_1'));
        $request = $http->requests[0];
        self::assertSame('POST', $request->getMethod());
        self::assertSame('https://api-staging.marram.dev/v1/connections/google/claim', (string) $request->getUri());
        self::assertSame(['flowId' => 'flow_1', 'codeVerifier' => 'verifier', 'claimCode' => 'cc_1'], $http->body(0));
    }

    public function testConnectionsClaimSurfacesAVerifierMismatch(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(
            403,
            ['error' => "The codeVerifier doesn't match.", 'code' => 'CODE_VERIFIER_MISMATCH'],
            ['x-marram-error-code' => 'CODE_VERIFIER_MISMATCH'],
        ));

        try {
            self::client($http)->connections->claim('google', 'flow_1', 'wrong', 'cc_1');
            self::fail('expected MarramException');
        } catch (MarramException $error) {
            self::assertSame('CODE_VERIFIER_MISMATCH', $error->errorCode);
            self::assertSame(403, $error->status);
        }
    }

    public function testOmitsHeadersThatWereNotGiven(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, ['flowId' => 'f', 'authorizationUrl' => 'u']));
        self::client($http)->connections->init('google', ['auth' => 'oAuth2', 'redirectUrl' => 'https://x.test', 'codeChallenge' => 'c', 'codeChallengeMethod' => 'S256', 'externalUserId' => 'user-1']);

        self::assertFalse($http->requests[0]->hasHeader('x-marram-integration-key'));
    }

    public function testKeysTravelInHeadersNeverTheBody(): void
    {
        $session = [...self::connection(), 'sessionKey' => 'sk'];
        $http = new FakeHttpClient(
            FakeHttpClient::json(200, ['connection' => self::connection()]),
            FakeHttpClient::json(200, ['revoked' => true]),
            FakeHttpClient::json(200, ['session' => $session]),
        );
        $marram = self::client($http);

        self::assertSame(self::connection(), $marram->connections->refresh('google', 'user-1'));
        $marram->connections->revoke('google', 'user-1');
        $marram->sessions->refresh('google', 'sk');

        self::assertStringEndsWith('/connections/google/refresh', (string) $http->requests[0]->getUri());
        self::assertSame('user-1', $http->requests[0]->getHeaderLine('x-marram-external-user-id'));
        self::assertNull($http->body(0));
        self::assertSame('DELETE', $http->requests[1]->getMethod());
        self::assertSame('user-1', $http->requests[1]->getHeaderLine('x-marram-external-user-id'));
        self::assertStringEndsWith('/auth/google/refresh', (string) $http->requests[2]->getUri());
        self::assertSame('sk', $http->requests[2]->getHeaderLine('x-marram-session-key'));
    }

    public function testGetReadsOneRecordByItsHeader(): void
    {
        $session = [...self::connection(), 'sessionKey' => 'sk'];
        $http = new FakeHttpClient(
            FakeHttpClient::json(200, ['connection' => self::connection()]),
            FakeHttpClient::json(200, ['session' => $session]),
        );
        $marram = self::client($http);

        self::assertSame(self::connection(), $marram->connections->get('google', 'user-1', 'primary'));
        self::assertSame($session, $marram->sessions->get('google', 'sk'));

        self::assertSame('GET', $http->requests[0]->getMethod());
        self::assertStringEndsWith('/connections/google/connection', (string) $http->requests[0]->getUri());
        self::assertSame('user-1', $http->requests[0]->getHeaderLine('x-marram-external-user-id'));
        self::assertSame('primary', $http->requests[0]->getHeaderLine('x-marram-integration-key'));
        self::assertSame('GET', $http->requests[1]->getMethod());
        self::assertStringEndsWith('/auth/google/session', (string) $http->requests[1]->getUri());
        self::assertSame('sk', $http->requests[1]->getHeaderLine('x-marram-session-key'));
    }

    public function testClaimSendsTheSessionKeyAsAHeaderAndTheVerifierInTheBody(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, ['user' => ['email' => 'a@b.test'], 'raw' => new \stdClass()]));
        $user = self::client($http)->sessions->claim('google', 'sk', 'verifier', 'cc_2');

        self::assertSame(['email' => 'a@b.test'], $user['user']);
        self::assertSame('sk', $http->requests[0]->getHeaderLine('x-marram-session-key'));
        self::assertSame(['codeVerifier' => 'verifier', 'claimCode' => 'cc_2'], $http->body(0));
    }

    public function testWebhookRegisterSendsAnObjectBodyEvenWhenEmpty(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, ['success' => true, 'webhookKey' => 'wk']));
        self::client($http)->webhooks->register('asana', 'user-1', kind: 'tasks', metadata: 'm');

        self::assertSame('{}', (string) $http->requests[0]->getBody());
        self::assertSame('tasks', $http->requests[0]->getHeaderLine('x-marram-webhook-kind'));
        self::assertSame('m', $http->requests[0]->getHeaderLine('x-marram-metadata'));
    }

    public function testEncodesPathSegmentsSoAKeyCannotChangeTheRoute(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, [
            'webhook' => ['webhookKey' => 'a/b', 'status' => 'active', 'createdAt' => 'x', 'updatedAt' => 'x'],
        ]));
        self::client($http)->webhooks->get('trello', 'a/b', 'user-1');

        self::assertSame('https://api-staging.marram.dev/v1/webhooks/trello/a%2Fb', (string) $http->requests[0]->getUri());
    }

    public function testTurnsAMarramErrorIntoAnExceptionWithCodeAndRequestId(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(
            401,
            ['error' => 'Your API key has expired.', 'code' => 'API_KEY_EXPIRED'],
            ['x-marram-error-code' => 'API_KEY_EXPIRED', 'x-marram-request-id' => 'req_1'],
        ));

        try {
            self::client($http)->environment->integrations();
            self::fail('expected MarramException');
        } catch (MarramException $error) {
            self::assertSame('API_KEY_EXPIRED', $error->errorCode);
            self::assertSame(401, $error->status);
            self::assertSame('req_1', $error->requestId);
        }
    }

    public function testProxyRelaysAProviderErrorInsteadOfThrowing(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(404, ['error' => 'board not found']));
        $response = self::client($http)->proxy->request(
            'GET',
            'trello',
            '/1/boards/abc',
            'user-1',
            query: ['fields' => 'name'],
            headers: ['Accept' => 'application/json'],
            version: '1',
        );

        self::assertSame(404, $response->getStatusCode());
        self::assertSame('{"error":"board not found"}', (string) $response->getBody());
        $request = $http->requests[0];
        self::assertSame('https://api-staging.marram.dev/v1/proxy/trello/1/boards/abc?fields=name', (string) $request->getUri());
        self::assertSame('application/json', $request->getHeaderLine('Accept'));
        self::assertSame('1', $request->getHeaderLine('x-marram-version'));
    }

    public function testProxyThrowsOnMarramsOwnRefusal(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(
            404,
            ['error' => 'No such connection.', 'code' => 'CONNECTION_NOT_FOUND'],
            ['x-marram-error-code' => 'CONNECTION_NOT_FOUND'],
        ));

        $this->expectException(MarramException::class);
        self::client($http)->proxy->request('GET', 'trello', '1/boards/abc', 'user-1');
    }

    public function testProxyDropsCallerMarramHeadersWhateverTheirCase(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, []));
        self::client($http)->proxy->request('GET', 'trello', '1/me', 'right', headers: [
            'X-Marram-External-User-Id' => 'wrong',
            'X-Marram-Callback-Url' => 'https://evil.test',
            'Accept' => 'application/json',
        ]);

        $request = $http->requests[0];
        self::assertSame('right', $request->getHeaderLine('x-marram-external-user-id'));
        self::assertFalse($request->hasHeader('x-marram-callback-url'));
        self::assertSame('application/json', $request->getHeaderLine('Accept'));
    }

    public function testEnqueueSendsTheCallbackUrlAndReturnsTheRequestId(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(202, ['requestId' => 'req_9']));
        $result = self::client($http)->proxy->enqueue('POST', 'trello', '1/boards', 'user-1', 'https://app.test/callback', body: ['name' => 'New']);

        self::assertSame(['requestId' => 'req_9'], $result);
        self::assertSame('https://app.test/callback', $http->requests[0]->getHeaderLine('x-marram-callback-url'));
        self::assertSame(['name' => 'New'], $http->body(0));
    }

    public function testProxyRejectsAnEmptyOrTraversingPathBeforeAnyRequest(): void
    {
        $http = new FakeHttpClient();
        $marram = self::client($http);

        foreach (['/', '1/../admin'] as $path) {
            try {
                $marram->proxy->request('GET', 'trello', $path, 'user-1');
                self::fail("expected {$path} to be rejected");
            } catch (\InvalidArgumentException) {
            }
        }
        self::assertCount(0, $http->requests);
    }

    public function testPkceReturnsAnS256ChallengeOfTheVerifier(): void
    {
        $pkce = Pkce::create();

        self::assertSame(
            rtrim(strtr(base64_encode(hash('sha256', $pkce['codeVerifier'], true)), '+/', '-_'), '='),
            $pkce['codeChallenge'],
        );
        self::assertSame('S256', $pkce['codeChallengeMethod']);
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', $pkce['codeVerifier']);
    }

    public function testConnectionRedirectReadsSuccessAndFailure(): void
    {
        $ok = ConnectionRedirect::parse('https://app.test/back?status=connected&claimCode=cc_1');
        self::assertTrue($ok->ok);
        self::assertSame('cc_1', $ok->claimCode);

        // The claim can't run without the code, so a redirect missing it is not a success.
        $noCode = ConnectionRedirect::parse('https://app.test/back?status=connected');
        self::assertFalse($noCode->ok);
        self::assertSame('missing_claim_code', $noCode->error);

        $failed = ConnectionRedirect::parse('https://app.test/back?error=auth_error&error_message=Denied');
        self::assertFalse($failed->ok);
        self::assertSame('auth_error', $failed->error);
        self::assertSame('Denied', $failed->errorMessage);

        $missing = ConnectionRedirect::parse('https://app.test/back');
        self::assertFalse($missing->ok);
        self::assertSame('missing_status', $missing->error);
    }

    public function testConnectTokenMintsAVerifiableHs256Token(): void
    {
        $secret = base64_encode(str_repeat("\x07", 32));
        $factory = new HttpFactory();
        $marram = new Client(
            'sk_' . str_repeat('a', 32) . '_01ORG_01ENV',
            'staging',
            httpClient: new FakeHttpClient(),
            requestFactory: $factory,
            streamFactory: $factory,
            signingSecret: $secret,
        );

        $minted = $marram->connectToken('user-1', provider: 'google', redirectUrl: 'https://app.test/back');

        [$header, $payload, $signature] = explode('.', $minted->token);
        $decode = static fn (string $part): array => (array) json_decode(
            (string) base64_decode(strtr($part, '-_', '+/') . '=='),
            true,
        );

        self::assertSame(['alg' => 'HS256', 'typ' => 'JWT'], $decode($header));

        $claims = $decode($payload);
        self::assertSame('marram', $claims['typ']);
        self::assertSame('connect', $claims['use']);
        self::assertSame('user-1', $claims['sub']);
        self::assertSame('01ENV', $claims['env']);
        self::assertSame('01ORG', $claims['org']);
        self::assertSame('google', $claims['provider']);
        self::assertSame('https://app.test/back', $claims['redirectUrl']);
        self::assertSame($minted->jti, $claims['jti']);
        // The default life is the maximum: the provider step is capped at ten minutes regardless.
        self::assertSame(600, $claims['exp'] - $claims['iat']);
        self::assertSame($minted->expiresAt, $claims['exp']);

        // The worker verifies HMAC-SHA256 with the base64-decoded secret — recompute it here.
        $expected = rtrim(strtr(base64_encode(hash_hmac(
            'sha256',
            "{$header}.{$payload}",
            (string) base64_decode($secret, true),
            true,
        )), '+/', '-_'), '=');
        self::assertSame($expected, $signature);
    }

    public function testConnectTokenRefusesALifeOverTenMinutes(): void
    {
        $factory = new HttpFactory();
        $marram = new Client(
            'sk_' . str_repeat('a', 32) . '_01ORG_01ENV',
            'staging',
            httpClient: new FakeHttpClient(),
            requestFactory: $factory,
            streamFactory: $factory,
            signingSecret: base64_encode(str_repeat("\x07", 32)),
        );

        try {
            $marram->connectToken('user-1', expiresIn: 601);
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $error) {
            self::assertStringContainsString('at most 600 seconds', $error->getMessage());
        }

        $minted = $marram->connectToken('user-1', expiresIn: 600);
        self::assertNotSame('', $minted->token);
    }

    public function testConnectTokenNeedsASigningSecretAndAFullKey(): void
    {
        $factory = new HttpFactory();

        $noSecret = new Client('sk_' . str_repeat('a', 32) . '_01ORG_01ENV', 'staging', httpClient: new FakeHttpClient(), requestFactory: $factory, streamFactory: $factory);
        try {
            $noSecret->connectToken('user-1');
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $error) {
            self::assertStringContainsString('signingSecret', $error->getMessage());
        }

        $secret = base64_encode(str_repeat("\x07", 32));
        $badKey = new Client('sk_short', 'staging', httpClient: new FakeHttpClient(), requestFactory: $factory, streamFactory: $factory, signingSecret: $secret);
        try {
            $badKey->signInToken();
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $error) {
            self::assertStringContainsString('API key', $error->getMessage());
        }

        try {
            \Marram\ConnectToken::mint('connect', '01ORG', '01ENV', $secret);
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $error) {
            self::assertStringContainsString('externalUserId', $error->getMessage());
        }
    }
}
