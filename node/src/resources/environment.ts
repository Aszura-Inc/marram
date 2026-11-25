import type { Transport } from '../transport.ts';
import type { ConnectableProvider, IdentityProvider, Integration, JsonBody } from '../types.ts';

/** Read-only information about your environment. */
export class Environment {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** The integrations set up in your environment, with public provider details. */
  async integrations(): Promise<Integration[]> {
    const result = await this.#transport.json<JsonBody<'listIntegrations'>>({
      method: 'GET',
      path: 'environment/integrations',
    });
    return result.integrations;
  }

  /**
   * The providers enabled for sign-in, with their active integrations. Which appear depends on
   * their release status and your organization. A browser can fetch a trimmed list itself with a
   * sign-in token — see `listIdentityProviders` in @aszura/marram-browser.
   */
  async identityProviders(): Promise<IdentityProvider[]> {
    const result = await this.#transport.json<JsonBody<'listIdentityProviders'>>({
      method: 'GET',
      path: 'environment/identity-providers',
    });
    return result.identityProviders;
  }

  /**
   * The providers a user can connect, each with the integrations ready to: enabled, with at
   * least one auth type `init` accepts. With `externalUserId`, each integration also says
   * whether that user has connected it (`connected`, `connectionStatus`); without it both are
   * null. A browser can fetch the same list itself with a connect token — see `listProviders`
   * in @aszura/marram-browser.
   */
  async providers(options: { externalUserId?: string } = {}): Promise<ConnectableProvider[]> {
    const result = await this.#transport.json<JsonBody<'listProviders'>>({
      method: 'GET',
      path: 'environment/providers',
      headers: { 'x-marram-external-user-id': options.externalUserId },
    });
    return result.providers;
  }
}
