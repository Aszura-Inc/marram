import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { Marram, MarramError, createPkce, parseConnectionRedirect } from '../src/index.ts';

interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

// A fetch that records every request and answers from a queue.
function fakeFetch(...responses: Response[]) {
  const calls: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: new Headers(init?.headers),
      body,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('fakeFetch: no response queued');
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const client = (fetch: typeof globalThis.fetch) =>
  new Marram({ apiKey: 'sk_test_01ENV', environment: 'staging', fetch });

const pkce = { codeChallenge: 'challenge', codeChallengeMethod: 'S256' } as const;

describe('client', () => {
  it('requires an API key', () => {
    assert.throws(() => new Marram({ apiKey: '  ' }), /apiKey/);
  });

  it('defaults to production and accepts a base URL override', () => {
    assert.equal(new Marram({ apiKey: 'k' }).baseUrl, 'https://api.marram.dev/v1');
    assert.equal(
      new Marram({ apiKey: 'k', baseUrl: 'http://localhost:8787/v1/' }).baseUrl,
      'http://localhost:8787/v1',
    );
  });

  it('connections.init posts the body with the API key and integration key', async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { flowId: 'flow_1', authorizationUrl: 'https://provider/auth' }),
    );
    const result = await client(fetch).connections.init(
      'google-calendar',
      { auth: 'oAuth2', redirectUrl: 'https://app.test/back', externalUserId: 'user-1', ...pkce },
      { integrationKey: 'primary' },
    );

    assert.deepEqual(result, { flowId: 'flow_1', authorizationUrl: 'https://provider/auth' });
    const [call] = calls;
    assert.equal(call!.method, 'POST');
    assert.equal(call!.url, 'https://api-staging.marram.dev/v1/connections/google-calendar/init');
    assert.equal(call!.headers.get('authorization'), 'Bearer sk_test_01ENV');
    assert.equal(call!.headers.get('x-marram-integration-key'), 'primary');
    assert.equal(call!.headers.get('content-type'), 'application/json');
    assert.deepEqual(call!.body, {
      auth: 'oAuth2',
      redirectUrl: 'https://app.test/back',
      externalUserId: 'user-1',
      ...pkce,
    });
  });

  it('omits headers that were not given', async () => {
    const { fetch, calls } = fakeFetch(json(200, { flowId: 'f', authorizationUrl: 'u' }));
    await client(fetch).connections.init('google', {
      auth: 'oAuth2',
      redirectUrl: 'https://x.test',
      externalUserId: 'user-1',
      ...pkce,
    });
    assert.equal(calls[0]!.headers.has('x-marram-integration-key'), false);
  });

  it('the user travels in headers, never the body', async () => {
    const connection = {
      externalUserId: 'user-1',
      providerKey: 'google',
      integrationKey: 'primary',
      authType: 'oAuth2',
      status: 'active',
      createdAt: '2026-10-21T00:00:00Z',
      updatedAt: '2026-10-21T00:00:00Z',
    };
    const { fetch, calls } = fakeFetch(
      json(200, { connection }),
      json(200, { revoked: true }),
      json(200, { session: { ...connection, sessionKey: 'sk' } }),
    );
    const marram = client(fetch);

    assert.deepEqual(await marram.connections.refresh('google', 'user-1'), connection);
    await marram.connections.revoke('google', 'user-1');
    await marram.sessions.refresh('google', 'sk');

    assert.equal(calls[0]!.url.endsWith('/connections/google/refresh'), true);
    assert.equal(calls[0]!.headers.get('x-marram-external-user-id'), 'user-1');
    assert.equal(calls[0]!.body, undefined);
    assert.equal(calls[1]!.method, 'DELETE');
    assert.equal(calls[1]!.headers.get('x-marram-external-user-id'), 'user-1');
    assert.equal(calls[2]!.url.endsWith('/auth/google/refresh'), true);
    assert.equal(calls[2]!.headers.get('x-marram-session-key'), 'sk');
  });

  it('connections.get and sessions.get read one record by its header', async () => {
    const connection = {
      externalUserId: 'user-1',
      providerKey: 'google',
      integrationKey: 'primary',
      authType: 'oAuth2',
      status: 'active',
      createdAt: '2026-10-21T00:00:00Z',
      updatedAt: '2026-10-21T00:00:00Z',
    };
    const session = { ...connection, sessionKey: 'sk' };
    const { fetch, calls } = fakeFetch(json(200, { connection }), json(200, { session }));
    const marram = client(fetch);

    const options = { integrationKey: 'primary' };
    assert.deepEqual(await marram.connections.get('google', 'user-1', options), connection);
    assert.deepEqual(await marram.sessions.get('google', 'sk'), session);

    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.url.endsWith('/connections/google/connection'), true);
    assert.equal(calls[0]!.headers.get('x-marram-external-user-id'), 'user-1');
    assert.equal(calls[0]!.headers.get('x-marram-integration-key'), 'primary');
    assert.equal(calls[1]!.method, 'GET');
    assert.equal(calls[1]!.url.endsWith('/auth/google/session'), true);
    assert.equal(calls[1]!.headers.get('x-marram-session-key'), 'sk');
  });

  it('connections.claim sends the flowId, verifier and claimCode in the body, and returns the connection', async () => {
    const connection = {
      externalUserId: 'user-1',
      providerKey: 'google',
      integrationKey: 'primary',
      authType: 'oAuth2',
      status: 'active',
      createdAt: '2026-10-21T00:00:00Z',
      updatedAt: '2026-10-21T00:00:00Z',
    };
    const { fetch, calls } = fakeFetch(json(200, { connection, jti: null }));
    const result = await client(fetch).connections.claim('google', 'flow_1', 'verifier', 'cc_1');

    assert.deepEqual(result, connection);
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.url, 'https://api-staging.marram.dev/v1/connections/google/claim');
    assert.deepEqual(calls[0]!.body, {
      flowId: 'flow_1',
      codeVerifier: 'verifier',
      claimCode: 'cc_1',
    });
  });

  it('connections.claim surfaces a verifier mismatch as a MarramError', async () => {
    const { fetch } = fakeFetch(
      json(403, { error: "The codeVerifier doesn't match.", code: 'CODE_VERIFIER_MISMATCH' }, {
        'x-marram-error-code': 'CODE_VERIFIER_MISMATCH',
      }),
    );
    await assert.rejects(
      client(fetch).connections.claim('google', 'flow_1', 'wrong', 'cc_1'),
      (error: unknown) => error instanceof MarramError && error.code === 'CODE_VERIFIER_MISMATCH',
    );
  });

  it('sessions.claim sends the session key as a header, the verifier and claimCode in the body', async () => {
    const { fetch, calls } = fakeFetch(json(200, { user: { email: 'a@b.test' }, raw: {} }));
    const user = await client(fetch).sessions.claim('google', 'sk', 'verifier', 'cc_2');
    assert.deepEqual(user.user, { email: 'a@b.test' });
    assert.equal(calls[0]!.headers.get('x-marram-session-key'), 'sk');
    assert.deepEqual(calls[0]!.body, { codeVerifier: 'verifier', claimCode: 'cc_2' });
  });

  it('encodes path segments so a key cannot change the route', async () => {
    const { fetch, calls } = fakeFetch(
      json(200, {
        webhook: { webhookKey: 'a/b', status: 'active', createdAt: 'x', updatedAt: 'x' },
      }),
    );
    await client(fetch).webhooks.get('trello', 'a/b', { externalUserId: 'user-1' });
    assert.equal(calls[0]!.url, 'https://api-staging.marram.dev/v1/webhooks/trello/a%2Fb');
  });

  it('turns a Marram error into MarramError with its code and request id', async () => {
    const { fetch } = fakeFetch(
      json(
        401,
        { error: 'Your API key has expired.', code: 'API_KEY_EXPIRED' },
        { 'x-marram-error-code': 'API_KEY_EXPIRED', 'x-marram-request-id': 'req_1' },
      ),
    );
    await assert.rejects(client(fetch).environment.integrations(), (error: unknown) => {
      assert.ok(error instanceof MarramError);
      assert.equal(error.code, 'API_KEY_EXPIRED');
      assert.equal(error.status, 401);
      assert.equal(error.requestId, 'req_1');
      return true;
    });
  });
});

describe('proxy', () => {
  it('relays a provider error instead of throwing', async () => {
    const { fetch, calls } = fakeFetch(json(404, { error: 'board not found' }));
    const response = await client(fetch).proxy.fetch('trello', '/1/boards/abc', {
      externalUserId: 'user-1',
      query: { fields: 'name' },
      headers: { Accept: 'application/json' },
      version: '1',
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'board not found' });
    assert.equal(
      calls[0]!.url,
      'https://api-staging.marram.dev/v1/proxy/trello/1/boards/abc?fields=name',
    );
    assert.equal(calls[0]!.headers.get('accept'), 'application/json');
    assert.equal(calls[0]!.headers.get('x-marram-version'), '1');
  });

  it("throws on Marram's own refusal, marked by x-marram-error-code", async () => {
    const { fetch } = fakeFetch(
      json(404, { error: 'No such connection.', code: 'CONNECTION_NOT_FOUND' }, {
        'x-marram-error-code': 'CONNECTION_NOT_FOUND',
      }),
    );
    await assert.rejects(
      client(fetch).proxy.fetch('trello', '1/boards/abc', { externalUserId: 'user-1' }),
      (error: unknown) => error instanceof MarramError && error.code === 'CONNECTION_NOT_FOUND',
    );
  });

  it('drops caller x-marram-* headers, whatever their case', async () => {
    const { fetch, calls } = fakeFetch(json(200, {}));
    await client(fetch).proxy.fetch('trello', '1/me', {
      externalUserId: 'right',
      headers: {
        'X-Marram-External-User-Id': 'wrong',
        'X-Marram-Callback-Url': 'https://evil.test',
        Accept: 'application/json',
      },
    });
    assert.equal(calls[0]!.headers.get('x-marram-external-user-id'), 'right');
    assert.equal(calls[0]!.headers.has('x-marram-callback-url'), false);
    assert.equal(calls[0]!.headers.get('accept'), 'application/json');
  });

  it('enqueue sends the callback URL and returns the request id', async () => {
    const { fetch, calls } = fakeFetch(json(202, { requestId: 'req_9' }));
    const result = await client(fetch).proxy.enqueue('trello', '1/boards', {
      externalUserId: 'user-1',
      method: 'POST',
      body: { name: 'New' },
      callbackUrl: 'https://app.test/callback',
    });
    assert.deepEqual(result, { requestId: 'req_9' });
    assert.equal(calls[0]!.headers.get('x-marram-callback-url'), 'https://app.test/callback');
    assert.deepEqual(calls[0]!.body, { name: 'New' });
  });

  it('rejects an empty or traversing path before any request', async () => {
    const { fetch, calls } = fakeFetch();
    const marram = client(fetch);
    await assert.rejects(
      marram.proxy.fetch('trello', '/', { externalUserId: 'user-1' }),
      TypeError,
    );
    await assert.rejects(
      marram.proxy.fetch('trello', '1/../admin', { externalUserId: 'user-1' }),
      TypeError,
    );
    assert.equal(calls.length, 0);
  });
});

describe('helpers', () => {
  it('createPkce returns an S256 challenge of the verifier', async () => {
    const pkce = await createPkce();
    const expected = createHash('sha256').update(pkce.codeVerifier).digest('base64url');
    assert.equal(pkce.codeChallenge, expected);
    assert.equal(pkce.codeChallengeMethod, 'S256');
    assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  });

  it('parseConnectionRedirect reads success and failure', () => {
    assert.deepEqual(
      parseConnectionRedirect('https://app.test/back?status=connected&claimCode=cc_1'),
      { ok: true, claimCode: 'cc_1' },
    );
    // The claim can't run without the code, so a redirect missing it is not a success.
    assert.deepEqual(parseConnectionRedirect('https://app.test/back?status=connected'), {
      ok: false,
      error: 'missing_claim_code',
      errorMessage: null,
    });
    assert.deepEqual(
      parseConnectionRedirect('https://app.test/back?error=auth_error&error_message=Denied'),
      { ok: false, error: 'auth_error', errorMessage: 'Denied' },
    );
    assert.deepEqual(parseConnectionRedirect('https://app.test/back'), {
      ok: false,
      error: 'missing_status',
      errorMessage: null,
    });
  });
});
