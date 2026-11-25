<?php

declare(strict_types=1);

namespace Marram\Resources;

use Marram\MarramException;
use Marram\Transport;

/**
 * Verify deliveries with Signature::verifyWebhook().
 *
 * @phpstan-type Webhook array{webhookKey: string, kind?: string|null, status: string, providerWebhookId?: string|null, externalUserId?: string|null, metadata?: string|null, webhookData?: array<string, mixed>, registeredAt?: string|null, lastError?: string|null, lastErrorAt?: string|null, lastDeliveredAt?: string|null, createdAt: string, updatedAt: string}
 * @phpstan-type WebhookMutation array{success: true, webhookKey: string, providerWebhookId?: string|null, kind?: string|null}
 */
final class Webhooks
{
    public function __construct(private readonly Transport $transport)
    {
    }

    /**
     * Registers a webhook at the provider.
     *
     * @param array<string, mixed> $body
     * @param string|null          $kind
     * @param string|null          $webhookKey Optional; a few words, like "init", are reserved.
     * @param string|null          $metadata   Max 1 KB, echoed as x-marram-metadata.
     *
     * @return WebhookMutation
     *
     * @throws MarramException
     */
    public function register(
        string $provider,
        string $externalUserId,
        array $body = [],
        ?string $kind = null,
        ?string $webhookKey = null,
        ?string $metadata = null,
        ?string $version = null,
        ?string $integrationKey = null,
    ): array {
        /** @var WebhookMutation */
        return $this->transport->json(
            'POST',
            'webhooks/' . Transport::segment($provider),
            [
                ...self::scope($externalUserId, $integrationKey),
                'x-marram-version' => $version,
                'x-marram-webhook-kind' => $kind,
                'x-marram-webhook-key' => $webhookKey,
                'x-marram-metadata' => $metadata,
            ],
            body: (object) $body,
        );
    }

    /**
     * Lists the connection's webhooks.
     *
     * @return list<Webhook>
     *
     * @throws MarramException
     */
    public function list(string $provider, string $externalUserId, ?string $integrationKey = null): array
    {
        $result = $this->transport->json(
            'GET',
            'webhooks/' . Transport::segment($provider),
            self::scope($externalUserId, $integrationKey),
        );

        /** @var list<Webhook> */
        return $result['webhooks'];
    }

    /**
     * Reads one webhook.
     *
     * @return Webhook
     *
     * @throws MarramException
     */
    public function get(string $provider, string $webhookKey, string $externalUserId, ?string $integrationKey = null): array
    {
        $result = $this->transport->json(
            'GET',
            'webhooks/' . Transport::segment($provider) . '/' . Transport::segment($webhookKey),
            self::scope($externalUserId, $integrationKey),
        );

        /** @var Webhook */
        return $result['webhook'];
    }

    /**
     * Updates a webhook at the provider.
     *
     * @param array<string, mixed> $body
     *
     * @return WebhookMutation
     *
     * @throws MarramException
     */
    public function update(
        string $provider,
        string $webhookKey,
        string $externalUserId,
        array $body = [],
        ?string $version = null,
        ?string $integrationKey = null,
    ): array {
        /** @var WebhookMutation */
        return $this->transport->json(
            'PATCH',
            'webhooks/' . Transport::segment($provider) . '/' . Transport::segment($webhookKey),
            [...self::scope($externalUserId, $integrationKey), 'x-marram-version' => $version],
            body: (object) $body,
        );
    }

    /**
     * Unregisters a webhook. unregisteredAtProvider is false for a manual webhook and for one
     * whose connection was revoked: Marram clears the record without calling the provider,
     * which may still hold it; remove it in the provider's dashboard. Revoking a connection
     * leaves its webhooks running until you delete them here.
     *
     * @return array{success: true, webhookKey: string, unregisteredAtProvider: bool, providerWebhookId?: string|null}
     *
     * @throws MarramException
     */
    public function delete(
        string $provider,
        string $webhookKey,
        string $externalUserId,
        ?string $version = null,
        ?string $integrationKey = null,
    ): array {
        /** @var array{success: true, webhookKey: string, unregisteredAtProvider: bool, providerWebhookId?: string|null} */
        return $this->transport->json(
            'DELETE',
            'webhooks/' . Transport::segment($provider) . '/' . Transport::segment($webhookKey),
            [...self::scope($externalUserId, $integrationKey), 'x-marram-version' => $version],
        );
    }

    /**
     * Starts a manual registration. Paste ingressUrl at the provider, finish at setupUrl.
     * The browser can start the same setup for a user who already has a connection with a
     * connect token, through @aszura/marram-browser's setUpWebhook.
     *
     * @return array{success: true, sessionId: string, webhookKey: string, setupUrl: string, ingressUrl: string, status: 'pending', fields: list<array<string, mixed>>}
     *
     * @throws MarramException
     */
    public function initManual(
        string $provider,
        string $externalUserId,
        ?string $redirectUrl = null,
        ?string $integrationKey = null,
    ): array {
        /** @var array{success: true, sessionId: string, webhookKey: string, setupUrl: string, ingressUrl: string, status: 'pending', fields: list<array<string, mixed>>} */
        return $this->transport->json(
            'POST',
            'webhooks/' . Transport::segment($provider) . '/init',
            self::scope($externalUserId, $integrationKey),
            body: $redirectUrl === null ? new \stdClass() : ['redirectUrl' => $redirectUrl],
        );
    }

    /** @return array<string, string|null> */
    private static function scope(string $externalUserId, ?string $integrationKey): array
    {
        return [
            'x-marram-external-user-id' => $externalUserId,
            'x-marram-integration-key' => $integrationKey,
        ];
    }
}
