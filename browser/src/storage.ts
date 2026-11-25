import { MarramError } from './errors.ts';

const PREFIX = 'marram:pkce:';
/** The key of the flow this tab started most recently; an error redirect carries no key. */
const LATEST = 'marram:latest';
// Marram expires pending flows sooner (10 + 30 min).
const MAX_AGE_MS = 60 * 60 * 1000;

/** What `connect` / `signIn` leaves in this tab for `finish`. */
export interface PendingFlow {
  codeVerifier: string;
  provider: string;
  /** What the flow is: a connect redirect carries no key, so finish resolves it by kind. */
  kind: 'connection' | 'session';
  /** The flowId (connections) or sessionKey (sign-in) the flow is stored under. */
  key: string;
  /** Whatever the flow was started with as `state`; undefined if nothing. */
  state: unknown;
  /** Kept when Marram claims a `connect`: finish claims directly with these. */
  token?: string;
  baseUrl?: string;
}

interface Stored extends PendingFlow {
  createdAt: number;
}

function storage(): Storage {
  try {
    const store = globalThis.sessionStorage;
    if (store === undefined || store === null) throw new Error('sessionStorage is undefined');
    return store;
  } catch (cause) {
    throw new MarramError('STORAGE_UNAVAILABLE', 'sessionStorage is not available here.', {
      cause,
    });
  }
}

/** Stores the pending flow under its key. sessionStorage is per-tab. */
export function savePending(key: string, pending: PendingFlow, now = Date.now()): void {
  const store = storage();
  sweep(store, now);
  try {
    store.setItem(PREFIX + key, JSON.stringify({ ...pending, createdAt: now } satisfies Stored));
    store.setItem(LATEST, key);
  } catch (cause) {
    throw new MarramError('STORAGE_UNAVAILABLE', 'Could not write to sessionStorage.', { cause });
  }
}

/** Reads the pending flow and leaves it in place, for a claim that may need another try. */
export function peekPending(key: string): PendingFlow | null {
  const store = storage();
  try {
    return parse(store.getItem(PREFIX + key));
  } catch (cause) {
    throw new MarramError('STORAGE_UNAVAILABLE', 'Could not read sessionStorage.', { cause });
  }
}

/** Reads the flow this tab started last and leaves it in place. */
export function peekLatest(): PendingFlow | null {
  const key = latestKey();
  return key === null ? null : peekPending(key);
}

/** Deletes the pending flow. */
export function forgetPending(key: string): void {
  const store = storage();
  try {
    store.removeItem(PREFIX + key);
    if (store.getItem(LATEST) === key) store.removeItem(LATEST);
  } catch (cause) {
    throw new MarramError('STORAGE_UNAVAILABLE', 'Could not read sessionStorage.', { cause });
  }
}

/**
 * Reads and deletes the flow this tab started last. For an error redirect, which names no key:
 * the provider sent the user back without finishing, so that flow is over either way.
 */
export function takeLatest(): PendingFlow | null {
  const key = latestKey();
  if (key === null) return null;
  const pending = peekPending(key);
  forgetPending(key);
  return pending;
}

function latestKey(): string | null {
  const store = storage();
  try {
    return store.getItem(LATEST);
  } catch (cause) {
    throw new MarramError('STORAGE_UNAVAILABLE', 'Could not read sessionStorage.', { cause });
  }
}

function parse(raw: string | null): PendingFlow | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (
      typeof parsed.codeVerifier !== 'string' ||
      typeof parsed.provider !== 'string' ||
      typeof parsed.key !== 'string' ||
      (parsed.kind !== 'connection' && parsed.kind !== 'session')
    ) {
      return null;
    }
    return {
      codeVerifier: parsed.codeVerifier,
      provider: parsed.provider,
      kind: parsed.kind,
      key: parsed.key,
      state: parsed.state,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
    };
  } catch {
    return null;
  }
}

// Clears flows abandoned more than an hour ago.
function sweep(store: Storage, now: number): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (name === null || !name.startsWith(PREFIX)) continue;
      let createdAt = 0;
      try {
        createdAt = Number((JSON.parse(store.getItem(name) ?? '{}') as Partial<Stored>).createdAt);
      } catch {
        // unreadable = stale
      }
      if (!(now - createdAt < MAX_AGE_MS)) stale.push(name);
    }
    for (const name of stale) store.removeItem(name);
  } catch {
    // best effort
  }
}
