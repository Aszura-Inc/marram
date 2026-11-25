import { segment, type Transport } from '../transport.ts';
import type { JsonBody, Webhook } from '../types.ts';

export interface WebhookScope {
  /** Your own ID for the user whose connection the webhook belongs to. */
  externalUserId: string;
  /** Only needed when the provider has several integrations and no default. */
  integrationKey?: string;
}

export interface WebhookWriteOptions extends WebhookScope {
  /** Provider API version to pin. */
  version?: string;
  /** Kind-specific values for the provider call. */
  body?: Record<string, unknown>;
}

/** Provider webhook subscriptions. */
export class Webhooks {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** Registers a webhook at the provider. */
  register(
    provider: string,
    options: WebhookWriteOptions & {
      /** Provider webhook kind. */
      kind?: string;
      /** Custom key. Some words, e.g. `init`, are reserved. */
      webhookKey?: string;
      /** Up to 1 KB, echoed on deliveries as `x-marram-metadata`. */
      metadata?: string;
    },
  ): Promise<JsonBody<'registerWebhook'>> {
    return this.#transport.json({
      method: 'POST',
      path: `webhooks/${segment(provider)}`,
      headers: {
        ...scopeHeaders(options),
        'x-marram-version': options.version,
        'x-marram-webhook-kind': options.kind,
        'x-marram-webhook-key': options.webhookKey,
        'x-marram-metadata': options.metadata,
      },
      body: options.body ?? {},
    });
  }

  /** Lists the connection's webhooks for this provider. */
  async list(provider: string, scope: WebhookScope): Promise<Webhook[]> {
    const result = await this.#transport.json<JsonBody<'listWebhooks'>>({
      method: 'GET',
      path: `webhooks/${segment(provider)}`,
      headers: scopeHeaders(scope),
    });
    return result.webhooks;
  }

  /** Reads one webhook. */
  async get(provider: string, webhookKey: string, scope: WebhookScope): Promise<Webhook> {
    const result = await this.#transport.json<JsonBody<'getWebhook'>>({
      method: 'GET',
      path: `webhooks/${segment(provider)}/${segment(webhookKey)}`,
      headers: scopeHeaders(scope),
    });
    return result.webhook;
  }

  /** Updates a webhook at the provider. */
  update(
    provider: string,
    webhookKey: string,
    options: WebhookWriteOptions,
  ): Promise<JsonBody<'updateWebhook'>> {
    return this.#transport.json({
      method: 'PATCH',
      path: `webhooks/${segment(provider)}/${segment(webhookKey)}`,
      headers: { ...scopeHeaders(options), 'x-marram-version': options.version },
      body: options.body ?? {},
    });
  }

  /**
   * Unregisters a webhook at the provider and marks it revoked. `unregisteredAtProvider` is
   * `false` for a manual webhook and for one whose connection was revoked: Marram clears the
   * record without calling the provider, which may still hold it; remove it in the provider's
   * dashboard. Revoking a connection leaves its webhooks running until you delete them here.
   */
  delete(
    provider: string,
    webhookKey: string,
    options: WebhookScope & { version?: string },
  ): Promise<JsonBody<'deleteWebhook'>> {
    return this.#transport.json({
      method: 'DELETE',
      path: `webhooks/${segment(provider)}/${segment(webhookKey)}`,
      headers: { ...scopeHeaders(options), 'x-marram-version': options.version },
    });
  }

  /**
   * Starts a manual registration: paste `ingressUrl` in the provider's dashboard, then send the
   * user to `setupUrl`. The browser can start the same setup for a user who already has a
   * connection with a connect token, through `@aszura/marram-browser`'s `setUpWebhook`; a custom
   * `webhookKey` or `metadata` still needs this API-key call.
   */
  initManual(
    provider: string,
    options: WebhookScope & { redirectUrl?: string },
  ): Promise<JsonBody<'initManualWebhook'>> {
    return this.#transport.json({
      method: 'POST',
      path: `webhooks/${segment(provider)}/init`,
      headers: scopeHeaders(options),
      body: options.redirectUrl === undefined ? {} : { redirectUrl: options.redirectUrl },
    });
  }
}

function scopeHeaders(scope: WebhookScope): Record<string, string | undefined> {
  return {
    'x-marram-external-user-id': scope.externalUserId,
    'x-marram-integration-key': scope.integrationKey,
  };
}
