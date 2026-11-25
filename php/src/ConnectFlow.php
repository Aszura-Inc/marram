<?php

declare(strict_types=1);

namespace Marram;

/**
 * The start and finish endpoints for connecting a user's account.
 *
 * @phpstan-import-type ProviderOptions from Flow
 */
final class ConnectFlow extends Flow
{
    /**
     * @param list<string>|array<string, ProviderOptions> $providers   Allowlist; per-provider 'auth' and 'integrationKey' optional.
     * @param string|\Closure(string): string             $redirectUrl
     * @param string                                      $auth        Default auth type for every provider.
     * @param 'light'|'dark'|null                         $theme
     */
    public function __construct(
        private readonly Client $marram,
        array $providers,
        string|\Closure $redirectUrl,
        private readonly string $auth = 'oAuth2',
        ?string $theme = null,
    ) {
        parent::__construct($providers, $redirectUrl, $theme);
    }

    protected function keyField(): string
    {
        return 'flowId';
    }

    /** @return array{provider: string, flowId: string, authorizationUrl: string} */
    protected function init(string $provider, array $options, string $codeChallenge, ?string $externalUserId): array
    {
        if ($externalUserId === null || $externalUserId === '') {
            // A connection is (integration, externalUserId): the start handler supplies the user
            // from your own session.
            throw new FlowInputException('externalUserId is required to connect.', 'INVALID_INPUT');
        }

        $result = $this->marram->connections->init($provider, [
            'auth' => $options['auth'] ?? $this->auth,
            'redirectUrl' => $this->redirectUrl($provider),
            'codeChallenge' => $codeChallenge,
            'codeChallengeMethod' => 'S256',
            'externalUserId' => $externalUserId,
            ...$this->themeField(),
        ], $options['integrationKey'] ?? null);

        return [
            'provider' => $provider,
            'flowId' => $result['flowId'],
            'authorizationUrl' => $result['authorizationUrl'],
        ];
    }

    /** @return array{provider: string, flowId: string, connection: array<string, mixed>} */
    protected function claim(string $provider, string $key, string $codeVerifier, string $claimCode): array
    {
        return [
            'provider' => $provider,
            'flowId' => $key,
            'connection' => $this->marram->connections->claim($provider, $key, $codeVerifier, $claimCode),
        ];
    }
}
