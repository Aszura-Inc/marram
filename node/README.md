# @aszura/marram-node

The Marram API client for Node.js 20+ and other server-side JavaScript runtimes (Deno, Bun, edge
workers).

```sh
npm install @aszura/marram-node
```

It holds your secret API key, so use it on your server only — never in a browser or mobile app.

## Connect a user's account

A connection belongs to **your own ID for the user** (`externalUserId`): once they've connected,
every proxy, refresh, revoke and webhook call addresses the connection with that same ID. There's
nothing of Marram's to store, and reconnecting the same user replaces their connection.

Connecting uses PKCE: the connection only goes live once you `claim` it with the `flowId`, the
verifier and the one-time `claimCode` the redirect arrives with. Keep the flowId and verifier
together where only this user's browser reaches them — their session. Marram gives the
`claimCode` only to the browser that finished the provider step, so someone who starts a flow
can't claim an account another person connected.

```ts
import { Marram, createPkce, parseConnectionRedirect } from '@aszura/marram-node';

const marram = new Marram({ apiKey: process.env.MARRAM_API_KEY! });

// Starting:
const pkce = await createPkce();
const { flowId, authorizationUrl } = await marram.connections.init('google', {
  auth: 'oAuth2',
  redirectUrl: 'https://yourapp.com/connected',
  codeChallenge: pkce.codeChallenge,
  codeChallengeMethod: pkce.codeChallengeMethod,
  externalUserId: 'user-123', // required: your opaque ID for this user
});
req.session.marramConnect = { flowId, codeVerifier: pkce.codeVerifier };
// redirect the browser to authorizationUrl

// Back at /connected (lands with ?status=connected&claimCode=…), in the same browser session:
const result = parseConnectionRedirect(requestUrl);
const pendingFlow = req.session.marramConnect;
delete req.session.marramConnect; // one use only
if (result.ok && pendingFlow) {
  const connection = await marram.connections.claim(
    'google',
    pendingFlow.flowId,
    pendingFlow.codeVerifier,
    result.claimCode,
  );
  // the user is connected — address their connection by 'user-123' from now on
}
```

## Serve the browser package

[`@aszura/marram-browser`](../browser/README.md) starts every flow with a token. Pass
`signingSecret` to the client, mint a token behind your own login, and the browser runs the flow
directly against Marram with `connect('google', { token })`:

```ts
const marram = new Marram({
  apiKey: process.env.MARRAM_API_KEY!,
  signingSecret: process.env.MARRAM_SIGNING_SECRET!,
});

app.post('/marram/token', requireLogin, async (req, res) => {
  const { token } = await marram.connectToken({
    externalUserId: String(req.user.id),
    redirectUrl: 'https://yourapp.com/connected',
    expiresIn: 600,
  });
  res.json({ token });
});
```

One token starts exactly one flow, does one `disconnect`, or starts one manual webhook setup (`setUpWebhook`), and a refused attempt doesn't use it
up. `expiresIn` can't be over 600 seconds: a longer one throws. A token only has to be valid when
the flow starts: it can still claim the flow after it expires. Pass `redirectUrl` when you mint, and that's where the user
lands, whatever the page sends. Without it, the page's URL must be on your environment's redirect
allowlist; a set allowlist binds the token's URL too.

For a sign-in, or a connect started with `claim: 'server'`, the browser posts to a finish endpoint
on your server. `connectFlow` and `signInFlow` provide it, ready to mount. Give it the providers you
allow and the page the user comes back to; it checks the browser's input, calls `claim`, and answers
what the package expects.

```ts
import { connectFlow } from '@aszura/marram-node';

const connect = connectFlow(marram, {
  providers: ['google', 'trello'], // or { trello: { integrationKey: '…', auth: 'oAuth1' } }
  redirectUrl: 'https://yourapp.com/connected',
});

// Express (after express.json() and your login middleware):
app.post('/marram/finish', requireLogin, connect.express.finish(async ({ connection }, req) => {
  await db.markConnected(req.user.id, connection.providerKey);
  return { connected: true }; // the browser gets this as result.data
}));
```

Next.js App Router, Remix, Hono, SvelteKit and Workers take a `Request` and return a `Response`:

```ts
// app/marram/finish/route.ts
export const POST = connect.web.finish(async ({ connection }, request) => {
  const user = await currentUser(request); // throw a Response to answer 401 or redirect
  await db.markConnected(user.id, connection.providerKey);
  return { connected: true };
});
```

Sign-in is `signInFlow` with the same options; its claim result is `{ provider, sessionKey, user, raw }`.

Underneath, `connect.finish(input)` does the work for any other framework. The `start` handlers
(`connect.start`, `express.start`, `web.start`) remain for browser code you write yourself: the
package no longer calls them. They take `{ provider, codeChallenge, codeChallengeMethod }` and call
`init` with your API key. Both throw `FlowInputError` (`status` 400, `code` `UNKNOWN_PROVIDER` or
`INVALID_INPUT`) for bad input and `MarramError` for Marram's answer; `flowErrorReply(error)`
turns either into `{ status, body }` the way the handlers do: 400 for bad input or a claim Marram
refused (expired, reused, wrong verifier), 502 for any other Marram error, null for anything else.

## Call the provider's API

```ts
const response = await marram.proxy.fetch('trello', '1/members/me/boards', {
  externalUserId: 'user-123',
});
const boards = await response.json();
```

You get the provider's response exactly as it sent it, error statuses included. Only Marram's own
refusals throw.

The body streams as the provider sends it, so a large download has no size limit and starts
arriving straight away. Because of that it isn't signed: `verifyResponse` returns `false` on a
proxied response. If the provider goes quiet for 60 seconds mid-body, Marram ends the connection
and the body you read is incomplete.

## Errors

```ts
import { MarramError } from '@aszura/marram-node';

try {
  await marram.connections.refresh('google', 'user-123');
} catch (error) {
  if (error instanceof MarramError && error.code === 'CONFLICT') {
    // a refresh is already running — retry shortly
  }
}
```

Branch on `error.code`, never on `error.message`. Quote `error.requestId` when asking for help.

## Verify webhooks

```ts
import { verifyWebhook } from '@aszura/marram-node';

// Use the raw body, before any JSON parsing.
const valid = await verifyWebhook(request.headers, rawBody, process.env.MARRAM_SIGNING_SECRET!);
```

## Sign users in

`init` and `claim` need your API key, so your server calls both. The PKCE verifier ties the
`claim` to the browser that clicked "sign in", so it has to wait somewhere only that browser
reaches — never in a store looked up by `sessionKey`, or anyone holding the session key could claim
it. Two ways to do that:

**The browser makes the pair**, best when your backend keeps no session. Your backend mints a
`signInToken()`, and the browser runs `init` with it, keeps the verifier in `sessionStorage`, and
sends the verifier back at the callback for `claim`. [`@aszura/marram-browser`](../browser/README.md)
does the browser side, connections included, and `signInFlow` [serves the finish endpoint](#serve-the-browser-package).

**Your server makes the pair** — best when you already have server sessions. Keep the verifier in
this user's session, behind their cookie:

```ts
import { createPkce } from '@aszura/marram-node';

// Starting sign-in:
const pkce = await createPkce();
const { sessionKey, authorizationUrl } = await marram.sessions.init('google', {
  auth: 'oAuth2',
  redirectUrl: 'https://yourapp.com/signed-in',
  codeChallenge: pkce.codeChallenge,
  codeChallengeMethod: pkce.codeChallengeMethod,
});
req.session.marram = { sessionKey, codeVerifier: pkce.codeVerifier };
// redirect the browser to authorizationUrl

// Back at /signed-in?sessionKey=…&claimCode=…, in the same browser session:
const pending = req.session.marram;
delete req.session.marram; // one use only
const { user } = await marram.sessions.claim(
  'google',
  pending.sessionKey,
  pending.codeVerifier,
  String(req.query.claimCode),
);
```

## License

MIT
