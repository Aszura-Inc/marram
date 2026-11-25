import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  MarramButton,
  useMarramFinish,
  useMarramIdentityProviders,
  useMarramProviders,
  useMarramStart,
  type UseMarramFinish,
  type UseMarramIdentityProviders,
  type UseMarramProviders,
  type UseMarramStart,
} from '../src/react.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Fake browser globals, as in flow.test.ts.

let storage: Map<string, string>;
let href: string;
let assigned: string[];

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  storage = new Map();
  href = 'https://app.test/';
  assigned = [];
  setGlobal('sessionStorage', {
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  setGlobal('location', {
    get href() {
      return href;
    },
    assign: (url: string) => assigned.push(url),
  });
  setGlobal('history', {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => {
      href = url;
    },
  });
});

function fakeFetch(...responses: Response[]) {
  const calls: Array<Record<string, unknown>> = [];
  const fetch = async (_input: string | URL | Request, init: RequestInit = {}) => {
    calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const next = responses.shift();
    if (next === undefined) throw new Error('fakeFetch: nothing queued');
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const INIT = { flowId: 'flow_1', authorizationUrl: 'https://provider.test/consent' };

async function renderHook<T>(useHook: () => T) {
  const latest: { current: T | undefined } = { current: undefined };
  function Probe(): null {
    latest.current = useHook();
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  // New element each time; React skips an identical one.
  const element = (): ReactElement => createElement(Probe);
  await act(async () => {
    renderer = create(element());
  });
  return {
    latest,
    rerender: async (next: () => T) => {
      useHook = next;
      await act(async () => renderer!.update(element()));
    },
  };
}

describe('useMarramStart', () => {
  it('starts the flow for a provider and stays pending while the page leaves', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));
    const { latest } = await renderHook(() => useMarramStart({ token: 'tok', fetch }));

    await act(async () => {
      await latest.current!.start('google', { state: 'settings', body: { field: 'k' } });
    });

    assert.deepEqual(assigned, [INIT.authorizationUrl]);
    assert.equal(calls[0]!.field, 'k');
    assert.equal(latest.current!.pending, true);
    assert.equal(latest.current!.error, null);
    const pending = JSON.parse(storage.get('marram:pkce:flow_1')!) as Record<string, unknown>;
    assert.equal(pending.provider, 'google');
    assert.equal(pending.state, 'settings');
  });

  it('reports a failure through error and onError, and clears pending', async () => {
    const { fetch } = fakeFetch(json(500, {}));
    const seen: unknown[] = [];
    const { latest } = await renderHook<UseMarramStart>(() =>
      useMarramStart({ token: 'tok', fetch, onError: (e) => seen.push(e) }),
    );

    let result: unknown = 'unset';
    await act(async () => {
      result = await latest.current!.start('google');
    });

    assert.equal(result, undefined);
    assert.equal(latest.current!.pending, false);
    assert.equal((latest.current!.error as { code: string }).code, 'START_FAILED');
    assert.equal(seen.length, 1);
  });

  it('hands the token function the click’s provider and extras', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));
    const asked: unknown[] = [];
    const { latest } = await renderHook(() =>
      useMarramStart({
        token: async (provider, extras) => {
          asked.push({ provider, redirectUrl: extras.redirectUrl });
          return 'tok';
        },
        navigate: false,
        fetch,
      }),
    );

    await act(async () => {
      await latest.current!.start('google', { redirectUrl: 'https://app.test/back', auth: 'basic' });
    });

    assert.deepEqual(asked, [{ provider: 'google', redirectUrl: 'https://app.test/back' }]);
    assert.equal(calls[0]!.redirectUrl, 'https://app.test/back');
    assert.equal(calls[0]!.auth, 'basic');
    assert.equal(latest.current!.pending, false);
  });

  it('runs a sign-in with flow: signIn, keeping no token', async () => {
    const { fetch } = fakeFetch(
      json(200, { sessionKey: 'sk_1', authorizationUrl: INIT.authorizationUrl }),
    );
    const { latest } = await renderHook(() =>
      useMarramStart({ token: 'tok', flow: 'signIn', fetch }),
    );

    await act(async () => {
      await latest.current!.start('google');
    });

    const pending = JSON.parse(storage.get('marram:pkce:sk_1')!) as Record<string, unknown>;
    assert.equal(pending.kind, 'session');
    assert.equal('token' in pending, false);
  });

  it('passes claim through to the flow', async () => {
    const { fetch } = fakeFetch(json(200, INIT));
    const { latest } = await renderHook(() =>
      useMarramStart({ token: 'tok', claim: 'server', fetch }),
    );

    await act(async () => {
      await latest.current!.start('google');
    });

    assert.equal('token' in (JSON.parse(storage.get('marram:pkce:flow_1')!) as object), false);
  });

  it('sends the click’s integrationKey as a header', async () => {
    const seen: string[] = [];
    const fetch = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers).get('x-marram-integration-key') ?? '');
      return json(200, INIT);
    }) as typeof globalThis.fetch;
    const { latest } = await renderHook(() =>
      useMarramStart({ token: 'tok', navigate: false, fetch }),
    );

    await act(async () => {
      await latest.current!.start('google', { integrationKey: 'google-main' });
    });

    assert.deepEqual(seen, ['google-main']);
  });
});

describe('useMarramIdentityProviders', () => {
  it('loads the sign-in list once on mount', async () => {
    const urls: string[] = [];
    const google = {
      providerKey: 'google',
      name: 'Google',
      brandColors: [],
      brandImages: [],
      integrations: [{ integrationKey: 'google-main', label: 'Google' }],
    };
    const fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ identityProviders: [google] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const useInline = () => useMarramIdentityProviders({ token: 'tok', fetch });

    const hook = await renderHook<UseMarramIdentityProviders>(useInline);
    await hook.rerender(useInline);

    assert.deepEqual(hook.latest.current?.providers, [google]);
    assert.equal(hook.latest.current?.loading, false);
    assert.equal(urls.length, 1);
    assert.match(urls[0] ?? '', /\/environment\/identity-providers$/);
  });
});

describe('useMarramProviders', () => {
  const GOOGLE = {
    providerKey: 'google',
    name: 'Google',
    brandColors: [],
    brandImages: [],
    integrations: [
      {
        integrationKey: 'google-main',
        label: 'Google',
        authTypes: ['oAuth2'],
        connected: false,
        connectionStatus: null,
      },
    ],
  };

  function fakeList(...responses: Response[]) {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      const next = responses.shift();
      if (next === undefined) throw new Error('fakeList: nothing queued');
      return next;
    }) as typeof globalThis.fetch;
    return { fetch, calls: () => calls };
  }

  it('loads once on mount, though options change every render, and reloads on demand', async () => {
    const connected = { ...GOOGLE, integrations: [{ ...GOOGLE.integrations[0], connected: true }] };
    const { fetch, calls } = fakeList(
      json(200, { providers: [GOOGLE] }),
      json(200, { providers: [connected] }),
    );
    // A new options object each render, as an inline literal would be.
    const useInline = () => useMarramProviders({ token: 'tok', fetch });

    const hook = await renderHook<UseMarramProviders>(useInline);
    await hook.rerender(useInline);
    await hook.rerender(useInline);

    assert.equal(calls(), 1);
    assert.equal(hook.latest.current!.loading, false);
    assert.deepEqual(hook.latest.current!.providers, [GOOGLE]);
    assert.equal(hook.latest.current!.error, null);

    await act(async () => {
      await hook.latest.current!.reload();
    });

    assert.equal(calls(), 2);
    assert.deepEqual(hook.latest.current!.providers, [connected]);
  });

  it('reports a failure as LIST_FAILED, keeping the last list', async () => {
    const { fetch } = fakeList(json(200, { providers: [GOOGLE] }), json(500, {}));
    const hook = await renderHook<UseMarramProviders>(() =>
      useMarramProviders({ token: 'tok', fetch }),
    );

    await act(async () => {
      await hook.latest.current!.reload();
    });

    assert.equal(hook.latest.current!.loading, false);
    assert.equal((hook.latest.current!.error as { code: string }).code, 'LIST_FAILED');
    assert.deepEqual(hook.latest.current!.providers, [GOOGLE]);
  });

  it('waits while enabled is false', async () => {
    const { fetch, calls } = fakeList(json(200, { providers: [] }));
    const hook = await renderHook<UseMarramProviders>(() =>
      useMarramProviders({ token: 'tok', fetch, enabled: false }),
    );
    assert.equal(calls(), 0);
    assert.equal(hook.latest.current!.loading, false);

    await hook.rerender(() => useMarramProviders({ token: 'tok', fetch, enabled: true }));
    assert.equal(calls(), 1);
    assert.deepEqual(hook.latest.current!.providers, []);
  });
});

describe('useMarramFinish', () => {
  async function startedFlow(state?: unknown) {
    const { fetch } = fakeFetch(json(200, INIT));
    const { latest } = await renderHook(() =>
      useMarramStart({ token: 'tok', claim: 'server', fetch }),
    );
    await act(async () => {
      await latest.current!.start('google', { state });
    });
  }

  // react-test-renderer doesn't replay effects, so the StrictMode guard isn't tested here.
  it('claims the redirect and reports the result with its state', async () => {
    await startedFlow({ tab: 'apps' });
    href = 'https://app.test/connected?status=connected';
    const { fetch, calls } = fakeFetch(json(200, { connected: true }));

    const { latest } = await renderHook<UseMarramFinish<{ connected: boolean }, { tab: string }>>(
      () => useMarramFinish({ url: '/finish', fetch }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.provider, 'google');
    assert.equal(latest.current!.loading, false);
    assert.deepEqual(latest.current!.result, {
      ok: true,
      kind: 'connection',
      provider: 'google',
      key: 'flow_1',
      data: { connected: true },
      state: { tab: 'apps' },
    });
  });

  it('settles to null on an ordinary visit', async () => {
    const { fetch, calls } = fakeFetch();
    const { latest } = await renderHook(() => useMarramFinish({ url: '/finish', fetch }));
    assert.equal(calls.length, 0);
    assert.deepEqual(latest.current, { loading: false, result: null, error: null });
  });

  it('surfaces a missing verifier as error', async () => {
    href = 'https://app.test/connected?status=connected';
    const { latest } = await renderHook(() =>
      useMarramFinish({ url: '/finish', fetch: fakeFetch().fetch }),
    );
    assert.equal((latest.current!.error as { code: string }).code, 'VERIFIER_NOT_FOUND');
  });

  it('waits while enabled is false', async () => {
    await startedFlow();
    href = 'https://app.test/connected?status=connected';
    const { fetch, calls } = fakeFetch(json(200, {}));

    const hook = await renderHook(() =>
      useMarramFinish({ url: '/finish', fetch, enabled: false }),
    );
    assert.equal(calls.length, 0);

    await hook.rerender(() => useMarramFinish({ url: '/finish', fetch, enabled: true }));
    assert.equal(calls.length, 1);
    assert.equal(hook.latest.current!.result?.ok, true);
  });

  it('lets a router clean the URL', async () => {
    await startedFlow();
    href = 'https://app.test/connected?status=connected&tab=apps';
    const { fetch } = fakeFetch(json(200, {}));
    const replaced: string[] = [];

    await renderHook(() =>
      useMarramFinish({ url: '/finish', fetch, cleanUrl: (path) => replaced.push(path) }),
    );

    assert.deepEqual(replaced, ['/connected?tab=apps']);
    assert.equal(href, 'https://app.test/connected?status=connected&tab=apps');
  });

  it('claims through send with extra body, once, though send changes every render', async () => {
    await startedFlow();
    href = 'https://app.test/connected?status=connected';
    const payloads: Array<Record<string, unknown>> = [];
    // A new function each render, as an inline arrow would be.
    const useInline = () =>
      useMarramFinish({
        send: async (p) => (payloads.push(p), { connected: true }),
        body: { via: 'settings' },
      });

    const hook = await renderHook(useInline);
    await hook.rerender(useInline);
    await hook.rerender(useInline);

    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]!.via, 'settings');
    assert.equal(payloads[0]!.provider, 'google');
    assert.equal(payloads[0]!.flowId, 'flow_1');
    assert.equal(hook.latest.current!.result?.ok, true);
  });
});

describe('MarramButton', () => {
  const click = (renderer: ReactTestRenderer, defaultPrevented = false) =>
    act(async () => {
      renderer.root.findByType('button').props.onClick({ defaultPrevented });
    });

  it('starts on click with its provider, state and body, then shows busy', async () => {
    const { fetch, calls } = fakeFetch(json(200, INIT));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          MarramButton,
          {
            token: 'tok',
            fetch,
            provider: 'google',
            state: 'settings',
            body: { x: 1 },
            integrationKey: 'google-main',
          },
          'Go',
        ),
      );
    });

    const before = renderer.root.findByType('button').props;
    assert.equal(before.type, 'button');
    assert.equal(before.disabled, false);
    for (const name of [
      'token',
      'flow',
      'claim',
      'fetch',
      'provider',
      'state',
      'body',
      'integrationKey',
    ]) {
      assert.equal(name in before, false, name);
    }

    await click(renderer);

    assert.equal(calls[0]!.x, 1);
    assert.deepEqual(assigned, [INIT.authorizationUrl]);
    assert.equal(
      (JSON.parse(storage.get('marram:pkce:flow_1')!) as { state: unknown }).state,
      'settings',
    );
    const after = renderer.root.findByType('button').props;
    assert.equal(after.disabled, true);
    assert.equal(after['aria-busy'], true);
  });

  it('calls onError and re-enables on failure', async () => {
    const { fetch } = fakeFetch(json(403, {}));
    const seen: unknown[] = [];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(MarramButton, {
          token: 'tok',
          fetch,
          provider: 'google',
          onError: (e) => seen.push(e),
        }),
      );
    });

    await click(renderer);

    assert.equal((seen[0] as { code: string }).code, 'START_FAILED');
    assert.equal(renderer.root.findByType('button').props.disabled, false);
  });

  it('fetches its token on click, not before', async () => {
    const { fetch } = fakeFetch(json(200, INIT));
    let minted = 0;
    const token = async () => {
      minted += 1;
      return 'tok';
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(MarramButton, { token, fetch, provider: 'google' }));
    });

    assert.equal(minted, 0);
    await click(renderer);
    assert.equal(minted, 1);
    assert.deepEqual(assigned, [INIT.authorizationUrl]);
  });

  it('sends its integrationKey as a header, not to the button', async () => {
    const seen: string[] = [];
    const fetch = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers).get('x-marram-integration-key') ?? '');
      return json(200, INIT);
    }) as typeof globalThis.fetch;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(MarramButton, {
          token: 'tok',
          fetch,
          provider: 'google',
          integrationKey: 'google-main',
        }),
      );
    });

    await click(renderer);
    assert.deepEqual(seen, ['google-main']);
  });

  it('does nothing when your onClick prevents default', async () => {
    const { fetch, calls } = fakeFetch();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(MarramButton, { token: 'tok', fetch, provider: 'google', onClick: () => {} }),
      );
    });
    await click(renderer, true);
    assert.equal(calls.length, 0);
  });
});
