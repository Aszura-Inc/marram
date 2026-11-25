# @aszura/marram-browser

The browser half of Marram's connect and sign-in flows. It makes the PKCE pair when the user
clicks, keeps the verifier in that tab, sends the user to the provider, and finishes the flow when
they return. About 3 KB gzipped, no dependencies, any framework or none, with optional
[React bindings](#react).

**Your secret API key never reaches the browser.** Your backend mints a short-lived token, which is
local signing and not an API call, and the browser runs the flow directly against Marram with it.

```
click ─▶ your backend mints a token ─▶ connect(): PKCE pair ─▶ POST Marram init { codeChallenge }
                                                   ◀─ { authorizationUrl, flowId } ◀─
         verifier + flowId + provider + state ─▶ sessionStorage, then ─▶ provider consent ─▶ back to your redirectUrl
redirect ?claimCode=… ─▶ finish(): ─▶ POST Marram claim { flowId, codeVerifier, claimCode }
```

## Install

```sh
npm install @aszura/marram-browser
```

Or with no build step, from a CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/@aszura/marram-browser/dist/marram.min.js"></script>
```

That sets `window.Marram`, so `Marram.connect(…)` and `Marram.finish(…)` work from any script.

## Your token endpoint

One authenticated route on your backend. Take the user's ID from your own session, and set
`redirectUrl` from your config: Marram trusts what you sign, so never sign a URL from the request
unchecked.

```ts
// Express, with @aszura/marram-node
const marram = new Marram({ apiKey, signingSecret });

app.post('/marram/token', requireLogin, async (req, res) => {
  const { token } = await marram.connectToken({
    externalUserId: String(req.user.id),
    redirectUrl: 'https://yourapp.com/connected',
    expiresIn: 600,
  });
  res.json({ token });
});
```

```php
// PHP, with marram/php
$token = $marram->connectToken((string) $user->id, expiresIn: 600, redirectUrl: 'https://yourapp.com/connected')->token;
```

For sign-in, use `signInToken()`. See the [Node](../node/README.md) and [PHP](../php/llms.txt) docs.

## List: the providers a user can connect

A logged-in page can load the providers straight from Marram with the same token, and it needs
no backend route of its own. Each integration says whether this user has connected it already, so
the page can show "Connect", "Connected" or "Reconnect".

```ts
import { listProviders, connect } from '@aszura/marram-browser';

const providers = await listProviders({ token: getToken }); // on page load

for (const provider of providers) {
  for (const integration of provider.integrations) {
    const label = integration.connected
      ? 'Connected'
      : integration.connectionStatus === 'reauth_required'
        ? 'Reconnect'
        : 'Connect';
    button(`${label} ${provider.name}`).onclick = () =>
      connect(provider.providerKey, {
        token: getToken, // a fresh token on click
        integrationKey: integration.integrationKey,
        auth: integration.authTypes[0],
      });
  }
}
```

Listing doesn't spend the token, so one token can list and then connect, though a token function
keeps the ten minutes starting with the click. Most providers have one integration; the array is
there for the ones with two. Always pass the entry's `integrationKey` and one of its `authTypes` to
`connect`: the list doesn't say which integration is the default. A token minted for one provider or
integration lists only that. A failure is a `LIST_FAILED`, so a page can tell it from a failed click.

The list is per user and never cached. Right after a flow, trust `finish()`'s result over a reload:
the list can lag a new connection by up to about thirty seconds.

## Start: connect

```ts
import { connect } from '@aszura/marram-browser';

button.onclick = () =>
  connect('google', {
    token: () => fetch('/marram/token', { method: 'POST' }).then((r) => r.json()),
  }).catch(showError);
```

`token` is a function that fetches a token, or the token itself. Prefer the function: it runs on
click, so the token's ten minutes start with the flow. It can resolve a string or
`{ token, baseUrl? }`, so your backend can also choose the Marram host. A rejection becomes a
`START_FAILED` with the failure's `status` and `body`.

One token starts exactly one flow and expires within ten minutes. It only has to be valid when the
flow starts: if it expires while the user is at the provider, `finish` can still claim with it. A
`redirectUrl` in the token is
where the user lands, and the option here is ignored. Without one, the `redirectUrl` option
(default: the current page without query or hash) must be on your environment's redirect allowlist.
A set allowlist binds the token's URL too.

The other options are `environment` (`'production'` by default, or `'staging'`), `baseUrl`, `auth`
(`'oAuth2'` by default), `integrationKey` (which of the provider's integrations; from
`listProviders`), `theme`, `body` (extra fields for init), `state` and `navigate`.

## Finish: the page at your redirectUrl

```ts
import { finish } from '@aszura/marram-browser';

const result = await finish();
if (result === null) {
  // not a Marram redirect — an ordinary visit to this page
} else if (result.ok) {
  // result.provider, result.state, and result.data = { status: 'connected', jti }
  // your server now calls the provider with proxy.fetch(provider, path, { externalUserId: user.id })
} else {
  // the user declined, or the provider failed: result.error, result.errorMessage, result.state
}
```

`finish` reads `?status=connected` / `?sessionKey=` / `?claimCode=` / `?error=` from the URL,
removes them from the address bar, takes the pending flow out of storage (the flow this tab started
last, for a connect — the redirect carries no key), and claims it with the same token. The
`claimCode` is a one-time code Marram gives only to the browser that finished the provider step,
and a claim needs it beside the verifier, so a flow can only be finished from its redirect. It's safe to call on every load of
the page. Its result is the truth about the flow: mark the provider connected from it, not from a
fresh `listProviders`, which can lag by up to about thirty seconds.

To offer "Disconnect", call `disconnect` with a connect token. It disconnects the token's own user,
and the token doesn't have to name a provider. Each token disconnects once and can't start a flow
afterwards, so pass a function that mints a fresh one:

```ts
import { disconnect } from '@aszura/marram-browser';

await disconnect(provider.providerKey, {
  token: getToken, // a fresh token on click
  integrationKey: integration.integrationKey,
});
```

Marram revokes the credentials at the provider. The user can connect again, but calls for that
connection fail until they do. Update the page from this result rather than a fresh `listProviders`,
which can lag by up to about thirty seconds.

Disconnecting doesn't touch the user's webhooks: they keep running until your server deletes them
with `webhooks.delete`.

To let a connected user set up a manual webhook (one they create in the provider's dashboard), call
`setUpWebhook` with a connect token. It sends the user to Marram's hosted setup form, which shows
the URL to paste at the provider and brings them back to `redirectUrl` when they're done. There's
no `finish` step. Marram picks the `webhookKey`; to choose your own, or attach metadata, start
the setup on your server with `webhooks.initManual` and your API key.

```ts
import { setUpWebhook } from '@aszura/marram-browser';

await setUpWebhook(provider.providerKey, {
  token: getToken, // a fresh token on click
  integrationKey: integration.integrationKey,
});
```

It resolves with `{ webhookKey, setupUrl, ingressUrl }`. Pass `navigate: false` to render the link
yourself. The user must already be connected: `apiCode` is `CONNECTION_NOT_FOUND` or
`CONNECTION_REVOKED` otherwise.

A login page draws its buttons the same way, with a sign-in token. Listing doesn't spend it, so the
same token can then start the sign-in:

```ts
import { listIdentityProviders, signIn } from '@aszura/marram-browser';

const providers = await listIdentityProviders({ token: getSignInToken }); // on page load

for (const provider of providers) {
  button(provider.name).onclick = () =>
    signIn(provider.providerKey, {
      token: getSignInToken,
      integrationKey: provider.integrations[0].integrationKey,
    });
}
```

Each entry has `providerKey`, `name`, `brandColors`, `brandImages` and `integrations`, each with
`integrationKey` and `label`. Which providers appear depends on their release status and your
organization.

### When your server claims: `claim: 'server'`

By default the browser claims a connect, and the answer is only `{ status, jti }`. Pass
`claim: 'server'` when your server has to see the claim happen. The token isn't kept, and `finish`
posts to your endpoint instead, which claims with the API key:

```ts
connect('google', { token: getToken, claim: 'server' });

// At your redirectUrl:
const result = await finish({ url: '/marram/finish' });
```

Your endpoint receives `{ provider, flowId, codeVerifier, claimCode }`, calls
`connections.claim(provider, flowId, codeVerifier, claimCode)`, stores the result against the logged-in user,
and answers any JSON. That answer becomes `result.data`.

A server claim doesn't give a slow provider sign-in more time. The user has ten minutes with the
provider either way; the thirty-minute wait for `claim` only starts once they're back.

## Sign-in

```ts
import { signIn, finish } from '@aszura/marram-browser';

signIn('google', { token: getSignInToken });

// At your redirectUrl:
const result = await finish({ url: '/marram/finish' });
```

A sign-in always finishes through your backend, because the identity must reach your server from
Marram and never through the browser. Your endpoint receives
`{ provider, sessionKey, codeVerifier, claimCode }` and calls
`sessions.claim(provider, sessionKey, codeVerifier, claimCode)`.

### Through your own HTTP client: `send`

If your app already has an API client (bearer tokens, refresh, a `{ data }` envelope), pass `send`
to `finish` instead of `url`. It gets the payload that would have been POSTed and resolves whatever
you want as `result.data`:

```ts
await finish({ send: (p) => api.post('auth', p).then((r) => r.data) });
```

`send` replaces `url`, `headers`, `credentials` and `fetch`. TypeScript won't accept them together.
A rejection becomes a `FINISH_FAILED`, with `status` and `body` read from the error, or from an
axios-style `error.response`.

### With the script tag

Put the endpoint on the tag and listen for the outcome. `data-finish` needs a `url`, so a connect
that Marram claims calls `Marram.finish()` itself instead.

```html
<script src="…/marram.min.js" data-finish="/marram/finish"></script>
<script>
  document.addEventListener('marram:finished', (e) => {
    if (e.detail.ok) location.replace('/settings/integrations');
    else showError(e.detail.errorMessage);
  });
  document.addEventListener('marram:error', (e) => showError(e.detail.message));
</script>
```

### State: your own context across the redirect

Anything JSON you pass as `state` comes back from `finish` as `result.state`, in this tab only,
never sent anywhere. Use it for "go back to the Integrations tab" or "this was the Gmail button":

```ts
await connect('google', { token: getToken, state: { returnTo: '/settings?tab=mail' } });

// at your redirectUrl:
const result = await finish<{ status: string }, { returnTo: string }>();
if (result?.ok) location.replace(result.state.returnTo);
```

A declined or failed redirect carries no key, so there `state` comes from the flow this tab
started last (and is `undefined` if there was none).

### Routers: cleaning the URL

By default `finish` strips Marram's params with `history.replaceState`, which React Router,
Next.js and similar routers don't notice. Give `cleanUrl` a function and it hands you the clean
path (with the remaining search and hash) to replace through your router instead:

```ts
// React Router
finish({ cleanUrl: (path) => navigate(path, { replace: true }) });
// Next.js App Router (in a 'use client' component)
finish({ cleanUrl: (path) => router.replace(path) });
```

`cleanUrl: false` leaves the address bar alone. It also stays untouched when you pass `location`.

## React

`@aszura/marram-browser/react` wraps the same two steps. React 16.8+ is an optional peer dependency;
nothing React-related loads unless you import this path.

```tsx
import { MarramButton, useMarramFinish } from '@aszura/marram-browser/react';

const getToken = () => fetch('/marram/token', { method: 'POST' }).then((r) => r.json());

function ConnectGoogle() {
  return (
    <MarramButton
      token={getToken}
      provider="google"
      state={{ returnTo: '/settings/integrations' }}
      onError={(error) => toast(error instanceof Error ? error.message : 'Could not connect')}
    >
      Connect Google
    </MarramButton>
  );
}

// The page at your redirectUrl:
function Connected() {
  const navigate = useNavigate();
  const { loading, result, error } = useMarramFinish<{ status: string }, { returnTo: string }>({
    cleanUrl: (path) => navigate(path, { replace: true }),
  });
  if (loading) return <p>Finishing up…</p>;
  if (error) return <p>Something went wrong. Please try connecting again.</p>;
  if (result?.ok === false) return <p>{result.errorMessage ?? 'The connection was cancelled.'}</p>;
  if (result?.ok) return <Navigate to={result.state.returnTo} />;
  return null; // an ordinary visit, not a Marram redirect
}
```

- **`MarramButton`** is a `<button>` that starts a flow on click with its `token`, `provider`,
  `integrationKey`, `state` and `body`. It is disabled and `aria-busy` while the request runs and
  the page leaves, and passes every other prop through. An `onClick` that calls `preventDefault()`
  stops it.
- **`useMarramStart(options)`** returns `{ start(provider, extras?), pending, error }`, for your
  own button or a menu of providers. `start` never throws: a failure lands in `error` and `onError`.
  `extras` is `{ state?, body?, redirectUrl?, auth?, integrationKey?, theme? }`.
- Both take `token`, `flow` (`'connect'` by default, or `'signIn'`), `claim`, and the same options
  as `connect`. A `token` function receives `(provider, extras)`, so your backend can sign the
  redirect or pick the integration.
- **`useMarramProviders(options)`** runs `listProviders` once on mount and returns
  `{ loading, providers, error, reload }`. Draw your buttons from `providers`, passing each entry's
  `integrationKey` and an `authTypes` value to `start`. Call `reload()` after a flow finishes, as
  the connection fields will have changed. Pass `enabled: false` to wait for your own session.
- **`useMarramIdentityProviders(options)`** does the same with `listIdentityProviders`, for a
  login page. Start with `flow: 'signIn'`.
- **`useMarramFinish(options)`** runs `finish` once on mount and returns
  `{ loading, result, error }`, with `result` as `finish` returns it. Pass `enabled: false` to
  wait, for example until your own session has loaded. It runs once per mount even under
  StrictMode. If `error.retryable` is true, reloading the page tries the claim again.
- **Next.js App Router:** both hooks read `sessionStorage` and the address bar, so the component
  that uses them must be a client component (`'use client'` at the top of the file). Pass
  `cleanUrl: (path) => router.replace(path)` from `useRouter` in `next/navigation`.

## Running the flow yourself

To own `init` and `claim` entirely, skip this package. Make the PKCE pair on your server, keep the
verifier in the user's session, call `init` with your API key, and redirect. The server SDKs show
the whole flow: [Node](../node/README.md#connect-a-users-account) and [PHP](../php/llms.txt).

From your own browser code, `createPkce`, `parseRedirect`, `redirectPath` and `stripRedirectParams`
are exported on their own.

## Things to know

- **Same tab, start to finish.** `sessionStorage` belongs to one tab, so the flow has to come back
  to the tab that started it, which a normal redirect does. A link opened in a new tab, or a
  different browser, ends in `VERIFIER_NOT_FOUND`: start again.
- **Mint on click.** A token only has to be valid when the flow starts, and it can still claim that
  flow after it expires. Ten minutes is the maximum, so a page left open needs a fresh one. A token
  function handles this for you.
- **One flow per token.** A successful `connect`, `disconnect` or `setUpWebhook` uses the token up. A refused one
  doesn't, so you can fix the problem and retry with the same token.
- **One claim per flow.** Marram claims a flow once, so a copied URL can't replay it. `finish` keeps
  the pending flow and the URL until the claim settles. If it couldn't get an answer, or got a 429 or
  a 5XX, `error.retryable` is true: call `finish` again, or reload the page. After any other
  refusal, start the flow again. If a retry answers `CONNECTION_NOT_FOUND`, the first try may have
  worked and only its answer was lost, so check the connection before you show an error, with
  `connections.get` on your server or `listProviders` here.
- **Abandoned flows clean up.** Pending flows older than an hour are dropped the next time a flow
  starts. A declined redirect drops the flow this tab started last.

## Errors

`connect`, `signIn`, `disconnect`, `setUpWebhook`, `listProviders`, `listIdentityProviders` and `finish` throw `MarramError` for failures on the browser
side. Branch on `code`:

| `code` | Meaning |
| --- | --- |
| `START_FAILED` | Marram's init (`connect`, `signIn` or `setUpWebhook`) answered non-2xx or couldn't be reached, or your `token` function failed. `status` and `body` hold the answer, `apiCode` Marram's code. |
| `LIST_FAILED` | The same, for `listProviders` or `listIdentityProviders`: a failed page load, not a failed click. |
| `DISCONNECT_FAILED` | The same, for `disconnect`. `status: 409` means the token was already used. |
| `INVALID_START_RESPONSE` | Marram's answer had no `http(s)` `authorizationUrl`, or no `flowId`/`sessionKey` (for `setUpWebhook`: no `http(s)` `setupUrl`, `webhookKey` or `ingressUrl`). |
| `FINISH_FAILED` | The claim answered non-2xx or couldn't be reached, or your `send` rejected. `retryable` says whether calling `finish` again can work. |
| `STORAGE_UNAVAILABLE` | `sessionStorage` is blocked (some private modes, sandboxed iframes). |
| `VERIFIER_NOT_FOUND` | This tab didn't start a flow for the key in the URL. |

Marram's own code is on `error.apiCode`, for example `CONNECT_TOKEN_EXPIRED`,
`CONNECT_TOKEN_REUSED` or `REDIRECT_URL_NOT_ALLOWED`, and `error.message` includes Marram's
explanation. `finish` never sees `CONNECT_TOKEN_EXPIRED`: a token can claim the flow it started
after it expires.

A user who declines, or a provider failure, isn't thrown: `finish` returns
`{ ok: false, error, errorMessage, state }`. Only `error` (a short code) and `errorMessage` come
from the redirect. Treat `errorMessage` as text to show, not to parse.
