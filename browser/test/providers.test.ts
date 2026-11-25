import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { MarramError, connect, listProviders } from '../src/index.ts';

// Fake browser globals, as in flow.test.ts — connect writes sessionStorage and navigates.

let storage: Map<string, string>;

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  storage = new Map();
  setGlobal('sessionStorage', {
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  setGlobal('location', { href: 'https://app.test/', assign: () => {} });
});

interface Recorded {
  url: string;
  init: RequestInit;
}

/** Records every call without reading the body: the list is a GET. */
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
  integrations: [
    {
      integrationKey: 'google-main',
      label: 'Google Calendar',
      authTypes: ['oAuth2'],
      connected: false,
      connectionStatus: null,
    },
  ],
};

describe('listProviders', () => {
  it('GETs the list with the token and resolves the array', async () => {
    const { fetch, calls } = fakeFetch(json(200, { providers: [GOOGLE] }));

    const providers = await listProviders({ token: TOKEN, fetch });

    assert.deepEqual(providers, [GOOGLE]);
    assert.equal(calls[0]!.url, 'https://api.marram.dev/v1/environment/providers');
    assert.equal(calls[0]!.init.method, 'GET');
    assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(calls[0]!.init.body, undefined);
  });

  it('fetches the token first, and takes its base URL over the options', async () => {
    const { fetch, calls } = fakeFetch(json(200, { providers: [] }));
    let minted = 0;

    const providers = await listProviders({
      token: async () => {
        minted += 1;
        return { token: TOKEN, baseUrl: 'https://api.test/v1/' };
      },
      environment: 'staging',
      fetch,
    });

    assert.equal(minted, 1);
    assert.deepEqual(providers, []);
    assert.equal(calls[0]!.url, 'https://api.test/v1/environment/providers');
  });

  it('is a LIST_FAILED with status and body when Marram refuses', async () => {
    const { fetch } = fakeFetch(json(401, { error: 'nope', code: 'CONNECT_TOKEN_EXPIRED' }));

    await assert.rejects(listProviders({ token: TOKEN, fetch }), (error: unknown) => {
      assert.ok(error instanceof MarramError);
      assert.equal(error.code, 'LIST_FAILED');
      assert.equal(error.status, 401);
      assert.deepEqual(error.body, { error: 'nope', code: 'CONNECT_TOKEN_EXPIRED' });
      return true;
    });
  });

  it('is a LIST_FAILED when Marram is unreachable, or answers without providers', async () => {
    await assert.rejects(
      listProviders({ token: TOKEN, fetch: fakeFetch(new Error('offline')).fetch }),
      (error: unknown) =>
        error instanceof MarramError && error.code === 'LIST_FAILED' && error.status === null,
    );
    await assert.rejects(
      listProviders({ token: TOKEN, fetch: fakeFetch(json(200, { ok: true })).fetch }),
      (error: unknown) => error instanceof MarramError && error.code === 'LIST_FAILED',
    );
  });

  it('is a LIST_FAILED, not a START_FAILED, when the token function fails', async () => {
    const { fetch, calls } = fakeFetch();
    const thrown = Object.assign(new Error('401'), { response: { status: 401, data: 'login' } });

    await assert.rejects(
      listProviders({ token: () => Promise.reject(thrown), fetch }),
      (error: unknown) => {
        assert.ok(error instanceof MarramError);
        assert.equal(error.code, 'LIST_FAILED');
        assert.equal(error.status, 401);
        assert.equal(error.body, 'login');
        assert.equal(error.cause, thrown);
        return true;
      },
    );
    await assert.rejects(
      listProviders({ token: () => '', fetch }),
      (error: unknown) => error instanceof MarramError && error.code === 'LIST_FAILED',
    );
    assert.equal(calls.length, 0);
  });

  it('needs a token, before any call', async () => {
    const { fetch, calls } = fakeFetch();
    await assert.rejects(listProviders({ token: '', fetch }), TypeError);
    assert.equal(calls.length, 0);
  });
});

describe('connect with an integrationKey', () => {
  const INIT = { flowId: 'flow_1', authorizationUrl: 'https://provider.test/consent' };

  it('sends it as x-marram-integration-key', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));

    await connect('google', { token: TOKEN, integrationKey: 'google-main', auth: 'oAuth2', fetch });

    const headers = new Headers(calls[0]!.init.headers);
    assert.equal(headers.get('x-marram-integration-key'), 'google-main');
    assert.equal(JSON.parse(String(calls[0]!.init.body)).auth, 'oAuth2');
  });

  it('sends no header without one', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));

    await connect('google', { token: TOKEN, fetch });

    assert.equal(new Headers(calls[0]!.init.headers).has('x-marram-integration-key'), false);
  });
});
