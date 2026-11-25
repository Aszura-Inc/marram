<?php

declare(strict_types=1);

namespace Marram;

use Http\Discovery\Psr17FactoryDiscovery;
use Http\Discovery\Psr18ClientDiscovery;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;
use Marram\Resources\Connections;
use Marram\Resources\Environment;
use Marram\Resources\ProviderProxy;
use Marram\Resources\Sessions;
use Marram\Resources\Webhooks;

/**
 * Marram API client. Server-side only, it holds your secret API key.
 * Uses any PSR-18 client; auto-discovered if none is passed.
 */
final class Client
{
    public const BASE_URLS = [
        'production' => 'https://api.marram.dev/v1',
        'staging' => 'https://api-staging.marram.dev/v1',
    ];

    public readonly Connections $connections;
    public readonly Sessions $sessions;
    public readonly Webhooks $webhooks;
    public readonly ProviderProxy $proxy;
    public readonly Environment $environment;
    /** Includes /v1. */
    public readonly string $baseUrl;

    private readonly string $trimmedApiKey;
    private readonly ?string $signingSecret;

    /**
     * @param string      $apiKey
     * @param string      $environment   'production' or 'staging'
     * @param string|null $baseUrl       Overrides $environment. Include /v1.
     * @param string|null $signingSecret Base64 signing secret — needed for connectToken()/signInToken().
     */
    public function __construct(
        string $apiKey,
        string $environment = 'production',
        ?string $baseUrl = null,
        ?ClientInterface $httpClient = null,
        ?RequestFactoryInterface $requestFactory = null,
        ?StreamFactoryInterface $streamFactory = null,
        ?string $signingSecret = null,
    ) {
        if (trim($apiKey) === '') {
            throw new \InvalidArgumentException('Marram: $apiKey is required.');
        }
        $this->trimmedApiKey = trim($apiKey);
        $this->signingSecret = $signingSecret !== null && trim($signingSecret) !== '' ? trim($signingSecret) : null;
        if ($baseUrl === null && !isset(self::BASE_URLS[$environment])) {
            throw new \InvalidArgumentException("Marram: unknown environment '{$environment}' — use production or staging.");
        }

        $this->baseUrl = rtrim($baseUrl ?? self::BASE_URLS[$environment], '/');

        $transport = new Transport(
            $this->baseUrl,
            trim($apiKey),
            $httpClient ?? Psr18ClientDiscovery::find(),
            $requestFactory ?? Psr17FactoryDiscovery::findRequestFactory(),
            $streamFactory ?? Psr17FactoryDiscovery::findStreamFactory(),
        );

        $this->connections = new Connections($transport);
        $this->sessions = new Sessions($transport);
        $this->webhooks = new Webhooks($transport);
        $this->proxy = new ProviderProxy($transport);
        $this->environment = new Environment($transport);
    }

    /**
     * Mints a connect token for the browser (Marram.connect(provider, { token })). Signed
     * locally with your signing secret — no API call. Each token starts exactly one flow.
     */
    public function connectToken(
        string $externalUserId,
        ?string $provider = null,
        ?string $integrationKey = null,
        int $expiresIn = ConnectToken::DEFAULT_LIFE_SECONDS,
        ?string $redirectUrl = null,
    ): ConnectToken {
        return $this->mint('connect', $externalUserId, $provider, $integrationKey, $expiresIn, $redirectUrl);
    }

    /** Mints a sign-in token for the browser (Marram.signIn(provider, { token })). */
    public function signInToken(
        ?string $externalUserId = null,
        ?string $provider = null,
        ?string $integrationKey = null,
        int $expiresIn = ConnectToken::DEFAULT_LIFE_SECONDS,
        ?string $redirectUrl = null,
    ): ConnectToken {
        return $this->mint('signin', $externalUserId, $provider, $integrationKey, $expiresIn, $redirectUrl);
    }

    /** @param 'connect'|'signin' $use */
    private function mint(
        string $use,
        ?string $externalUserId,
        ?string $provider,
        ?string $integrationKey,
        int $expiresIn,
        ?string $redirectUrl,
    ): ConnectToken {
        if ($this->signingSecret === null) {
            throw new \InvalidArgumentException('Marram: pass $signingSecret to the Client to mint connect or sign-in tokens.');
        }

        $ids = ConnectToken::parseApiKeyIds($this->trimmedApiKey);
        if ($ids === null) {
            throw new \InvalidArgumentException('Marram: the API key does not name an organization and environment; copy the full key.');
        }

        return ConnectToken::mint(
            $use,
            $ids['organizationId'],
            $ids['environmentId'],
            $this->signingSecret,
            $externalUserId,
            $provider,
            $integrationKey,
            $expiresIn,
            redirectUrl: $redirectUrl,
        );
    }
}
