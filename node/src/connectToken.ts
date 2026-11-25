// Connect and sign-in tokens: short-lived HS256 JWTs minted locally with your environment's
// signing secret — no API call. The browser sends one as its bearer credential to start (and for
// connect, claim) a flow directly against Marram, to list providers and to disconnect; see
// @aszura/marram-browser. The key is the base64-decoded secret, the same one that verifies
// response signatures.

/** The longest life a token may declare; Marram refuses anything longer. */
export const MAX_TOKEN_LIFE_SECONDS = 600;

// The maximum, and the life of the temporary record init parks: the user has ten minutes with
// the provider whatever the token says, so a shorter default only cuts the page's time to click.
const DEFAULT_TOKEN_LIFE_SECONDS = 600;

export interface ConnectTokenClaims {
  use: 'connect' | 'signin';
  /** Your own ID for the user. Required for `connect`; optional for `signin`. */
  externalUserId?: string;
  /** Restricts the token to one provider. */
  provider?: string;
  /** Overrides the x-marram-integration-key header for the flow. */
  integrationKey?: string;
  /**
   * Where the user lands when the flow ends, http(s). Marram ignores whatever the page sends
   * instead, and your environment's redirect allowlist, if you set one, must still match. Never
   * copy this from the browser unchecked: your signature is what makes Marram trust it.
   */
  redirectUrl?: string;
  /** Seconds until expiry, at most 600 (the default). */
  expiresIn?: number;
  /** For tests. */
  now?: Date;
}

export interface MintedToken {
  token: string;
  /** The token's unique id: each jti acts once (one flow or one disconnect); claim echoes it. */
  jti: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * Mints a token. You normally call `marram.connectToken()` / `marram.signInToken()`, which
 * fill `organizationId` and `environmentId` from your API key; this is the underlying signer.
 */
export async function mintConnectToken(
  input: ConnectTokenClaims & {
    organizationId: string;
    environmentId: string;
    /** Base64 signing secret from your dashboard. */
    signingSecret: string;
  },
): Promise<MintedToken> {
  if (input.use === 'connect' && (!input.externalUserId || input.externalUserId === '')) {
    throw new TypeError('Marram: a connect token needs `externalUserId`.');
  }

  const expiresIn = input.expiresIn ?? DEFAULT_TOKEN_LIFE_SECONDS;
  if (expiresIn <= 0) throw new TypeError('Marram: `expiresIn` must be positive.');
  if (expiresIn > MAX_TOKEN_LIFE_SECONDS) {
    throw new TypeError(
      `Marram: \`expiresIn\` must be at most ${MAX_TOKEN_LIFE_SECONDS} seconds.`,
    );
  }

  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const jti = crypto.randomUUID();

  const payload: Record<string, unknown> = {
    typ: 'marram',
    use: input.use,
    env: input.environmentId,
    org: input.organizationId,
    jti,
    iat,
    exp: iat + expiresIn,
  };
  if (input.externalUserId !== undefined) payload.sub = input.externalUserId;
  if (input.provider !== undefined) payload.provider = input.provider;
  if (input.integrationKey !== undefined) payload.integrationKey = input.integrationKey;
  if (input.redirectUrl !== undefined) payload.redirectUrl = input.redirectUrl;

  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;

  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(input.signingSecret), (char) => char.charCodeAt(0));
  } catch {
    throw new TypeError('Marram: `signingSecret` must be the base64 secret from the dashboard.');
  }

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput)),
  );

  return { token: `${signingInput}.${base64Url(signature)}`, jti, expiresAt: iat + expiresIn };
}

/** The organization and environment a 4-part `sk_` key names; null for anything else. */
export function parseApiKeyIds(
  apiKey: string,
): { organizationId: string; environmentId: string } | null {
  const parts = apiKey.split('_');
  if (parts.length !== 4 || parts[0] !== 'sk' || parts[2] === '' || parts[3] === '') return null;
  return { organizationId: parts[2]!, environmentId: parts[3]! };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
