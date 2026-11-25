export type MarramErrorCode =
  /** Marram's init (connect, sign-in or setUpWebhook) failed or was unreachable, or your token function failed. */
  | 'START_FAILED'
  /** listProviders or listIdentityProviders failed: Marram answered non-2xx or was unreachable, or your token function failed. */
  | 'LIST_FAILED'
  /** disconnect failed: Marram answered non-2xx or was unreachable, or your token function failed. */
  | 'DISCONNECT_FAILED'
  /** Marram's init returned no valid authorizationUrl or key (or, for setUpWebhook, setupUrl, webhookKey or ingressUrl). */
  | 'INVALID_START_RESPONSE'
  /** Your finish endpoint, or Marram's claim, failed or was unreachable. */
  | 'FINISH_FAILED'
  /** sessionStorage blocked (private mode, sandboxed iframe). */
  | 'STORAGE_UNAVAILABLE'
  /** No verifier in this tab: other tab/browser, already used, or unknown key. */
  | 'VERIFIER_NOT_FOUND';

/** Browser-side failure. Provider errors aren't thrown; finish returns `{ ok: false }`. A failed
 *  list is a `LIST_FAILED` and a failed click a `START_FAILED`, so a page can tell them apart. */
export class MarramError extends Error {
  readonly code: MarramErrorCode;
  /** HTTP status of the failed call, if any. */
  readonly status: number | null;
  /** Response body of the failed call, parsed if JSON. */
  readonly body: unknown;
  /** Marram's own error code, e.g. `REDIRECT_URL_NOT_ALLOWED`, or null if the body has none. */
  readonly apiCode: string | null;
  /**
   * True when `finish` kept the flow because the failure may pass: no answer, a 429 or a 5XX. Call
   * `finish` again to retry, with no need to start over.
   */
  readonly retryable: boolean;

  constructor(
    code: MarramErrorCode,
    message: string,
    init: { status?: number | null; body?: unknown; cause?: unknown } = {},
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'MarramError';
    this.code = code;
    this.status = init.status ?? null;
    this.body = init.body;
    this.apiCode = stringField(init.body, 'code');
    this.retryable =
      code === 'FINISH_FAILED' &&
      (this.status === null || this.status === 429 || this.status >= 500);
  }
}

function stringField(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

/** `lead` with Marram's code and explanation added, when its answer carries them. */
export function refusalMessage(lead: string, body: unknown): string {
  const code = stringField(body, 'code');
  const reason = stringField(body, 'error');
  if (reason === null) return `${lead}.`;
  return code === null ? `${lead}: ${reason}` : `${lead} (${code}): ${reason}`;
}
