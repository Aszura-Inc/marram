import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import {
  MarramError,
  connect,
  createPkce,
  finish,
  parseRedirect,
  redirectPath,
  signIn,
} from '../src/index.ts';
import { pkceChallenge } from '../src/pkce.ts';

// Fake browser globals.

class MemoryStorage {
  #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(name: string): string | null {
    return this.#items.get(name) ?? null;
  }
  setItem(name: string, value: string): void {
    this.#items.set(name, String(value));
  }
  removeItem(name: string): void {
    this.#items.delete(name);
  }
  clear(): void {
    this.#items.clear();
  }
}

let storage: MemoryStorage;
let href: string;
const assigned: string[] = [];

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  storage = new MemoryStorage();
  href = 'https://app.test/';
  assigned.length = 0;
  setGlobal('sessionStorage', storage);
  setGlobal('location', {
    get href() {
      return href;
    },
    assign: (url: string) => assigned.push(url),
  });
  setGlobal('history', {
    state: null,
    replaceState: (_state: unknown, _title: string, url: string) => {
      href = url;
    },
  });
});

interface Recorded {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (next === undefined) throw new Error('fakeFetch: nothing queued');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const INIT = {
  flowId: 'flow_123',
  authorizationUrl: 'https://accounts.provider.test/consent?x=1',
};

const stored = (key: string) =>
  JSON.parse(storage.getItem(`marram:pkce:${key}`)!) as {
    codeVerifier: string;
    provider: string;
    kind: string;
    key: string;
    state: unknown;
    token?: string;
    baseUrl?: string;
  };

describe('createPkce', () => {
  it('computes the S256 challenge of a known verifier', async () => {
    const verifier = 'fixed-verifier-for-the-test-0123456789abcdef';
    assert.equal(
      await pkceChallenge(verifier),
      createHash('sha256').update(verifier).digest('base64url'),
    );
  });

  it('makes a 43-char base64url verifier whose challenge is its SHA-256', async () => {
    const pkce = await createPkce();
    assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(pkce.codeChallengeMethod, 'S256');
    assert.equal(
      pkce.codeChallenge,
      createHash('sha256').update(pkce.codeVerifier).digest('base64url'),
    );
  });
});

describe('parseRedirect', () => {
  it('reads connections, sessions and errors, and ignores other pages', () => {
    assert.deepEqual(parseRedirect('https://app.test/back?status=connected&claimCode=cc_1'), {
      ok: true,
      kind: 'connection',
      key: null,
      claimCode: 'cc_1',
    });
    assert.deepEqual(parseRedirect('https://app.test/back?sessionKey=sk&claimCode=cc_2'), {
      ok: true,
      kind: 'session',
      key: 'sk',
      claimCode: 'cc_2',
    });
    // A redirect with no code, or an empty one, still parses: Marram refuses it at the claim.
    assert.deepEqual(parseRedirect('https://app.test/back?status=connected&claimCode='), {
      ok: true,
      kind: 'connection',
      key: null,
      claimCode: null,
    });
    assert.deepEqual(
      parseRedirect('https://app.test/back?error=auth_error&error_message=Declined'),
      { ok: false, error: 'auth_error', errorMessage: 'Declined' },
    );
    assert.equal(parseRedirect('https://app.test/back?page=2'), null);
    // A status param that isn't Marram's is someone else's.
    assert.equal(parseRedirect('https://app.test/back?status=shipped'), null);
  });

  it('redirectPath keeps the rest of the URL, as a path', () => {
    assert.equal(
      redirectPath('https://app.test/back?tab=apps&status=connected&error_message=x#top'),
      '/back?tab=apps#top',
    );
    assert.equal(redirectPath('https://app.test/back?sessionKey=sk&claimCode=cc_2'), '/back');
    // A foreign status param survives the strip.
    assert.equal(redirectPath('https://app.test/back?status=shipped&sessionKey=sk'), '/back?status=shipped');
  });
});

const TOKEN = 'eyJ0.eyJw.sig';

describe('connect', () => {
  it('sends the challenge, keeps the verifier in this tab, then navigates', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));

    const result = await connect('google', {
      token: TOKEN,
      state: { tab: 'apps' },
      body: { integrationField: 'abc' },
      fetch,
    });

    assert.deepEqual(result, {
      kind: 'connection',
      provider: 'google',
      key: 'flow_123',
      authorizationUrl: INIT.authorizationUrl,
    });
    assert.deepEqual(assigned, [INIT.authorizationUrl]);

    const sent = calls[0]!;
    assert.equal(sent.init.method, 'POST');
    assert.equal(sent.body.integrationField, 'abc');
    assert.equal(sent.body.codeChallengeMethod, 'S256');
    assert.equal('codeVerifier' in sent.body, false);
    assert.equal('state' in sent.body, false);

    const pending = stored('flow_123');
    assert.equal(await pkceChallenge(pending.codeVerifier), sent.body.codeChallenge);
    assert.equal(pending.provider, 'google');
    assert.equal(pending.kind, 'connection');
    assert.deepEqual(pending.state, { tab: 'apps' });
    assert.equal(storage.getItem('marram:latest'), 'flow_123');
  });

  it('a body field can’t replace the challenge', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));
    await connect('google', { token: TOKEN, body: { codeChallenge: 'forged' }, fetch });
    assert.equal(await pkceChallenge(stored('flow_123').codeVerifier), calls[0]!.body.codeChallenge);
  });

  it('needs a provider, before any side effect', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));
    await assert.rejects(connect('', { token: TOKEN, fetch }), TypeError);
    assert.equal(calls.length, 0);
    assert.equal(storage.length, 0);
  });

  it('can stay on the page', async () => {
    const { fetch } = fakeFetch(json(200, INIT));
    await connect('google', { token: TOKEN, fetch, navigate: false });
    assert.deepEqual(assigned, []);
  });

  it('refuses a non-http authorizationUrl', async () => {
    const { fetch } = fakeFetch(
      json(200, { flowId: 'f', authorizationUrl: 'javascript:alert(1)' }),
    );
    await assert.rejects(connect('google', { token: TOKEN, fetch }), {
      code: 'INVALID_START_RESPONSE',
    });
    assert.deepEqual(assigned, []);
    assert.equal(storage.length, 0);
  });

  it('refuses an answer without a key', async () => {
    const { fetch } = fakeFetch(json(200, { authorizationUrl: INIT.authorizationUrl }));
    await assert.rejects(connect('google', { token: TOKEN, fetch }), {
      code: 'INVALID_START_RESPONSE',
    });
  });

  it('surfaces Marram’s failure with its status and body', async () => {
    const { fetch } = fakeFetch(json(403, { error: 'nope' }));
    await assert.rejects(connect('google', { token: TOKEN, fetch }), (error: unknown) => {
      assert.ok(error instanceof MarramError);
      assert.equal(error.code, 'START_FAILED');
      assert.equal(error.status, 403);
      assert.deepEqual(error.body, { error: 'nope' });
      return true;
    });
  });

  it('fails clearly when sessionStorage is blocked', async () => {
    setGlobal('sessionStorage', undefined);
    const { fetch } = fakeFetch(json(200, INIT));
    await assert.rejects(connect('google', { token: TOKEN, fetch }), {
      code: 'STORAGE_UNAVAILABLE',
    });
    assert.deepEqual(assigned, []);
  });

  it('sweeps verifiers from abandoned flows', async () => {
    storage.setItem('marram:pkce:old', JSON.stringify({ codeVerifier: 'v', createdAt: 0 }));
    storage.setItem('unrelated', 'kept');
    const { fetch } = fakeFetch(json(200, INIT));
    await connect('google', { token: TOKEN, fetch });
    assert.equal(storage.getItem('marram:pkce:old'), null);
    assert.equal(storage.getItem('unrelated'), 'kept');
  });
});

describe('a token function', () => {
  // What an axios client throws for a non-2xx answer.
  const axiosError = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, data },
    });

  it('fetches the token when the flow starts', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));
    let minted = 0;

    await connect('google', {
      token: async () => {
        minted += 1;
        return TOKEN;
      },
      fetch,
    });

    assert.equal(minted, 1);
    assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(stored('flow_123').token, TOKEN);
  });

  it('can choose the base URL, over the options', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));

    await connect('google', {
      token: () => ({ token: TOKEN, baseUrl: 'https://api.test/v1/' }),
      environment: 'staging',
      fetch,
    });

    assert.equal(calls[0]!.url, 'https://api.test/v1/connections/google/init');
    assert.equal(stored('flow_123').baseUrl, 'https://api.test/v1');
  });

  it('wraps an axios-style failure, keeping its status and body', async () => {
    const thrown = axiosError(409, { error: 'already_connected' });
    const { fetch, calls } = fakeFetch();
    await assert.rejects(
      connect('google', {
        token: async () => {
          throw thrown;
        },
        fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MarramError);
        assert.equal(error.code, 'START_FAILED');
        assert.equal(error.status, 409);
        assert.deepEqual(error.body, { error: 'already_connected' });
        assert.equal(error.cause, thrown);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it('uses null status and body when the failure carries neither', async () => {
    await assert.rejects(
      connect('google', {
        token: async () => {
          throw new TypeError('offline');
        },
      }),
      { code: 'START_FAILED', status: null, body: null },
    );
  });

  it('passes on a MarramError it threw, unwrapped', async () => {
    const own = new MarramError('STORAGE_UNAVAILABLE', 'from token');
    await assert.rejects(
      connect('google', {
        token: async () => {
          throw own;
        },
      }),
      (error: unknown) => error === own,
    );
  });

  it('refuses an empty answer without calling Marram', async () => {
    const { fetch, calls } = fakeFetch();
    await assert.rejects(connect('google', { token: async () => '', fetch }), {
      code: 'START_FAILED',
    });
    await assert.rejects(
      connect('google', { token: async () => ({}) as { token: string }, fetch }),
      { code: 'START_FAILED' },
    );
    assert.equal(calls.length, 0);
  });
});

describe('claim: server', () => {
  it('keeps no token, so finish posts to your endpoint', async () => {
    const init = fakeFetch(json(200, INIT));
    await connect('google', { token: TOKEN, claim: 'server', fetch: init.fetch });

    const pending = stored('flow_123');
    assert.equal(pending.token, undefined);
    assert.equal(pending.baseUrl, undefined);

    href = 'https://app.test/?status=connected';
    const backend = fakeFetch(json(200, { connected: true }));
    const result = await finish({ url: '/finish', fetch: backend.fetch });

    assert.equal(result?.ok, true);
    assert.equal(backend.calls[0]!.url, '/finish');
    assert.deepEqual(backend.calls[0]!.body, {
      provider: 'google',
      flowId: 'flow_123',
      codeVerifier: pending.codeVerifier,
    });
  });

  it('needs an endpoint at finish', async () => {
    const init = fakeFetch(json(200, INIT));
    await connect('google', { token: TOKEN, claim: 'server', fetch: init.fetch });
    href = 'https://app.test/?status=connected';
    await assert.rejects(finish(), TypeError);
  });
});

// A flow your server claims: finish goes to your endpoint.
async function started(init: Record<string, string> = INIT, state?: unknown) {
  const { fetch } = fakeFetch(json(200, init));
  const options = { token: TOKEN, state, fetch };
  await ('sessionKey' in init ? signIn('google', options) : connect('google', { ...options, claim: 'server' }));
  return stored(init.flowId ?? init.sessionKey!).codeVerifier;
}

describe('finish', () => {
  it('claims a connection: provider, flowId, verifier and claimCode to your endpoint, once', async () => {
    const verifier = await started(INIT, { tab: 'apps' });
    href = 'https://app.test/connected?status=connected&claimCode=cc_1&tab=apps';
    const { fetch, calls } = fakeFetch(json(200, { connection: { externalUserId: 'u1' } }));

    const result = await finish({ url: '/finish', fetch });

    assert.deepEqual(result, {
      ok: true,
      kind: 'connection',
      provider: 'google',
      key: 'flow_123',
      data: { connection: { externalUserId: 'u1' } },
      state: { tab: 'apps' },
    });
    assert.deepEqual(calls[0]!.body, {
      provider: 'google',
      flowId: 'flow_123',
      codeVerifier: verifier,
      claimCode: 'cc_1',
    });
    assert.equal(href, 'https://app.test/connected?tab=apps');
    assert.equal(storage.getItem('marram:pkce:flow_123'), null);
    assert.equal(storage.getItem('marram:latest'), null);
  });

  it('claims a sign-in with sessionKey', async () => {
    const verifier = await started({
      sessionKey: 'sk_9',
      authorizationUrl: INIT.authorizationUrl,
    });
    href = 'https://app.test/signed-in?sessionKey=sk_9&claimCode=cc_2';
    const { fetch, calls } = fakeFetch(json(200, { user: {} }));

    const result = await finish({ url: '/finish', fetch });
    assert.deepEqual(calls[0]!.body, {
      provider: 'google',
      sessionKey: 'sk_9',
      codeVerifier: verifier,
      claimCode: 'cc_2',
    });
    assert.equal(result?.ok && result.state, undefined);
    assert.equal(href, 'https://app.test/signed-in');
  });

  it('sends no claimCode when the redirect carried none', async () => {
    const verifier = await started();
    href = 'https://app.test/connected?status=connected';
    const { fetch, calls } = fakeFetch(json(200, {}));

    await finish({ url: '/finish', fetch });

    assert.deepEqual(calls[0]!.body, {
      provider: 'google',
      flowId: 'flow_123',
      codeVerifier: verifier,
    });
  });

  it('keeps the flow when your endpoint answers 5XX, so finish can run again', async () => {
    await started();
    href = 'https://app.test/connected?status=connected';
    const { fetch, calls } = fakeFetch(json(502, {}), json(200, {}));

    await assert.rejects(finish({ url: '/finish', fetch }), {
      code: 'FINISH_FAILED',
      retryable: true,
    });

    const result = await finish({ url: '/finish', fetch });
    assert.ok(result?.ok);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.body.codeVerifier, calls[1]!.body.codeVerifier);
  });

  it('touches nothing when the endpoint options are wrong', async () => {
    await started();
    href = 'https://app.test/connected?status=connected';

    await assert.rejects(finish(), TypeError);
    assert.equal(stored('flow_123').provider, 'google');
    assert.equal(href, 'https://app.test/connected?status=connected');
  });

  it('a reload after finishing can’t replay it', async () => {
    await started();
    href = 'https://app.test/connected?status=connected';
    await finish({ url: '/finish', fetch: fakeFetch(json(200, {})).fetch });
    assert.equal(await finish({ url: '/finish', fetch: fakeFetch().fetch }), null);
  });

  it('refuses a connect redirect when this tab started nothing, without calling your endpoint', async () => {
    href = 'https://app.test/connected?status=connected';
    const { fetch, calls } = fakeFetch();
    await assert.rejects(finish({ url: '/finish', fetch }), { code: 'VERIFIER_NOT_FOUND' });
    assert.equal(calls.length, 0);
  });

  it('refuses a session key this tab didn’t start, without calling your endpoint', async () => {
    href = 'https://app.test/signed-in?sessionKey=sk_someone_else';
    const { fetch, calls } = fakeFetch();
    await assert.rejects(finish({ url: '/finish', fetch }), { code: 'VERIFIER_NOT_FOUND' });
    assert.equal(calls.length, 0);
  });

  it('returns a provider error with the last flow’s state, without calling your endpoint', async () => {
    await started(INIT, 'settings');
    href = 'https://app.test/connected?error=auth_error&error_message=Declined';
    const { fetch, calls } = fakeFetch();
    assert.deepEqual(await finish({ url: '/finish', fetch }), {
      ok: false,
      error: 'auth_error',
      errorMessage: 'Declined',
      state: 'settings',
    });
    assert.equal(calls.length, 0);
    assert.equal(href, 'https://app.test/connected');
    // That flow is over: the provider sent the user back without finishing it.
    assert.equal(storage.getItem('marram:pkce:flow_123'), null);
  });

  it('a provider error with no flow in this tab has undefined state', async () => {
    href = 'https://app.test/connected?error=auth_error';
    const result = await finish({ url: '/finish', fetch: fakeFetch().fetch });
    assert.equal(result?.ok, false);
    assert.equal(result?.state, undefined);
  });

  it('is a no-op on a page Marram didn’t redirect to', async () => {
    href = 'https://app.test/dashboard';
    assert.equal(await finish({ url: '/finish', fetch: fakeFetch().fetch }), null);
  });

  it('leaves the address bar alone when given an explicit location', async () => {
    await started();
    const { fetch } = fakeFetch(json(200, {}));
    await finish({ url: '/finish', fetch, location: 'https://app.test/x?status=connected' });
    assert.equal(href, 'https://app.test/');
  });

  it('hands the clean path to a router instead of touching history', async () => {
    await started();
    href = 'https://app.test/connected?status=connected&tab=apps#top';
    const { fetch } = fakeFetch(json(200, {}));
    const replaced: string[] = [];

    await finish({ url: '/finish', fetch, cleanUrl: (path) => replaced.push(path) });

    assert.deepEqual(replaced, ['/connected?tab=apps#top']);
    assert.equal(href, 'https://app.test/connected?status=connected&tab=apps#top');
  });

  it('sends extra body fields, which can’t override the provider, key, verifier or claimCode', async () => {
    const verifier = await started();
    href = 'https://app.test/connected?status=connected&claimCode=cc_1';
    const { fetch, calls } = fakeFetch(json(200, {}));

    await finish({
      url: '/finish',
      fetch,
      body: {
        via: 'settings',
        provider: 'forged',
        flowId: 'forged',
        codeVerifier: 'forged',
        claimCode: 'forged',
      },
    });

    assert.deepEqual(calls[0]!.body, {
      via: 'settings',
      provider: 'google',
      flowId: 'flow_123',
      codeVerifier: verifier,
      claimCode: 'cc_1',
    });
  });
});

describe('Marram claims', () => {
  it('connect inits against Marram with the token and stores it for the claim', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));

    const result = await connect('google', {
      token: TOKEN,
      environment: 'staging',
      redirectUrl: 'https://app.test/connected',
      state: 'settings',
      fetch,
    });

    assert.deepEqual(result, {
      kind: 'connection',
      provider: 'google',
      key: 'flow_123',
      authorizationUrl: INIT.authorizationUrl,
    });
    assert.deepEqual(assigned, [INIT.authorizationUrl]);

    const sent = calls[0]!;
    assert.equal(sent.url, 'https://api-staging.marram.dev/v1/connections/google/init');
    assert.equal(new Headers(sent.init.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(sent.body.auth, 'oAuth2');
    assert.equal(sent.body.redirectUrl, 'https://app.test/connected');
    assert.equal(sent.body.codeChallengeMethod, 'S256');
    // The user comes from the token's sub, never the body.
    assert.equal('externalUserId' in sent.body, false);

    const pending = stored('flow_123');
    assert.equal(pending.token, TOKEN);
    assert.equal(pending.baseUrl, 'https://api-staging.marram.dev/v1');
  });

  it('finish claims a token flow directly against Marram — no endpoint needed', async () => {
    const initFetch = fakeFetch(json(200, INIT));
    await connect('google', { token: TOKEN, environment: 'staging', fetch: initFetch.fetch });
    const verifier = stored('flow_123').codeVerifier;
    href = 'https://app.test/?status=connected&claimCode=cc_1';

    const claimFetch = fakeFetch(json(200, { status: 'connected', jti: 'jti-1' }));
    setGlobal('fetch', claimFetch.fetch);

    const result = await finish();

    assert.deepEqual(result, {
      ok: true,
      kind: 'connection',
      provider: 'google',
      key: 'flow_123',
      data: { status: 'connected', jti: 'jti-1' },
      state: undefined,
    });
    const sent = claimFetch.calls[0]!;
    assert.equal(sent.url, 'https://api-staging.marram.dev/v1/connections/google/claim');
    assert.equal(new Headers(sent.init.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.deepEqual(sent.body, { flowId: 'flow_123', codeVerifier: verifier, claimCode: 'cc_1' });
    assert.equal(href, 'https://app.test/');
  });

  const startTokenFlow = async () => {
    await connect('google', { token: TOKEN, fetch: fakeFetch(json(200, INIT)).fetch });
    href = 'https://app.test/?status=connected';
  };

  it('keeps the flow through a network failure, so finish can run again', async () => {
    await startTokenFlow();
    const claimed = { status: 'connected', jti: 'j' };
    setGlobal('fetch', fakeFetch(new TypeError('offline'), json(200, claimed)).fetch);

    await assert.rejects(finish(), (error: unknown) => {
      assert.ok(error instanceof MarramError);
      assert.equal(error.code, 'FINISH_FAILED');
      assert.equal(error.retryable, true);
      return true;
    });
    assert.equal(stored('flow_123').token, TOKEN);
    assert.equal(href, 'https://app.test/?status=connected');

    const result = await finish();
    assert.ok(result?.ok);
    assert.deepEqual(result.data, claimed);
    assert.equal(storage.getItem('marram:pkce:flow_123'), null);
    assert.equal(href, 'https://app.test/');
  });

  for (const status of [429, 503]) {
    it(`keeps the flow through a ${status}`, async () => {
      await startTokenFlow();
      setGlobal('fetch', fakeFetch(json(status, { error: 'Later.', code: 'UNAVAILABLE' })).fetch);

      await assert.rejects(finish(), { code: 'FINISH_FAILED', status, retryable: true });
      assert.equal(stored('flow_123').token, TOKEN);
    });
  }

  it('drops the flow on a refusal, which another try can’t change', async () => {
    await startTokenFlow();
    setGlobal(
      'fetch',
      fakeFetch(json(403, { error: 'Wrong verifier.', code: 'CODE_VERIFIER_MISMATCH' })).fetch,
    );

    await assert.rejects(finish(), { code: 'FINISH_FAILED', status: 403, retryable: false });
    assert.equal(storage.getItem('marram:pkce:flow_123'), null);
    assert.equal(href, 'https://app.test/');
  });

  it('claims once when finish is called twice at the same time', async () => {
    await startTokenFlow();
    const { fetch, calls } = fakeFetch(json(200, { status: 'connected', jti: 'j' }));
    setGlobal('fetch', fetch);

    const [first, second] = await Promise.all([finish(), finish()]);

    assert.equal(calls.length, 1);
    assert.ok(first?.ok);
    assert.ok(second?.ok);
  });

  it('puts Marram’s code and explanation on the error', async () => {
    await startTokenFlow();
    const body = { error: 'This flow is gone.', code: 'CONNECTION_NOT_FOUND' };
    setGlobal('fetch', fakeFetch(json(404, body)).fetch);

    await assert.rejects(finish(), (error: unknown) => {
      assert.ok(error instanceof MarramError);
      assert.equal(error.apiCode, 'CONNECTION_NOT_FOUND');
      assert.match(error.message, /404.*CONNECTION_NOT_FOUND.*This flow is gone\./);
      return true;
    });
  });

  it('falls back to the status when the answer explains nothing', async () => {
    const { fetch } = fakeFetch(json(500, {}));

    await assert.rejects(connect('google', { token: TOKEN, fetch }), (error: unknown) => {
      assert.ok(error instanceof MarramError);
      assert.equal(error.message, 'Marram answered 500.');
      assert.equal(error.apiCode, null);
      assert.equal(error.retryable, false);
      return true;
    });
  });

  it('explains a refused start the same way', async () => {
    const body = { error: 'That redirect isn’t allowed.', code: 'REDIRECT_URL_NOT_ALLOWED' };
    const { fetch } = fakeFetch(json(403, body));

    await assert.rejects(connect('google', { token: TOKEN, fetch }), (error: unknown) => {
      assert.ok(error instanceof MarramError);
      assert.equal(error.code, 'START_FAILED');
      assert.equal(error.apiCode, 'REDIRECT_URL_NOT_ALLOWED');
      assert.match(error.message, /That redirect isn’t allowed\./);
      return true;
    });
  });

  it('a refused token claim surfaces with its status and body', async () => {
    const initFetch = fakeFetch(json(200, INIT));
    await connect('google', { token: TOKEN, fetch: initFetch.fetch });
    href = 'https://app.test/?status=connected';
    setGlobal(
      'fetch',
      fakeFetch(json(409, { error: 'reused', code: 'CONNECT_TOKEN_REUSED' })).fetch,
    );

    await assert.rejects(finish(), (error: unknown) => {
      assert.ok(error instanceof MarramError);
      assert.equal(error.code, 'FINISH_FAILED');
      assert.equal(error.status, 409);
      return true;
    });
  });

  it('signIn inits /auth with the token but keeps the finish on your backend', async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { sessionKey: 'sk_9', authorizationUrl: INIT.authorizationUrl }),
    );

    const result = await signIn('google', { token: TOKEN, environment: 'staging', fetch });

    assert.equal(result.kind, 'session');
    assert.equal(calls[0]!.url, 'https://api-staging.marram.dev/v1/auth/google/init');

    // No token on the pending record: the session claim happens on your server with the API key.
    const pending = stored('sk_9');
    assert.equal(pending.token, undefined);

    href = 'https://app.test/?sessionKey=sk_9';
    const backend = fakeFetch(json(200, { user: {} }));
    const finished = await finish({ url: '/finish', fetch: backend.fetch });
    assert.equal(finished?.ok, true);
    assert.equal(backend.calls[0]!.body.sessionKey, 'sk_9');
  });

  it('requires a token before any side effect', async () => {
    // @ts-expect-error token is required
    await assert.rejects(connect('google', {}), TypeError);
    assert.equal(storage.length, 0);
    assert.deepEqual(assigned, []);
  });
});

describe('send', () => {
  function fakeSend(...answers: Array<unknown>) {
    const payloads: Array<Record<string, unknown>> = [];
    const send = async (payload: Record<string, unknown>) => {
      payloads.push(payload);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    return { send, payloads };
  }

  it('finishes through your client with extra body fields', async () => {
    const verifier = await started({ sessionKey: 'sk_9', authorizationUrl: INIT.authorizationUrl });
    href = 'https://app.test/signed-in?sessionKey=sk_9';
    const { send, payloads } = fakeSend({ user: { id: 1 } });

    const result = await finish({ send, body: { via: 'menu', sessionKey: 'forged' } });

    assert.deepEqual(result, {
      ok: true,
      kind: 'session',
      provider: 'google',
      key: 'sk_9',
      data: { user: { id: 1 } },
      state: undefined,
    });
    assert.deepEqual(payloads[0], {
      via: 'menu',
      provider: 'google',
      sessionKey: 'sk_9',
      codeVerifier: verifier,
    });
    assert.equal(href, 'https://app.test/signed-in');
    assert.equal(storage.getItem('marram:pkce:sk_9'), null);
  });

  it('wraps an axios-style failure, keeping its status and body', async () => {
    await started();
    href = 'https://app.test/connected?status=connected';
    const thrown = Object.assign(new Error('Request failed'), {
      response: { status: 409, data: { error: 'already_claimed' } },
    });
    await assert.rejects(finish({ send: fakeSend(thrown).send }), (error: unknown) => {
      assert.ok(error instanceof MarramError);
      assert.equal(error.code, 'FINISH_FAILED');
      assert.equal(error.status, 409);
      assert.deepEqual(error.body, { error: 'already_claimed' });
      assert.equal(error.cause, thrown);
      return true;
    });
  });

  it('prefers status and body on the error itself', async () => {
    await started();
    href = 'https://app.test/connected?status=connected';
    const thrown = Object.assign(new Error('nope'), {
      status: 401,
      body: { error: 'expired' },
      response: { status: 500, data: 'ignored' },
    });
    await assert.rejects(finish({ send: fakeSend(thrown).send }), {
      code: 'FINISH_FAILED',
      status: 401,
      body: { error: 'expired' },
    });
  });

  it('uses null status and body when the failure carries neither', async () => {
    await started();
    href = 'https://app.test/connected?status=connected';
    await assert.rejects(finish({ send: fakeSend(new TypeError('offline')).send }), {
      code: 'FINISH_FAILED',
      status: null,
      body: null,
    });
  });

  it('passes on a MarramError your send threw, unwrapped', async () => {
    await started();
    href = 'https://app.test/connected?status=connected';
    const own = new MarramError('STORAGE_UNAVAILABLE', 'from send');
    await assert.rejects(
      finish({ send: fakeSend(own).send }),
      (error: unknown) => error === own,
    );
  });

  it('finish refuses url and send together, before any side effect', async () => {
    await started();
    href = 'https://app.test/connected?status=connected';
    const { send } = fakeSend();

    // @ts-expect-error url and send together
    await assert.rejects(finish({ url: '/finish', send }), TypeError);

    assert.equal(href, 'https://app.test/connected?status=connected');
    assert.ok(storage.getItem('marram:pkce:flow_123'));

    // A flow your server claims, finishing with no endpoint at all, is a TypeError too.
    await assert.rejects(finish(), TypeError);
  });
});
