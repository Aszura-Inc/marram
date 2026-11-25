import { segment, type Transport } from '../transport.ts';
import type { Connection, JsonBody, RequestBody } from '../types.ts';

export interface IntegrationOption {
  /** Only needed when the provider has several integrations and no default. */
  integrationKey?: string;
}

/** Users' connected provider accounts. */
export class Connections {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** Starts a connection. Send the user to `authorizationUrl`, then `claim` on return. */
  init(
    provider: string,
    body: RequestBody<'initConnection'> & { redirectUrl: string },
    options: IntegrationOption = {},
  ): Promise<JsonBody<'initConnection'>> {
    return this.#transport.json({
      method: 'POST',
      path: `connections/${segment(provider)}/init`,
      headers: { 'x-marram-integration-key': options.integrationKey },
      body,
    });
  }

  /**
   * Activates the connection with the `flowId` from `init`, the PKCE verifier and the
   * `claimCode` the redirect arrived with. Single use; expires 30 min after the provider step.
   * Throws `CONNECTION_NOT_FOUND`, `CODE_VERIFIER_MISMATCH` or `CLAIM_CODE_MISMATCH`.
   */
  async claim(
    provider: string,
    flowId: string,
    codeVerifier: string,
    claimCode: string,
  ): Promise<Connection> {
    const result = await this.#transport.json<JsonBody<'claimConnection'>>({
      method: 'POST',
      path: `connections/${segment(provider)}/claim`,
      body: { flowId, codeVerifier, claimCode } satisfies RequestBody<'claimConnection'>,
    });
    // An API-key claim always carries the connection; only token claims get the minimal body.
    return result.connection!;
  }

  /** Refreshes OAuth2 tokens for a user's connection. Throws `CONFLICT` if one is in flight. */
  async refresh(
    provider: string,
    externalUserId: string,
    options: IntegrationOption = {},
  ): Promise<Connection> {
    const result = await this.#transport.json<JsonBody<'refreshConnection'>>({
      method: 'POST',
      path: `connections/${segment(provider)}/refresh`,
      headers: {
        'x-marram-external-user-id': externalUserId,
        'x-marram-integration-key': options.integrationKey,
      },
    });
    return result.connection;
  }

  /**
   * Revokes the user's connection at the provider and disconnects it. A browser can do the same
   * for the token's own user — see `disconnect` in @aszura/marram-browser.
   */
  async revoke(
    provider: string,
    externalUserId: string,
    options: IntegrationOption = {},
  ): Promise<void> {
    await this.#transport.json<JsonBody<'revokeConnection'>>({
      method: 'DELETE',
      path: `connections/${segment(provider)}/revoke`,
      headers: {
        'x-marram-external-user-id': externalUserId,
        'x-marram-integration-key': options.integrationKey,
      },
    });
  }

  /**
   * Reads one user's connection: whether they're connected, and how it's doing. Never refreshes it
   * or calls the provider. Throws `CONNECTION_NOT_FOUND` if they haven't connected, or
   * `CONNECTION_REVOKED` if they disconnected.
   */
  async get(
    provider: string,
    externalUserId: string,
    options: IntegrationOption = {},
  ): Promise<Connection> {
    const result = await this.#transport.json<JsonBody<'getConnection'>>({
      method: 'GET',
      path: `connections/${segment(provider)}/connection`,
      headers: {
        'x-marram-external-user-id': externalUserId,
        'x-marram-integration-key': options.integrationKey,
      },
    });
    return result.connection;
  }

  /** Lists an integration's connections for this provider. */
  async list(provider: string, options: { integrationKey: string }): Promise<Connection[]> {
    const result = await this.#transport.json<JsonBody<'listConnections'>>({
      method: 'GET',
      path: `connections/${segment(provider)}/connections`,
      headers: { 'x-marram-integration-key': options.integrationKey },
    });
    return result.connections;
  }
}

export type ConnectionRedirect =
  /** `claimCode` is the one-time code `claim` needs; only this redirect carries it. */
  | { ok: true; claimCode: string }
  | { ok: false; error: string; errorMessage: string | null };

/**
 * Parses the `redirectUrl` a user lands on after connecting: `?status=connected&claimCode=…` or
 * `?error=…`. It never carries a key: claim with the `flowId` and verifier you kept, plus this
 * `claimCode`.
 */
export function parseConnectionRedirect(url: string | URL): ConnectionRedirect {
  const params = new URL(url).searchParams;
  const error = params.get('error');
  if (error !== null) {
    return { ok: false, error, errorMessage: params.get('error_message') };
  }
  if (params.get('status') !== 'connected') {
    return { ok: false, error: 'missing_status', errorMessage: null };
  }
  const claimCode = params.get('claimCode');
  if (claimCode === null || claimCode === '') {
    return { ok: false, error: 'missing_claim_code', errorMessage: null };
  }
  return { ok: true, claimCode };
}
