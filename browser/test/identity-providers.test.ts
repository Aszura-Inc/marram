import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { MarramError, listIdentityProviders } from '../src/index.ts';

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

const GOOGLE = {
  providerKey: 'google',
  name: 'Google',
  brandColors: [],
  brandImages: [],
  integrations: [{ integrationKey: 'google-main', label: 'Google' }],
};

const authorization = (call: Recorded | undefined) =>
  (call?.init.headers as Record<string, string> | undefined)?.Authorization;

async function listFailure(promise: Promise<unknown>): Promise<MarramError> {
  const error = await promise.then(
    () => assert.fail('expected a rejection'),
    (cause: unknown) => cause,
  );
  assert.ok(error instanceof MarramError);
  assert.equal(error.code, 'LIST_FAILED');
  return error;
}

describe('listIdentityProviders', () => {
  it('GETs the sign-in list with the token and resolves the array', async () => {
    const { fetch, calls } = fakeFetch(json(200, { identityProviders: [GOOGLE] }));

    const providers = await listIdentityProviders({ token: TOKEN, fetch });

    assert.deepEqual(providers, [GOOGLE]);
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? '', /\/environment\/identity-providers$/);
    assert.equal(calls[0]?.init.method, 'GET');
    assert.equal(authorization(calls[0]), `Bearer ${TOKEN}`);
  });

  it('calls a token function', async () => {
    const { fetch, calls } = fakeFetch(json(200, { identityProviders: [] }));

    await listIdentityProviders({ token: async () => TOKEN, fetch });

    assert.equal(authorization(calls[0]), `Bearer ${TOKEN}`);
  });

  it('is a LIST_FAILED on a refusal, carrying the status and body', async () => {
    const { fetch } = fakeFetch(json(403, { error: 'no', code: 'CONNECT_TOKEN_WRONG_USE' }));

    const error = await listFailure(listIdentityProviders({ token: TOKEN, fetch }));

    assert.equal(error.status, 403);
    assert.deepEqual(error.body, { error: 'no', code: 'CONNECT_TOKEN_WRONG_USE' });
  });

  it('is a LIST_FAILED when Marram is unreachable', async () => {
    const { fetch } = fakeFetch(new Error('offline'));

    await listFailure(listIdentityProviders({ token: TOKEN, fetch }));
  });

  it("is a LIST_FAILED when the answer isn't the identityProviders list", async () => {
    const { fetch } = fakeFetch(json(200, { providers: [GOOGLE] }));

    const error = await listFailure(listIdentityProviders({ token: TOKEN, fetch }));

    assert.match(error.message, /identityProviders/);
  });
});
