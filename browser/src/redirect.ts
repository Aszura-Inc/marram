export type FlowKind = 'connection' | 'session';

/**
 * `claimCode` is the one-time code Marram issues after the provider step and gives only to the
 * browser that finished it; the claim needs it beside the verifier. Null when the redirect carries
 * none, which Marram then refuses at the claim.
 */
export type MarramRedirect =
  /** A finished connect flow. The redirect carries no key: finish uses the flowId this tab kept. */
  | { ok: true; kind: 'connection'; key: null; claimCode: string | null }
  /** A finished sign-in. */
  | { ok: true; kind: 'session'; key: string; claimCode: string | null }
  | { ok: false; error: string; errorMessage: string | null };

/** Query params Marram adds to the redirectUrl. `status` only counts when it is `connected`. */
export const REDIRECT_PARAMS = [
  'status',
  'sessionKey',
  'claimCode',
  'error',
  'error_message',
] as const;

/** Parses a Marram redirect URL; null if it isn't one. */
export function parseRedirect(url: string | URL): MarramRedirect | null {
  const params = new URL(url).searchParams;

  const error = params.get('error');
  if (error !== null && error !== '') {
    return { ok: false, error, errorMessage: params.get('error_message') };
  }

  const claimCode = params.get('claimCode') || null;

  const sessionKey = params.get('sessionKey');
  if (sessionKey !== null && sessionKey !== '') {
    return { ok: true, kind: 'session', key: sessionKey, claimCode };
  }
  if (params.get('status') === 'connected') {
    return { ok: true, kind: 'connection', key: null, claimCode };
  }
  return null;
}

/** URL with Marram's params removed. */
export function stripRedirectParams(url: string | URL): string {
  return stripped(url).toString();
}

/** Path, search and hash with Marram's params removed: what a router's `navigate` takes. */
export function redirectPath(url: string | URL): string {
  const clean = stripped(url);
  return clean.pathname + clean.search + clean.hash;
}

function stripped(url: string | URL): URL {
  const clean = new URL(url);
  for (const name of REDIRECT_PARAMS) {
    // `status` is a common param name; only Marram's own value is stripped.
    if (name === 'status' && clean.searchParams.get('status') !== 'connected') continue;
    clean.searchParams.delete(name);
  }
  return clean;
}
