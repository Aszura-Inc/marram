import { MarramError } from './errors.ts';

export const BASE_URLS = {
  production: 'https://api.marram.dev/v1',
  staging: 'https://api-staging.marram.dev/v1',
} as const;

export type MarramEnvironment = keyof typeof BASE_URLS;

export interface MarramOptions {
  /** Secret API key. Server-side only. */
  apiKey: string;
  /** Default `production`. */
  environment?: MarramEnvironment;
  /** Overrides `environment`. Include `/v1`. */
  baseUrl?: string;
  /** Base64 signing secret from the dashboard — needed for `connectToken` / `signInToken`. */
  signingSecret?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface TransportRequest {
  method: string;
  /** Relative to the base URL, already encoded. */
  path: string;
  headers?: Record<string, string | null | undefined>;
  query?: Record<string, string | null | undefined>;
  /** Sent as JSON. */
  body?: unknown;
}

/** Encodes one path segment so it can't change the route. */
export function segment(value: string): string {
  if (value === '') throw new TypeError('Marram: a path segment cannot be empty.');
  return encodeURIComponent(value);
}

export class Transport {
  readonly baseUrl: string;
  /** The key as given, for reading the organization and environment ids it names. */
  readonly apiKey: string;
  /** Base64 signing secret, when the options carried one. */
  readonly signingSecret: string | null;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: MarramOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new TypeError('Marram: `apiKey` is required.');
    }
    this.#apiKey = options.apiKey.trim();
    this.apiKey = this.#apiKey;
    this.signingSecret = options.signingSecret?.trim() || null;
    this.baseUrl = (options.baseUrl ?? BASE_URLS[options.environment ?? 'production']).replace(
      /\/+$/,
      '',
    );
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('Marram: no global fetch — pass `fetch` in the options.');
    }
    // Called as a plain function. Stored and called as `this.#fetch(...)`, fetch would run with
    // `this` set to the Transport, which Node allows and Cloudflare Workers refuses with
    // "Illegal invocation", failing every call.
    this.#fetch = (input, init) => fetchImpl(input, init);
  }

  url(path: string, query?: TransportRequest['query']): string {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== null && value !== undefined) params.append(key, value);
    }
    const search = params.toString();
    return search === '' ? url : `${url}${url.includes('?') ? '&' : '?'}${search}`;
  }

  /** Returns the raw response, any status. */
  async send(request: TransportRequest): Promise<Response> {
    const headers = new Headers({ Authorization: `Bearer ${this.#apiKey}` });
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (value !== null && value !== undefined) headers.set(name, value);
    }

    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }

    return this.#fetch(this.url(request.path, request.query), {
      method: request.method,
      headers,
      body,
    });
  }

  /** Returns the parsed JSON body; throws MarramError on non-2xx. */
  async json<T>(request: TransportRequest): Promise<T> {
    const response = await this.send(request);
    if (!response.ok) throw await MarramError.fromResponse(response);
    return (await response.json()) as T;
  }
}
