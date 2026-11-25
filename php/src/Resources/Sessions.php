<?php

declare(strict_types=1);

namespace Marram\Resources;

use Marram\MarramException;
use Marram\Transport;

/**
 * @phpstan-type Session array{sessionKey: string, providerKey: string, integrationKey: string, externalUserId?: string|null, providerUserId?: string|null, authType: string, status: string, grantedScopes?: list<mixed>|null, expiresAt?: string|null, lastRefreshedAt?: string|null, lastUsedAt?: string|null, lastError?: string|null, lastErrorAt?: string|null, createdAt: string, updatedAt: string, disconnectedAt?: string|null}
 * @phpstan-type UserInfo array{user: array<string, mixed>, raw: array<string, mixed>}
 */
final class Sessions
{
    public function __construct(private readonly Transport $transport)
    {
    }

    /**
     * Starts a sign-in.
     *
     * @param array{auth: 'oAuth2', redirectUrl: string, codeChallenge: string, codeChallengeMethod: 'S256', externalUserId?: string|null, theme?: string} $body
     *
     * @return array{sessionKey: string, authorizationUrl: string, message?: string}
     *
     * @throws MarramException
     */
    public function init(string $provider, array $body, ?string $integrationKey = null): array
    {
        /** @var array{sessionKey: string, authorizationUrl: string, message?: string} */
        return $this->transport->json(
            'POST',
            'auth/' . Transport::segment($provider) . '/init',
            ['x-marram-integration-key' => $integrationKey],
            body: $body,
        );
    }

    /**
     * Returns the signed-in user. Needs the claimCode query parameter the redirect arrived with,
     * beside the verifier. One use only; expires 30 min after the provider step.
     *
     * @return UserInfo
     *
     * @throws MarramException
     */
    public function claim(string $provider, string $sessionKey, string $codeVerifier, string $claimCode): array
    {
        /** @var UserInfo */
        return $this->transport->json(
            'POST',
            'auth/' . Transport::segment($provider) . '/claim',
            ['x-marram-session-key' => $sessionKey],
            body: ['codeVerifier' => $codeVerifier, 'claimCode' => $claimCode],
        );
    }

    /**
     * Fetches the user live from the provider.
     *
     * @return UserInfo
     *
     * @throws MarramException
     */
    public function userinfo(string $provider, string $sessionKey, ?string $integrationKey = null): array
    {
        /** @var UserInfo */
        return $this->transport->json(
            'POST',
            'auth/' . Transport::segment($provider) . '/userinfo',
            [
                'x-marram-session-key' => $sessionKey,
                'x-marram-integration-key' => $integrationKey,
            ],
        );
    }

    /**
     * Refreshes tokens. 409 CONFLICT if a refresh is already running.
     *
     * @return Session
     *
     * @throws MarramException
     */
    public function refresh(string $provider, string $sessionKey): array
    {
        $result = $this->transport->json(
            'POST',
            'auth/' . Transport::segment($provider) . '/refresh',
            ['x-marram-session-key' => $sessionKey],
        );

        /** @var Session */
        return $result['session'];
    }

    /**
     * Revokes the session.
     *
     * @throws MarramException
     */
    public function revoke(string $provider, string $sessionKey, ?string $integrationKey = null): void
    {
        $this->transport->json(
            'DELETE',
            'auth/' . Transport::segment($provider) . '/revoke',
            [
                'x-marram-session-key' => $sessionKey,
                'x-marram-integration-key' => $integrationKey,
            ],
        );
    }

    /**
     * Reads one session's state. Never refreshes it or calls the provider: userinfo is the live
     * call. 404 SESSION_NOT_FOUND, 410 SESSION_REVOKED.
     *
     * @return Session
     *
     * @throws MarramException
     */
    public function get(string $provider, string $sessionKey): array
    {
        $result = $this->transport->json(
            'GET',
            'auth/' . Transport::segment($provider) . '/session',
            ['x-marram-session-key' => $sessionKey],
        );

        /** @var Session */
        return $result['session'];
    }

    /**
     * Lists this provider's sessions.
     *
     * @return list<Session>
     *
     * @throws MarramException
     */
    public function list(string $provider, ?string $integrationKey = null): array
    {
        $result = $this->transport->json(
            'GET',
            'auth/' . Transport::segment($provider) . '/sessions',
            ['x-marram-integration-key' => $integrationKey],
        );

        /** @var list<Session> */
        return $result['sessions'];
    }
}
