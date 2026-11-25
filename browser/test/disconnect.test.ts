import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { MarramError, disconnect } from '../src/index.ts';

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

const headersOf = (call: Recorded | undefined) =>
  (call?.init.headers ?? {}) as Record<string, string>;

async function failure(promise: Promise<unknown>): Promise<MarramError> {
  const error = await promise.then(
    () => assert.fail('expected a rejection'),
    (cause: unknown) => cause,
  );
  assert.ok(error instanceof MarramError);
  assert.equal(error.code, 'DISCONNECT_FAILED');
  return error;
}

describe('disconnect', () => {
  it('DELETEs revoke with the token, and sends no user header or body', async () => {
    const { fetch, calls } = fakeFetch(json(200, { revoked: true }));

    await disconnect('google', { token: TOKEN, fetch });

    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? '', /\/connections\/google\/revoke$/);
    assert.equal(calls[0]?.init.method, 'DELETE');
    assert.equal(calls[0]?.init.body, undefined);
    assert.equal(headersOf(calls[0]).Authorization, `Bearer ${TOKEN}`);
    assert.equal(headersOf(calls[0])['x-marram-external-user-id'], undefined);
  });

  it('sends the integration key when given one, and calls a token function', async () => {
    const { fetch, calls } = fakeFetch(json(200, { revoked: true }));

    await disconnect('google', { token: async () => TOKEN, integrationKey: 'secondary', fetch });

    assert.equal(headersOf(calls[0]).Authorization, `Bearer ${TOKEN}`);
    assert.equal(headersOf(calls[0])['x-marram-integration-key'], 'secondary');
  });

  it('is a DISCONNECT_FAILED on a refusal, carrying the status and body', async () => {
    const { fetch } = fakeFetch(json(409, { error: 'used', code: 'CONNECT_TOKEN_REUSED' }));

    const error = await failure(disconnect('google', { token: TOKEN, fetch }));

    assert.equal(error.status, 409);
    assert.deepEqual(error.body, { error: 'used', code: 'CONNECT_TOKEN_REUSED' });
  });

  it('is a DISCONNECT_FAILED when Marram is unreachable or the token function fails', async () => {
    const { fetch } = fakeFetch(new Error('offline'));
    await failure(disconnect('google', { token: TOKEN, fetch }));

    const failing = async () => {
      throw new Error('no session');
    };
    await failure(disconnect('google', { token: failing, fetch }));
  });

  it('needs a provider and a token', async () => {
    await assert.rejects(disconnect('', { token: TOKEN }), TypeError);
    await assert.rejects(disconnect('google', { token: '' }), TypeError);
  });
});
