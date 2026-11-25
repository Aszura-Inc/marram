import { mintConnectToken, parseApiKeyIds, type ConnectTokenClaims, type MintedToken } from './connectToken.ts';
import { Connections } from './resources/connections.ts';
import { Environment } from './resources/environment.ts';
import { ProviderProxy } from './resources/proxy.ts';
import { Sessions } from './resources/sessions.ts';
import { Webhooks } from './resources/webhooks.ts';
import { Transport, type MarramOptions } from './transport.ts';

/** Marram API client. Server-side only: it holds your secret API key. */
export class Marram {
  /** Users' connected accounts. */
  readonly connections: Connections;
  /** End-user sign-in sessions. */
  readonly sessions: Sessions;
  /** Provider webhook subscriptions. */
  readonly webhooks: Webhooks;
  /** Calls to provider APIs. */
  readonly proxy: ProviderProxy;
  /** Integrations and identity providers. */
  readonly environment: Environment;
  /** Base URL, including `/v1`. */
  readonly baseUrl: string;
  readonly #transport: Transport;

  constructor(options: MarramOptions) {
    const transport = new Transport(options);
    this.#transport = transport;
    this.baseUrl = transport.baseUrl;
    this.connections = new Connections(transport);
    this.sessions = new Sessions(transport);
    this.webhooks = new Webhooks(transport);
    this.proxy = new ProviderProxy(transport);
    this.environment = new Environment(transport);
  }

  /**
   * Mints a connect token for the browser (`Marram.connect(provider, { token })`). Signed
   * locally with your signing secret — no API call. Each token starts exactly one flow.
   */
  connectToken(
    options: Omit<ConnectTokenClaims, 'use'> & { externalUserId: string },
  ): Promise<MintedToken> {
    return this.#mint({ ...options, use: 'connect' });
  }

  /** Mints a sign-in token for the browser (`Marram.signIn(provider, { token })`). */
  signInToken(options: Omit<ConnectTokenClaims, 'use'> = {}): Promise<MintedToken> {
    return this.#mint({ ...options, use: 'signin' });
  }

  #mint(claims: ConnectTokenClaims): Promise<MintedToken> {
    if (this.#transport.signingSecret === null) {
      throw new TypeError(
        'Marram: pass `signingSecret` in the client options to mint connect or sign-in tokens.',
      );
    }
    const ids = parseApiKeyIds(this.#transport.apiKey);
    if (ids === null) {
      throw new TypeError(
        'Marram: the API key does not name an organization and environment; copy the full key.',
      );
    }
    return mintConnectToken({ ...claims, ...ids, signingSecret: this.#transport.signingSecret });
  }
}
