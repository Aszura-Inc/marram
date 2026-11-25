<?php

declare(strict_types=1);

namespace Marram\Resources;

use Marram\MarramException;
use Marram\Transport;

/** Read-only environment info. */
final class Environment
{
    public function __construct(private readonly Transport $transport)
    {
    }

    /**
     * Lists the environment's integrations.
     *
     * @return list<array<string, mixed>>
     *
     * @throws MarramException
     */
    public function integrations(): array
    {
        /** @var list<array<string, mixed>> */
        return $this->transport->json('GET', 'environment/integrations')['integrations'];
    }

    /**
     * Lists providers enabled for sign-in. Which appear depends on their release status and your
     * organization. A browser can fetch a trimmed list itself with a sign-in token
     * (listIdentityProviders in @aszura/marram-browser).
     *
     * @return list<array<string, mixed>>
     *
     * @throws MarramException
     */
    public function identityProviders(): array
    {
        /** @var list<array<string, mixed>> */
        return $this->transport->json('GET', 'environment/identity-providers')['identityProviders'];
    }

    /**
     * Lists the providers a user can connect, each with the integrations ready to: enabled, with
     * at least one auth type init accepts. With $externalUserId, each integration also says
     * whether that user has connected it (connected, connectionStatus); without it both are null.
     * A browser can fetch the same list itself with a connect token (listProviders in
     * @aszura/marram-browser).
     *
     * @return list<array<string, mixed>>
     *
     * @throws MarramException
     */
    public function providers(?string $externalUserId = null): array
    {
        /** @var list<array<string, mixed>> */
        return $this->transport->json(
            'GET',
            'environment/providers',
            ['x-marram-external-user-id' => $externalUserId],
        )['providers'];
    }
}
