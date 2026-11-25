<?php

declare(strict_types=1);

namespace Marram\Tests;

use GuzzleHttp\Psr7\HttpFactory;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Marram\Client;
use Marram\ConnectFlow;
use Marram\FlowInputException;
use Marram\MarramException;
use Marram\SignInFlow;

final class FlowTest extends TestCase
{
    private const INIT = ['flowId' => 'flow_1', 'authorizationUrl' => 'https://provider.test/consent'];
    private const CONNECTION = ['externalUserId' => 'u1', 'providerKey' => 'google', 'status' => 'active'];
    private const START_INPUT = ['provider' => 'google', 'codeChallenge' => 'challenge', 'codeChallengeMethod' => 'S256'];
    private const FINISH_INPUT = ['provider' => 'google', 'flowId' => 'flow_1', 'codeVerifier' => 'verifier', 'claimCode' => 'cc_1'];

    private static function client(FakeHttpClient $http): Client
    {
        $factory = new HttpFactory();

        return new Client('sk_test', 'staging', httpClient: $http, requestFactory: $factory, streamFactory: $factory);
    }

    private static function connect(FakeHttpClient $http): ConnectFlow
    {
        return new ConnectFlow(
            self::client($http),
            ['google' => [], 'trello' => ['integrationKey' => 'primary', 'auth' => 'oAuth1']],
            'https://app.test/connected',
        );
    }

    public function testStartInitsTheProviderAndAnswersWhatTheBrowserExpects(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, self::INIT));

        $started = self::connect($http)->start(self::START_INPUT, externalUserId: 'u1');

        self::assertSame(['provider' => 'google', ...self::INIT], $started);
        $request = $http->requests[0];
        self::assertSame('https://api-staging.marram.dev/v1/connections/google/init', (string) $request->getUri());
        self::assertSame([
            'auth' => 'oAuth2',
            'redirectUrl' => 'https://app.test/connected',
            'codeChallenge' => 'challenge',
            'codeChallengeMethod' => 'S256',
            'externalUserId' => 'u1',
        ], $http->body(0));
        self::assertFalse($request->hasHeader('x-marram-integration-key'));
    }

    public function testStartAppliesPerProviderOptionsAndARedirectUrlFunction(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, self::INIT));
        $flow = new ConnectFlow(
            self::client($http),
            ['trello' => ['integrationKey' => 'primary', 'auth' => 'oAuth1']],
            fn (string $provider): string => "https://app.test/connected/{$provider}",
            theme: 'dark',
        );

        $flow->start(['provider' => 'trello'] + self::START_INPUT, externalUserId: 'u1');

        $body = $http->body(0);
        self::assertSame('primary', $http->requests[0]->getHeaderLine('x-marram-integration-key'));
        self::assertSame('oAuth1', $body['auth']);
        self::assertSame('https://app.test/connected/trello', $body['redirectUrl']);
        self::assertSame('dark', $body['theme']);
        self::assertSame('u1', $body['externalUserId']);
    }

    public function testStartRefusesAConnectionWithoutAnExternalUserId(): void
    {
        $http = new FakeHttpClient();
        try {
            self::connect($http)->start(self::START_INPUT);
            self::fail('expected FlowInputException');
        } catch (FlowInputException $e) {
            self::assertSame('INVALID_INPUT', $e->errorCode);
        }
        self::assertSame([], $http->requests);
    }

    public function testListsItsProviders(): void
    {
        self::assertSame(['google', 'trello'], self::connect(new FakeHttpClient())->providers());
        self::assertSame(['a', 'b'], (new ConnectFlow(self::client(new FakeHttpClient()), ['a', 'b'], 'https://x'))->providers());

        $this->expectException(\InvalidArgumentException::class);
        new ConnectFlow(self::client(new FakeHttpClient()), [], 'https://x');
    }

    public function testStartRefusesAProviderOutsideTheAllowlistWithoutCallingMarram(): void
    {
        $http = new FakeHttpClient();
        try {
            self::connect($http)->start(['provider' => 'github'] + self::START_INPUT);
            self::fail('expected FlowInputException');
        } catch (FlowInputException $e) {
            self::assertSame('UNKNOWN_PROVIDER', $e->errorCode);
            self::assertSame(400, $e->status);
        }
        self::assertSame([], $http->requests);
    }

    /** @return iterable<string, array{mixed}> */
    public static function badStartInput(): iterable
    {
        yield 'empty challenge' => [['codeChallenge' => ''] + self::START_INPUT];
        yield 'plain method' => [['codeChallengeMethod' => 'plain'] + self::START_INPUT];
        yield 'not an object' => ['nope'];
        yield 'null' => [null];
        yield 'list' => [['google']];
    }

    #[DataProvider('badStartInput')]
    public function testStartRefusesBadInput(mixed $input): void
    {
        $this->expectException(FlowInputException::class);
        self::connect(new FakeHttpClient())->start($input);
    }

    public function testFinishClaimsWithTheFlowIdAndVerifierInTheBody(): void
    {
        $http = new FakeHttpClient(FakeHttpClient::json(200, ['connection' => self::CONNECTION, 'jti' => null]));

        $claimed = self::connect($http)->finish(self::FINISH_INPUT);

        self::assertSame(['provider' => 'google', 'flowId' => 'flow_1', 'connection' => self::CONNECTION], $claimed);
        $request = $http->requests[0];
        self::assertSame('https://api-staging.marram.dev/v1/connections/google/claim', (string) $request->getUri());
        self::assertSame(['flowId' => 'flow_1', 'codeVerifier' => 'verifier', 'claimCode' => 'cc_1'], $http->body(0));
    }

    public function testFinishNeedsTheProviderKeyAndVerifier(): void
    {
        $flow = self::connect(new FakeHttpClient());
        foreach ([
            ['provider' => 'github'] + self::FINISH_INPUT,
            ['flowId' => null] + self::FINISH_INPUT,
            ['codeVerifier' => 7] + self::FINISH_INPUT,
            ['claimCode' => null] + self::FINISH_INPUT,
        ] as $input) {
            try {
                $flow->finish($input);
                self::fail('expected FlowInputException');
            } catch (FlowInputException $e) {
                self::assertSame(400, $e->status);
            }
        }
    }

    public function testSignInFlowStartsAndClaimsSessions(): void
    {
        $http = new FakeHttpClient(
            FakeHttpClient::json(200, ['sessionKey' => 'sk_1', 'authorizationUrl' => 'https://provider.test/consent']),
            FakeHttpClient::json(200, ['user' => ['email' => 'a@b.c'], 'raw' => ['sub' => '1']]),
        );
        $flow = new SignInFlow(self::client($http), ['google'], 'https://app.test/signed-in');

        self::assertSame(
            ['provider' => 'google', 'sessionKey' => 'sk_1', 'authorizationUrl' => 'https://provider.test/consent'],
            $flow->start(self::START_INPUT),
        );
        self::assertSame('https://api-staging.marram.dev/v1/auth/google/init', (string) $http->requests[0]->getUri());
        self::assertSame('oAuth2', $http->body(0)['auth']);

        self::assertSame(
            ['provider' => 'google', 'sessionKey' => 'sk_1', 'user' => ['email' => 'a@b.c'], 'raw' => ['sub' => '1']],
            $flow->finish(['provider' => 'google', 'sessionKey' => 'sk_1', 'codeVerifier' => 'verifier', 'claimCode' => 'cc_2']),
        );
        self::assertSame('sk_1', $http->requests[1]->getHeaderLine('x-marram-session-key'));

        $this->expectException(FlowInputException::class);
        $this->expectExceptionMessage('sessionKey');
        $flow->finish(self::FINISH_INPUT);
    }

    public function testReplyStartAnswers200OrAStatusAndCodeForKnownFailures(): void
    {
        $ok = self::connect(new FakeHttpClient(FakeHttpClient::json(200, self::INIT)));
        self::assertSame(
            ['status' => 200, 'body' => ['provider' => 'google', ...self::INIT]],
            $ok->replyStart(self::START_INPUT, externalUserId: 'u1'),
        );

        $bad = self::connect(new FakeHttpClient())->replyStart(['provider' => 'github'] + self::START_INPUT);
        self::assertSame(['status' => 400, 'body' => ['code' => 'UNKNOWN_PROVIDER', 'error' => 'provider is not one this flow allows.']], $bad);

        $upstream = self::connect(new FakeHttpClient(FakeHttpClient::json(401, ['code' => 'INVALID_API_KEY', 'error' => 'Bad key'], ['x-marram-request-id' => 'req_1'])));
        self::assertSame(
            ['status' => 502, 'body' => ['code' => 'INVALID_API_KEY', 'error' => 'Bad key', 'requestId' => 'req_1']],
            $upstream->replyStart(self::START_INPUT, externalUserId: 'u1'),
        );
    }

    public function testReplyFinishAnswersYourJsonOrOkAndPassesRefusedClaimsAs400(): void
    {
        $saved = [];
        $flow = self::connect(new FakeHttpClient(FakeHttpClient::json(200, ['connection' => self::CONNECTION])));
        $reply = $flow->replyFinish(self::FINISH_INPUT, function (array $claimed) use (&$saved): array {
            $saved[] = $claimed['connection']['externalUserId'];

            return ['connected' => true];
        });
        self::assertSame(['status' => 200, 'body' => ['connected' => true]], $reply);
        self::assertSame(['u1'], $saved);

        $flow = self::connect(new FakeHttpClient(FakeHttpClient::json(200, ['connection' => self::CONNECTION])));
        self::assertSame(['status' => 200, 'body' => ['ok' => true]], $flow->replyFinish(self::FINISH_INPUT, fn () => null));

        $flow = self::connect(new FakeHttpClient(FakeHttpClient::json(404, ['code' => 'CONNECTION_NOT_FOUND', 'error' => 'Gone'])));
        self::assertSame(
            ['status' => 400, 'body' => ['code' => 'CONNECTION_NOT_FOUND', 'error' => 'Gone', 'requestId' => null]],
            $flow->replyFinish(self::FINISH_INPUT, fn () => ['connected' => true]),
        );
    }

    public function testReplyRethrowsAnythingElse(): void
    {
        $flow = self::connect(new FakeHttpClient(FakeHttpClient::json(200, ['connection' => self::CONNECTION])));
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('db down');
        $flow->replyFinish(self::FINISH_INPUT, fn () => throw new \RuntimeException('db down'));
    }

    public function testMarramExceptionsFromStartPassThroughStart(): void
    {
        $flow = self::connect(new FakeHttpClient(FakeHttpClient::json(400, ['code' => 'CODE_VERIFIER_MISMATCH', 'error' => 'Mismatch'])));
        try {
            $flow->finish(self::FINISH_INPUT);
            self::fail('expected MarramException');
        } catch (MarramException $e) {
            self::assertSame('CODE_VERIFIER_MISMATCH', $e->errorCode);
        }
    }

    public function testServeReadsRawInputAndEchoesJson(): void
    {
        $flow = self::connect(new FakeHttpClient(FakeHttpClient::json(200, self::INIT)));

        ob_start();
        try {
            $flow->serveStart('u1', json_encode(self::START_INPUT, JSON_THROW_ON_ERROR));
        } finally {
            $out = ob_get_clean();
        }
        self::assertSame(['provider' => 'google', ...self::INIT], json_decode((string) $out, true));

        ob_start();
        try {
            $flow->serveFinish(fn () => ['connected' => true], 'not json');
        } finally {
            $out = ob_get_clean();
        }
        self::assertSame(['code' => 'INVALID_INPUT', 'error' => 'Send a JSON object.'], json_decode((string) $out, true));
    }
}
