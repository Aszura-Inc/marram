// createElement instead of JSX, so no JSX build step.
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactElement,
} from 'react';

import { finish, type FinishOptions, type FinishResult } from './flow.ts';
import {
  connect,
  listIdentityProviders,
  listProviders,
  signIn,
  type ConnectOptions,
  type ConnectableProvider,
  type IdentityProvider,
  type ListProvidersOptions,
  type MintedToken,
  type StartResult,
  type TokenFlowOptions,
} from './token.ts';

/** Per-click extras for `start`; they win over the hook's own options. */
export type StartExtras = Pick<
  TokenFlowOptions,
  'state' | 'body' | 'redirectUrl' | 'auth' | 'integrationKey' | 'theme'
>;

export type UseMarramStartOptions = Omit<ConnectOptions, 'token' | 'state' | 'body'> & {
  /**
   * The token, or a function that fetches one on click. It gets the click's provider and extras,
   * so your backend can sign the `redirectUrl` or pick the integration.
   */
  token: string | ((provider: string, extras: StartExtras) => MintedToken | Promise<MintedToken>);
  /** Default `connect`. */
  flow?: 'connect' | 'signIn';
  /** Called on failure. */
  onError?: (error: unknown) => void;
};

export interface UseMarramStart {
  /** Runs the flow for a provider; resolves undefined on failure (see `error`). */
  start: (provider: string, extras?: StartExtras) => Promise<StartResult | undefined>;
  /** True until the page leaves or the call fails. */
  pending: boolean;
  /** Last failure, cleared on the next start. */
  error: unknown;
}

/** Starts a connect or sign-in flow from a click. */
export function useMarramStart(options: UseMarramStartOptions): UseMarramStart {
  // Ref so an inline options object doesn't recreate `start`.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(async (provider: string, extras: StartExtras = {}) => {
    setPending(true);
    setError(null);
    try {
      const { token, flow = 'connect', onError: _onError, ...options } = optionsRef.current;
      const begin = flow === 'signIn' ? signIn : connect;
      const result = await begin(provider, {
        ...options,
        ...extras,
        token: typeof token === 'function' ? () => token(provider, extras) : token,
      });
      // Stay pending while the page navigates away.
      if (optionsRef.current.navigate === false) setPending(false);
      return result;
    } catch (caught) {
      setError(caught);
      setPending(false);
      optionsRef.current.onError?.(caught);
      return undefined;
    }
  }, []);

  return { start: run, pending, error };
}

export type UseMarramFinishOptions = FinishOptions & {
  /** `false` to defer. Default true. */
  enabled?: boolean;
};

export interface UseMarramFinish<T, S = unknown> {
  loading: boolean;
  /** Null until settled, or if the page wasn't a Marram redirect. */
  result: FinishResult<T, S> | null;
  error: unknown;
}

/** Runs `finish` once on mount. Client-only: mark the component `'use client'` in Next.js. */
export function useMarramFinish<T = unknown, S = unknown>(
  options: UseMarramFinishOptions,
): UseMarramFinish<T, S> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Guards StrictMode's double effect, so one mount reports one result.
  const ran = useRef(false);
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<UseMarramFinish<T, S>>({
    loading: false,
    result: null,
    error: null,
  });

  useEffect(() => {
    if (!enabled || ran.current) return;
    ran.current = true;
    setState({ loading: true, result: null, error: null });
    // Read from the ref, not deps, so a new `send` each render can't re-run it.
    finish<T, S>(optionsRef.current).then(
      (result) => setState({ loading: false, result, error: null }),
      (error: unknown) => setState({ loading: false, result: null, error }),
    );
  }, [enabled]);

  return state;
}

export type UseMarramProvidersOptions = ListProvidersOptions & {
  /** `false` to defer. Default true. */
  enabled?: boolean;
};

interface ProviderList<T> {
  loading: boolean;
  /** Empty until loaded; kept across a failed reload. */
  providers: T[];
  error: unknown;
  /** Fetches again — after a flow finishes, the connection fields change. */
  reload: () => Promise<void>;
}

export type UseMarramProviders = ProviderList<ConnectableProvider>;
export type UseMarramIdentityProviders = ProviderList<IdentityProvider>;

/**
 * Loads `listProviders` once on mount. Client-only. A failure lands in `error` as a
 * `LIST_FAILED`; a click's failure is a `START_FAILED`, so the two tell apart.
 */
export function useMarramProviders(options: UseMarramProvidersOptions): UseMarramProviders {
  return useProviderList(listProviders, options);
}

/** `useMarramProviders` for a login page: loads `listIdentityProviders` once on mount. */
export function useMarramIdentityProviders(
  options: UseMarramProvidersOptions,
): UseMarramIdentityProviders {
  return useProviderList(listIdentityProviders, options);
}

function useProviderList<T>(
  load: (options: ListProvidersOptions) => Promise<T[]>,
  options: UseMarramProvidersOptions,
): ProviderList<T> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Guards StrictMode's double effect; a second list would spend the per-IP limit twice.
  const ran = useRef(false);
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<Omit<ProviderList<T>, 'reload'>>({
    loading: enabled,
    providers: [],
    error: null,
  });

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const providers = await load(optionsRef.current);
      setState({ loading: false, providers, error: null });
    } catch (error) {
      setState((current) => ({ loading: false, providers: current.providers, error }));
    }
  }, [load]);

  useEffect(() => {
    if (!enabled || ran.current) return;
    ran.current = true;
    void reload();
  }, [enabled, reload]);

  return { ...state, reload };
}

export type MarramButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onError'> &
  UseMarramStartOptions &
  Pick<StartExtras, 'state' | 'body'> & {
    /** Provider key, e.g. `google`. */
    provider: string;
  };

/** Button that starts a flow; disabled while pending. Other props go to the `<button>`. */
export function MarramButton({
  token,
  flow,
  environment,
  baseUrl,
  redirectUrl,
  auth,
  integrationKey,
  theme,
  claim,
  fetch,
  navigate,
  provider,
  state,
  body,
  onError,
  onClick,
  disabled,
  type = 'button',
  ...buttonProps
}: MarramButtonProps): ReactElement {
  const { start: run, pending } = useMarramStart({
    token,
    flow,
    environment,
    baseUrl,
    redirectUrl,
    auth,
    integrationKey,
    theme,
    claim,
    fetch,
    navigate,
    onError,
  });

  return createElement('button', {
    ...buttonProps,
    type,
    disabled: disabled || pending,
    'aria-busy': pending || undefined,
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      void run(provider, { state, body });
    },
  });
}
