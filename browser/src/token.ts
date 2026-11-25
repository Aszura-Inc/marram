// Every flow starts here: your backend mints a short-lived connect or sign-in token (one line, no
// API call — `marram.connectToken()` / `marram.signInToken()` in the server SDKs), and the
// browser runs the flow directly against Marram. The token is the bearer credential on exactly
// these calls, and on `listProviders`, `listIdentityProviders`, `disconnect` and `setUpWebhook`;
// your API key never leaves your server.

import { MarramError, refusalMessage } from './errors.ts';
import { failureOf } from './flow.ts';
import { createPkce } from './pkce.ts';
import type { FlowKind } from './redirect.ts';
import { savePending } from './storage.ts';

export const BASE_URLS = {
  production: 'https://api.marram.dev/v1',
  staging: 'https://api-staging.marram.dev/v1',
} as const;

/** A token, alone or with the base URL your backend wants the flow run against (include `/v1`). */
export type MintedToken = string | { token: string; baseUrl?: string };

export interface TokenFlowOptions {
  /**
   * The token your backend minted, or a function that fetches one. Prefer the function: it runs on
   * click, so the token's ten minutes start with the flow. One token starts exactly one flow.
   */
  token: string | (() => MintedToken | Promise<MintedToken>);
  /** Default `production`. */
  environment?: keyof typeof BASE_URLS;
  /** Overrides `environment`. Include `/v1`. */
  baseUrl?: string;
  /**
   * Where Marram sends the user back. Ignored when the token carries a `redirectUrl`, which is
   * the simplest setup; otherwise it must be on your environment's redirect allowlist. Default:
   * the current page, without query or hash.
   */
  redirectUrl?: string;
  /** Default `oAuth2`. Pass one of the integration's `authTypes` from `listProviders`. */
  auth?: string;
  /**
   * Which of the provider's integrations to connect, sent as `x-marram-integration-key`. Pass
   * the `integrationKey` of the entry you drew from `listProviders`: the list doesn't say which
   * one is the default, and a provider with several and no default refuses `init` without it.
   * A token minted for one integration overrides this.
   */
  integrationKey?: string;
  theme?: 'light' | 'dark';
  /** Extra JSON fields for init (e.g. connection fields a provider collects up front). */
  body?: Record<string, unknown>;
  /** Your own context, kept in this tab and handed back by `finish` as `state`. JSON only. */
  state?: unknown;
  /** Default `location.assign`; `false` to stay on the page. */
  navigate?: ((authorizationUrl: string) => void) | false;
  fetch?: typeof fetch;
}

export interface ConnectOptions extends TokenFlowOptions {
  /**
   * Who claims the flow when the user returns. `marram` (default): `finish()` claims directly
   * with the token, which may have expired by then. `server`: the token isn't kept, and
   * `finish({ url })` posts to your endpoint, which claims with its API key. Use it when your
   * server has to see the claim. It doesn't buy a slow provider sign-in more time: the user has
   * ten minutes with the provider either way, and the thirty-minute wait for `claim` only starts
   * after that step.
   */
  claim?: 'marram' | 'server';
}

export interface StartResult {
  kind: FlowKind;
  provider: string;
  /** The flowId (connections) or sessionKey (sign-in). */
  key: string;
  authorizationUrl: string;
}

/**
 * Starts connecting the user the token names (its `sub`). On return, call `finish()` — it claims
 * against Marram with the same token and resolves `{ data: { status: 'connected', jti } }`.
 */
export function connect(provider: string, options: ConnectOptions): Promise<StartResult> {
  return startWithToken('connections', provider, options);
}

/**
 * Starts a sign-in. On return, `finish({ url })` still posts the sessionKey and verifier to your
 * backend, which claims with the API key — the identity must come to your server from Marram,
 * never through the browser.
 */
export function signIn(provider: string, options: TokenFlowOptions): Promise<StartResult> {
  return startWithToken('auth', provider, options);
}

async function startWithToken(
  service: 'connections' | 'auth',
  provider: string,
  options: ConnectOptions,
): Promise<StartResult> {
  if (typeof provider !== 'string' || provider === '') {
    throw new TypeError('Marram: `provider` is required.');
  }
  requireToken(options.token);

  const redirectUrl = options.redirectUrl ?? defaultRedirectUrl();
  const pkce = await createPkce();
  const minted = await resolveToken(options.token, 'START_FAILED');
  const baseUrl = resolveBaseUrl(minted, options);

  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/${service}/${encodeURIComponent(provider)}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.integrationKey === undefined
          ? {}
          : { 'x-marram-integration-key': options.integrationKey }),
      },
      body: JSON.stringify({
        ...options.body,
        auth: options.auth ?? 'oAuth2',
        redirectUrl,
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
        ...(options.theme === undefined ? {} : { theme: options.theme }),
      }),
    });
  } catch (cause) {
    throw new MarramError('START_FAILED', 'Could not reach Marram.', { cause });
  }

  const body = await readBody(response);
  if (!response.ok) {
    const message = refusalMessage(`Marram answered ${response.status}`, body);
    throw new MarramError('START_FAILED', message, { status: response.status, body });
  }

  const result = readInitResponse(body, provider);
  // Sign-in, and a connect your server claims, finish through your backend: no token to keep.
  const keepToken = result.kind === 'connection' && options.claim !== 'server';
  savePending(result.key, {
    codeVerifier: pkce.codeVerifier,
    provider,
    kind: result.kind,
    key: result.key,
    state: options.state,
    ...(keepToken ? { token: minted.token, baseUrl } : {}),
  });

  const navigate = options.navigate ?? ((url: string) => globalThis.location.assign(url));
  if (navigate !== false) navigate(result.authorizationUrl);
  return result;
}

/** One integration a user can connect, as `listProviders` returns it. */
export interface ConnectableIntegration {
  /** Pass it to `connect` as `integrationKey`. */
  integrationKey: string;
  label: string;
  /** What `connect` accepts as `auth` for this integration, e.g. `['oAuth2']`. */
  authTypes: string[];
  /** True when `connectionStatus` is `active`. */
  connected: boolean;
  /** The user's connection to this integration, or null when there is none. `reauth_required`
   *  means show "Reconnect". */
  connectionStatus: string | null;
}

/** A provider with at least one integration the token's user can connect. */
export interface ConnectableProvider {
  /** Pass it to `connect` as the provider. */
  providerKey: string;
  name: string;
  brandColors: Array<{ providerBrandColorId: string; name: string; role: string; hex: string }>;
  brandImages: Array<{
    providerBrandImageId: string;
    url: string;
    type: string;
    theme: string;
    color: string;
    description: string;
    sortOrder: number;
  }>;
  /** Usually one; each entry is a separate connection for the user. */
  integrations: ConnectableIntegration[];
}

/** One integration a user can sign in with, as `listIdentityProviders` returns it. */
export interface IdentityIntegration {
  /** Pass it to `signIn` as `integrationKey`. */
  integrationKey: string;
  label: string;
}

/** A provider enabled for sign-in. */
export interface IdentityProvider {
  /** Pass it to `signIn` as the provider. */
  providerKey: string;
  name: string;
  brandColors: ConnectableProvider['brandColors'];
  brandImages: ConnectableProvider['brandImages'];
  integrations: IdentityIntegration[];
}

export type ListProvidersOptions = Pick<
  TokenFlowOptions,
  'token' | 'environment' | 'baseUrl' | 'fetch'
>;

/**
 * The providers the token's user can connect, each with the integrations ready to and whether
 * the user has connected them. The same connect token then starts the flow: listing doesn't
 * spend it. Fetch it on page load; it's per user and never cached. After a flow finishes, trust
 * `finish()`'s result over a reload, which can lag the connect by up to about thirty seconds. A
 * failure is a `LIST_FAILED`.
 */
export function listProviders(options: ListProvidersOptions): Promise<ConnectableProvider[]> {
  return fetchList<ConnectableProvider>(options, 'environment/providers', 'providers');
}

/**
 * The providers this environment offers for sign-in. Takes a sign-in token, which then starts the
 * flow: listing doesn't spend it, so a login page needs no backend route. A connect token works
 * too, but `signIn` refuses one. A failure is a `LIST_FAILED`.
 */
export function listIdentityProviders(options: ListProvidersOptions): Promise<IdentityProvider[]> {
  return fetchList<IdentityProvider>(
    options,
    'environment/identity-providers',
    'identityProviders',
  );
}

async function fetchList<T>(
  options: ListProvidersOptions,
  path: string,
  field: string,
): Promise<T[]> {
  requireToken(options.token);

  const minted = await resolveToken(options.token, 'LIST_FAILED');
  const baseUrl = resolveBaseUrl(minted, options);
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${minted.token}`, Accept: 'application/json' },
    });
  } catch (cause) {
    throw new MarramError('LIST_FAILED', 'Could not reach Marram.', { cause });
  }

  const body = await readBody(response);
  if (!response.ok) {
    const message = refusalMessage(`Marram answered ${response.status}`, body);
    throw new MarramError('LIST_FAILED', message, { status: response.status, body });
  }

  const list =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[field] : undefined;
  if (!Array.isArray(list)) {
    throw new MarramError('LIST_FAILED', `Marram’s answer had no ${field} array.`, { body });
  }
  return list as T[];
}

export type DisconnectOptions = ListProvidersOptions & Pick<TokenFlowOptions, 'integrationKey'>;

/**
 * Disconnects the token's user (its `sub`) from a provider: Marram revokes the credentials at
 * the provider and clears them, and the user can connect again. Each token disconnects once and
 * can't start a flow afterwards, so pass a function that mints a fresh one. Resolves when it's
 * done: trust that over a reloaded list, which can lag by up to about thirty seconds. A failure
 * is a `DISCONNECT_FAILED`.
 */
export async function disconnect(provider: string, options: DisconnectOptions): Promise<void> {
  if (typeof provider !== 'string' || provider === '') {
    throw new TypeError('Marram: `provider` is required.');
  }
  requireToken(options.token);

  const minted = await resolveToken(options.token, 'DISCONNECT_FAILED');
  const baseUrl = resolveBaseUrl(minted, options);
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/connections/${encodeURIComponent(provider)}/revoke`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        Accept: 'application/json',
        ...(options.integrationKey === undefined
          ? {}
          : { 'x-marram-integration-key': options.integrationKey }),
      },
    });
  } catch (cause) {
    throw new MarramError('DISCONNECT_FAILED', 'Could not reach Marram.', { cause });
  }

  if (!response.ok) {
    const body = await readBody(response);
    const message = refusalMessage(`Marram answered ${response.status}`, body);
    throw new MarramError('DISCONNECT_FAILED', message, { status: response.status, body });
  }
}

export type SetUpWebhookOptions = Pick<
  TokenFlowOptions,
  'token' | 'environment' | 'baseUrl' | 'integrationKey' | 'redirectUrl' | 'fetch'
> & {
  /** Default `location.assign`; `false` to stay on the page and render `setupUrl` yourself. */
  navigate?: ((setupUrl: string) => void) | false;
};

export interface WebhookSetup {
  /** Picked by Marram. A key or metadata of your own needs your API key, on your server. */
  webhookKey: string;
  /** Marram's hosted form, where the user finishes the setup. */
  setupUrl: string;
  /** The URL the user pastes into the provider's dashboard. The setup form shows it too. */
  ingressUrl: string;
}

/**
 * Starts a manual webhook setup for the token's user (its `sub`), who must already have a
 * connection for the integration. The user creates the webhook in the provider's dashboard and
 * completes Marram's hosted form at `setupUrl`, then lands back on `redirectUrl`. There's no
 * `finish` step. Each token starts one setup, connect or disconnect, and a refused attempt hands
 * it back. A failure is a `START_FAILED` whose `apiCode` is Marram's, e.g.
 * `CONNECTION_NOT_FOUND`, `CONNECTION_REVOKED` or `CONNECT_TOKEN_REUSED`.
 */
export async function setUpWebhook(
  provider: string,
  options: SetUpWebhookOptions,
): Promise<WebhookSetup> {
  if (typeof provider !== 'string' || provider === '') {
    throw new TypeError('Marram: `provider` is required.');
  }
  requireToken(options.token);

  const redirectUrl = options.redirectUrl ?? defaultRedirectUrl();
  const minted = await resolveToken(options.token, 'START_FAILED');
  const baseUrl = resolveBaseUrl(minted, options);
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/webhooks/${encodeURIComponent(provider)}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.integrationKey === undefined
          ? {}
          : { 'x-marram-integration-key': options.integrationKey }),
      },
      body: JSON.stringify({ redirectUrl }),
    });
  } catch (cause) {
    throw new MarramError('START_FAILED', 'Could not reach Marram.', { cause });
  }

  const body = await readBody(response);
  if (!response.ok) {
    const message = refusalMessage(`Marram answered ${response.status}`, body);
    throw new MarramError('START_FAILED', message, { status: response.status, body });
  }

  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const setupUrl = httpUrl(record.setupUrl);
  const { webhookKey, ingressUrl } = record;
  if (
    setupUrl === null ||
    typeof webhookKey !== 'string' ||
    webhookKey === '' ||
    typeof ingressUrl !== 'string'
  ) {
    throw new MarramError(
      'INVALID_START_RESPONSE',
      'Marram’s webhook init answered without an http or https setupUrl, a webhookKey or an ingressUrl.',
      { body },
    );
  }

  const navigate = options.navigate ?? ((url: string) => globalThis.location.assign(url));
  if (navigate !== false) navigate(setupUrl);
  return { webhookKey, setupUrl, ingressUrl };
}

// http(s) only: a javascript: URL would run in the page.
function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function requireToken(token: unknown): void {
  if (typeof token !== 'function' && (typeof token !== 'string' || token === '')) {
    throw new TypeError('Marram: `token` is required — mint one on your server.');
  }
}

function resolveBaseUrl(
  minted: { baseUrl?: string },
  options: Pick<TokenFlowOptions, 'baseUrl' | 'environment'>,
): string {
  return (
    minted.baseUrl ??
    options.baseUrl ??
    BASE_URLS[options.environment ?? 'production']
  ).replace(/\/+$/, '');
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return text; // not JSON, keep text
  }
}

async function resolveToken(
  token: TokenFlowOptions['token'],
  code: 'START_FAILED' | 'LIST_FAILED' | 'DISCONNECT_FAILED',
): Promise<{ token: string; baseUrl?: string }> {
  if (typeof token === 'string') return { token };

  let minted: MintedToken;
  try {
    minted = await token();
  } catch (cause) {
    if (cause instanceof MarramError) throw cause;
    const { status, body } = failureOf(cause);
    const message =
      status === null ? 'Could not get a token.' : `Getting a token failed with status ${status}.`;
    throw new MarramError(code, message, { status, body, cause });
  }

  const resolved = typeof minted === 'string' ? { token: minted } : minted;
  if (typeof resolved?.token !== 'string' || resolved.token === '') {
    throw new MarramError(code, 'Your `token` function returned no token.');
  }
  return resolved;
}

function readInitResponse(body: unknown, provider: string): StartResult {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const { authorizationUrl, flowId, sessionKey } = record;

  const url = httpUrl(authorizationUrl);
  if (url === null) {
    throw new MarramError(
      'INVALID_START_RESPONSE',
      'Marram’s init answered without an http or https authorizationUrl.',
      { body },
    );
  }

  if (typeof flowId === 'string' && flowId !== '') {
    return { kind: 'connection', provider, key: flowId, authorizationUrl: url };
  }
  if (typeof sessionKey === 'string' && sessionKey !== '') {
    return { kind: 'session', provider, key: sessionKey, authorizationUrl: url };
  }
  throw new MarramError(
    'INVALID_START_RESPONSE',
    'Marram’s init answered without a flowId or sessionKey.',
    { body },
  );
}

function defaultRedirectUrl(): string {
  const url = new URL(globalThis.location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
}
