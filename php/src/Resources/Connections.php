<?php

declare(strict_types=1);

namespace Marram\Resources;

use Marram\MarramException;
use Marram\Transport;

/**
 * @phpstan-type Connection array{externalUserId: string, providerKey: string, integrationKey: string, providerUserId?: string|null, authType: string, status: string, grantedScopes?: list<mixed>|null, expiresAt?: string|null, lastRefreshedAt?: string|null, lastUsedAt?: string|null, lastError?: string|null, lastErrorAt?: string|null, createdAt: string, updatedAt: string, disconnectedAt?: string|null}
 */
final class Connections
{
    public function __construct(private readonly Transport $transport)
    {
    }

    /**
     * Starts a connection. Keep the flowId it returns next to the PKCE verifier; claim takes both.
     *
     * @param array{auth: string, redirectUrl: string, codeChallenge: string, codeChallengeMethod: 'S256', externalUserId: string, theme?: string} $body
     *
     * @return array{flowId: string, authorizationUrl: string, message?: string}
     *
     * @throws MarramException
     */
    public function init(string $provider, array $body, ?string $integrationKey = null): array
    {
        /** @var array{flowId: string, authorizationUrl: string, message?: string} */
        return $this->transport->json(
            'POST',
            'connections/' . Transport::segment($provider) . '/init',
            ['x-marram-integration-key' => $integrationKey],
            body: $body,
        );
    }

    /**
     * Activates the connection with the flowId from init, the PKCE verifier and the claimCode the
     * redirect arrived with. One use only; expires 30 min after the provider step.
     *
     * @return Connection
     *
     * @throws MarramException
     */
    public function claim(string $provider, string $flowId, string $codeVerifier, string $claimCode): array
    {
        $result = $this->transport->json(
            'POST',
            'connections/' . Transport::segment($provider) . '/claim',
            [],
            body: ['flowId' => $flowId, 'codeVerifier' => $codeVerifier, 'claimCode' => $claimCode],
        );

        /** @var Connection */
        return $result['connection'];
    }

    /**
     * Refreshes OAuth2 tokens for a user's connection. 409 CONFLICT if a refresh is already running.
     *
     * @return Connection
     *
     * @throws MarramException
     */
    public function refresh(string $provider, string $externalUserId, ?string $integrationKey = null): array
    {
        $result = $this->transport->json(
            'POST',
            'connections/' . Transport::segment($provider) . '/refresh',
            [
                'x-marram-external-user-id' => $externalUserId,
                'x-marram-integration-key' => $integrationKey,
            ],
        );

        /** @var Connection */
        return $result['connection'];
    }

    /**
     * Revokes the user's connection at the provider and disconnects it. A browser can do the same
     * for the token's own user (disconnect in @aszura/marram-browser).
     *
     * @throws MarramException
     */
    public function revoke(string $provider, string $externalUserId, ?string $integrationKey = null): void
    {
        $this->transport->json(
            'DELETE',
            'connections/' . Transport::segment($provider) . '/revoke',
            [
                'x-marram-external-user-id' => $externalUserId,
                'x-marram-integration-key' => $integrationKey,
            ],
        );
    }

    /**
     * Reads one user's connection: whether they're connected, and how it's doing. Never refreshes
     * it or calls the provider. 404 CONNECTION_NOT_FOUND if they haven't connected, 410
     * CONNECTION_REVOKED if they disconnected.
     *
     * @return Connection
     *
     * @throws MarramException
     */
    public function get(string $provider, string $externalUserId, ?string $integrationKey = null): array
    {
        $result = $this->transport->json(
            'GET',
            'connections/' . Transport::segment($provider) . '/connection',
            [
                'x-marram-external-user-id' => $externalUserId,
                'x-marram-integration-key' => $integrationKey,
            ],
        );

        /** @var Connection */
        return $result['connection'];
    }

    /**
     * Lists the integration's connections.
     *
     * @return list<Connection>
     *
     * @throws MarramException
     */
    public function list(string $provider, string $integrationKey): array
    {
        $result = $this->transport->json(
            'GET',
            'connections/' . Transport::segment($provider) . '/connections',
            ['x-marram-integration-key' => $integrationKey],
        );

        /** @var list<Connection> */
        return $result['connections'];
    }
}
