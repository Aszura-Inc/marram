import { MarramError, refusalMessage } from './errors.ts';
import { parseRedirect, redirectPath, stripRedirectParams, type FlowKind } from './redirect.ts';
import {
  forgetPending,
  peekLatest,
  peekPending,
  takeLatest,
  type PendingFlow,
} from './storage.ts';

/** Your backend's finish endpoint, not Marram (the API key stays server-side), POSTed as JSON. */
export interface FetchEndpointOptions {
  url: string;
  /** e.g. a CSRF token. */
  headers?: HeadersInit;
  /** Default `same-origin`. */
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  send?: never;
}

/** Your backend's finish endpoint, reached through your own HTTP client. */
export interface SendEndpointOptions {
  /** Delivers the payload and resolves the endpoint's JSON; a rejection becomes a `MarramError`. */
  send: (payload: Record<string, unknown>) => Promise<unknown>;
  url?: never;
  headers?: never;
  credentials?: never;
  fetch?: never;
}

export type EndpointOptions = FetchEndpointOptions | SendEndpointOptions;

export type FinishOptions = Partial<EndpointOptions> & {
  /** Extra fields beside the provider, key and verifier. */
  body?: Record<string, unknown>;
  /** Default `location.href`. */
  location?: string | URL;
  /**
   * Strip Marram's params from the address bar. Default true unless `location` is given.
   * A function gets the clean path (with search and hash) and replaces the URL itself, for a
   * router that must know: `(path) => navigate(path, { replace: true })`.
   */
  cleanUrl?: boolean | ((path: string) => void);
};

export type FinishResult<T = unknown, S = unknown> =
  /** Claimed; `data` is your endpoint's response (or Marram's, for a token flow). */
  | { ok: true; kind: FlowKind; provider: string; key: string; data: T; state: S }
  /** Declined or provider error. `state` is from the flow this tab started last, if any. */
  | { ok: false; error: string; errorMessage: string | null; state: S | undefined };

/**
 * Finishes the flow the redirect belongs to: a connect that kept its token claims directly against
 * Marram, everything else POSTs the provider, key, verifier and the redirect's `claimCode` to
 * your finish endpoint. Null if this isn't a Marram redirect. Options are only optional when
 * every flow you start is a connect that Marram claims.
 */
export async function finish<T = unknown, S = unknown>(
  options: FinishOptions = {},
): Promise<FinishResult<T, S> | null> {
  // Whether an endpoint is needed depends on the pending flow, but two endpoints is always a
  // misconfiguration — caught before any side effect.
  if (options.send !== undefined && options.url !== undefined) {
    throw new TypeError('Marram: pass either `url` or `send`, not both.');
  }
  const href = options.location ?? globalThis.location.href;
  const redirect = parseRedirect(href);
  if (redirect === null) return null;

  const cleanUrl = options.cleanUrl ?? options.location === undefined;
  const clean = () => {
    if (typeof cleanUrl === 'function') {
      cleanUrl(redirectPath(href));
    } else if (cleanUrl) {
      globalThis.history.replaceState(globalThis.history.state, '', stripRedirectParams(href));
    }
  };

  if (!redirect.ok) {
    clean();
    return { ...redirect, state: takeLatest()?.state as S | undefined };
  }

  // A connect redirect carries no key — the flowId lives only in this tab — so it resolves to the
  // flow this tab started last.
  const pending = redirect.key === null ? peekLatest() : peekPending(redirect.key);
  if (pending === null || pending.kind !== redirect.kind) {
    if (pending !== null) forgetPending(pending.key);
    clean();
    throw new MarramError(
      'VERIFIER_NOT_FOUND',
      'This tab has no verifier for this flow. Start the flow again from this tab.',
    );
  }

  if (!claimsWithToken(pending)) checkEndpoint(options as EndpointOptions);

  const data = await claimOnce(pending, redirect.claimCode, options, clean);

  return {
    ok: true,
    kind: pending.kind,
    provider: pending.provider,
    key: pending.key,
    data: data as T,
    state: pending.state as S,
  };
}

function claimsWithToken(pending: PendingFlow): boolean {
  return pending.kind === 'connection' && pending.token !== undefined;
}

// Claims in flight in this tab. The URL and the pending flow now outlast the start of a claim, so a
// second finish() must join the first rather than send a claim that's bound to be refused.
const claiming = new Map<string, Promise<unknown>>();

function claimOnce(
  pending: PendingFlow,
  claimCode: string | null,
  options: FinishOptions,
  clean: () => void,
): Promise<unknown> {
  const running = claiming.get(pending.key);
  if (running !== undefined) return running;

  const claim = settleClaim(pending, claimCode, options, clean).finally(() =>
    claiming.delete(pending.key),
  );
  claiming.set(pending.key, claim);
  return claim;
}

/**
 * The pending flow and the URL stay until the claim settles. Marram allows one claim per flow, so
 * keeping them replays nothing, and a claim lost to a passing failure can run again: otherwise a
 * user who finished with the provider would have to start over.
 */
async function settleClaim(
  pending: PendingFlow,
  claimCode: string | null,
  options: FinishOptions,
  clean: () => void,
): Promise<unknown> {
  try {
    const data = await sendClaim(pending, claimCode, options);
    forgetPending(pending.key);
    clean();
    return data;
  } catch (error) {
    if (!(error instanceof MarramError && error.retryable)) {
      forgetPending(pending.key);
      clean();
    }
    throw error;
  }
}

// A redirect without a code sends no field, so Marram's own refusal reaches the caller.
function claimCodeField(claimCode: string | null): { claimCode?: string } {
  return claimCode === null ? {} : { claimCode };
}

function sendClaim(
  pending: PendingFlow,
  claimCode: string | null,
  options: FinishOptions,
): Promise<unknown> {
  // Claim with the same token that started the flow. The answer carries flow status and the
  // token's jti only, never connection fields.
  if (claimsWithToken(pending)) return claimWithToken(pending, claimCode);

  const keyField = pending.kind === 'connection' ? 'flowId' : 'sessionKey';
  return request(options as EndpointOptions, 'FINISH_FAILED', {
    ...options.body,
    provider: pending.provider,
    [keyField]: pending.key,
    codeVerifier: pending.codeVerifier,
    ...claimCodeField(claimCode),
  });
}

async function claimWithToken(
  pending: {
    provider: string;
    key: string;
    codeVerifier: string;
    token?: string;
    baseUrl?: string;
  },
  claimCode: string | null,
): Promise<unknown> {
  const response = await fetch(
    `${pending.baseUrl}/connections/${encodeURIComponent(pending.provider)}/claim`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pending.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        flowId: pending.key,
        codeVerifier: pending.codeVerifier,
        ...claimCodeField(claimCode),
      }),
    },
  ).catch((cause: unknown) => {
    throw new MarramError('FINISH_FAILED', 'Could not reach Marram to claim.', { cause });
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // not JSON, keep text
  }
  if (!response.ok) {
    const message = refusalMessage(`Marram answered ${response.status} to the claim`, body);
    throw new MarramError('FINISH_FAILED', message, { status: response.status, body });
  }
  return body;
}

// Before any side effect, so a misconfigured call doesn't strip the URL or spend the verifier.
function checkEndpoint(options: EndpointOptions): void {
  if (options.send !== undefined && options.url !== undefined) {
    throw new TypeError('Marram: pass either `url` or `send`, not both.');
  }
  if (options.send === undefined && typeof options.url !== 'string') {
    throw new TypeError('Marram: pass `url` or `send`.');
  }
}

async function request(
  options: EndpointOptions,
  code: 'START_FAILED' | 'FINISH_FAILED',
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (options.send === undefined) return post(options, code, payload);
  try {
    return await options.send(payload);
  } catch (cause) {
    if (cause instanceof MarramError) throw cause;
    const { status, body } = failureOf(cause);
    const message = status === null ? 'send failed.' : `send failed with status ${status}.`;
    throw new MarramError(code, message, { status, body, cause });
  }
}

// `status`/`body` on the error itself, else an axios-style `response.status`/`response.data`.
export function failureOf(error: unknown): { status: number | null; body: unknown } {
  const record = isRecord(error) ? error : {};
  const response = isRecord(record.response) ? record.response : {};
  const status =
    typeof record.status === 'number'
      ? record.status
      : typeof response.status === 'number'
        ? response.status
        : null;
  const body = record.body !== undefined ? record.body : (response.data ?? null);
  return { status, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function post(
  options: FetchEndpointOptions,
  code: 'START_FAILED' | 'FINISH_FAILED',
  payload: Record<string, unknown>,
): Promise<unknown> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  let response: Response;
  try {
    response = await doFetch(options.url, {
      method: 'POST',
      headers,
      credentials: options.credentials ?? 'same-origin',
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    throw new MarramError(code, `Could not reach ${options.url}.`, { cause });
  }

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // not JSON, keep text
  }
  if (!response.ok) {
    throw new MarramError(code, `${options.url} answered ${response.status}.`, {
      status: response.status,
      body,
    });
  }
  return body;
}
