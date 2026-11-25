import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { MarramError, setUpWebhook } from '../src/index.ts';

interface Recorded {
  url: string;
  init: RequestInit;
}

function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (next === undefined) throw new Error('fakeFetch: nothing queued');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TOKEN = 'eyJ.eyJ.sig';
const REDIRECT = 'https://app.example.com/webhooks/done';

const INIT = {
  success: true,
  sessionId: 'ses_123',
  webhookKey: 'wh_abc',
  setupUrl: 'https://setup.marram.dev/webhooks/ses_123',
  ingressUrl: 'https://in.marram.dev/wh_abc',
  status: 'pending',
  fields: [],
};

const headersOf = (call: Recorded | undefined) =>
  (call?.init.headers ?? {}) as Record<string, string>;

async function failure(promise: Promise<unknown>, code = 'START_FAILED'): Promise<MarramError> {
  const error = await promise.then(
    () => assert.fail('expected a rejection'),
    (cause: unknown) => cause,
  );
  assert.ok(error instanceof MarramError);
  assert.equal(error.code, code);
  return error;
}

describe('setUpWebhook', () => {
  it('POSTs webhook init with the token and redirectUrl, and no key or metadata header', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));

    await setUpWebhook('stripe', {
      token: TOKEN,
      redirectUrl: REDIRECT,
      baseUrl: 'https://api.marram.test/v1/',
      navigate: false,
      fetch,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.marram.test/v1/webhooks/stripe/init');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { redirectUrl: REDIRECT });
    const headers = headersOf(calls[0]);
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(headers['x-marram-webhook-key'], undefined);
    assert.equal(headers['x-marram-metadata'], undefined);
    assert.equal(headers['x-marram-external-user-id'], undefined);
    assert.equal(headers['x-marram-integration-key'], undefined);
  });

  it('sends the integration key, and uses the base URL a token function returns', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));

    await setUpWebhook('stripe', {
      token: async () => ({ token: TOKEN, baseUrl: 'https://api-staging.marram.dev/v1' }),
      integrationKey: 'secondary',
      redirectUrl: REDIRECT,
      navigate: false,
      fetch,
    });

    assert.match(calls[0]?.url ?? '', /^https:\/\/api-staging\.marram\.dev\/v1\/webhooks\//);
    assert.equal(headersOf(calls[0]).Authorization, `Bearer ${TOKEN}`);
    assert.equal(headersOf(calls[0])['x-marram-integration-key'], 'secondary');
  });

  it('navigates to setupUrl and resolves with the key and URLs', async () => {
    const { fetch } = fakeFetch(json(200, INIT));
    const visited: string[] = [];

    const result = await setUpWebhook('stripe', {
      token: TOKEN,
      redirectUrl: REDIRECT,
      navigate: (url) => visited.push(url),
      fetch,
    });

    assert.deepEqual(visited, [INIT.setupUrl]);
    assert.deepEqual(result, {
      webhookKey: INIT.webhookKey,
      setupUrl: INIT.setupUrl,
      ingressUrl: INIT.ingressUrl,
    });
  });

  it('is a START_FAILED carrying Marram’s code on a refusal', async () => {
    for (const [status, code] of [
      [404, 'CONNECTION_NOT_FOUND'],
      [410, 'CONNECTION_REVOKED'],
      [409, 'CONNECT_TOKEN_REUSED'],
      [403, 'REDIRECT_URL_NOT_ALLOWED'],
    ] as const) {
      const { fetch } = fakeFetch(json(status, { error: 'refused', code }));
      const error = await failure(
        setUpWebhook('stripe', { token: TOKEN, redirectUrl: REDIRECT, navigate: false, fetch }),
      );
      assert.equal(error.status, status);
      assert.equal(error.apiCode, code);
      assert.match(error.message, new RegExp(code));
    }
  });

  it('is a START_FAILED when Marram is unreachable or the token function fails', async () => {
    const { fetch } = fakeFetch(new Error('offline'));
    await failure(setUpWebhook('stripe', { token: TOKEN, redirectUrl: REDIRECT, fetch }));

    const failing = async () => {
      throw new Error('no session');
    };
    await failure(setUpWebhook('stripe', { token: failing, redirectUrl: REDIRECT, fetch }));
  });

  it('refuses a setupUrl that isn’t http(s), without navigating', async () => {
    const { fetch } = fakeFetch(json(200, { ...INIT, setupUrl: 'javascript:alert(1)' }));
    const visited: string[] = [];

    await failure(
      setUpWebhook('stripe', {
        token: TOKEN,
        redirectUrl: REDIRECT,
        navigate: (url) => visited.push(url),
        fetch,
      }),
      'INVALID_START_RESPONSE',
    );
    assert.deepEqual(visited, []);
  });

  it('needs a provider and a token', async () => {
    await assert.rejects(setUpWebhook('', { token: TOKEN }), TypeError);
    await assert.rejects(setUpWebhook('stripe', { token: '' }), TypeError);
  });
});
