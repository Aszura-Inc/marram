# Marram SDKs

Clients for the [Marram API](https://api.marram.dev): connect your users'
third-party accounts, call those APIs through Marram, manage provider webhooks and sign users in —
without handling their credentials yourself.

| Language | Package | Folder |
| --- | --- | --- |
| PHP 8.1+ | [`marram/php`](https://packagist.org/packages/marram/php) | [`php/`](php/) |
| Node.js 20+ | [`@aszura/marram-node`](https://www.npmjs.com/package/@aszura/marram-node) | [`node/`](node/) |
| Browser (+ React) | [`@aszura/marram-browser`](https://www.npmjs.com/package/@aszura/marram-browser) | [`browser/`](browser/) |

The server SDKs are generated against the same contract, [`openapi.yaml`](openapi.yaml), and tested against
the same fixtures in [`tests/fixtures`](tests/fixtures), so they behave the same way.

The PHP and Node SDKs hold your secret API key: use them on your server only, never in a browser or
app. `@aszura/marram-browser` is the other half of the connect and sign-in flows: your backend mints a
token (`connectToken()` / `signInToken()`), and the browser makes the PKCE pair and runs the flow
directly against Marram.

Connections are addressed by **your own user ID** (`externalUserId`): there are no Marram-issued
connection keys to store.

## PHP

```sh
composer require marram/php
```

Bring any PSR-18 HTTP client (Guzzle, Symfony HttpClient, …); one installed in your project is found
automatically.

```php
$marram = new Marram\Client(apiKey: getenv('MARRAM_API_KEY'));

// Connecting uses PKCE: keep the flowId and verifier in this user's session. The connection only
// goes live once you claim it with both, and it's addressed by your own ID for the user.
$pkce = Marram\Pkce::create();
$result = $marram->connections->init('google', [
    'auth' => 'oAuth2',
    'redirectUrl' => 'https://yourapp.com/connected',
    'codeChallenge' => $pkce['codeChallenge'],
    'codeChallengeMethod' => $pkce['codeChallengeMethod'],
    'externalUserId' => (string) $user->id,
]);
$_SESSION['marram_connect'] = ['flowId' => $result['flowId'], 'codeVerifier' => $pkce['codeVerifier']];
// Send the user to $result['authorizationUrl']. They come back to your redirectUrl with ?status=connected&claimCode=…:

$redirect = Marram\ConnectionRedirect::parse($requestUrl);
$pendingFlow = $_SESSION['marram_connect'] ?? null;
unset($_SESSION['marram_connect']); // one use only
if ($redirect->ok && $pendingFlow !== null) {
    $connection = $marram->connections->claim('google', $pendingFlow['flowId'], $pendingFlow['codeVerifier'], $redirect->claimCode);
    // the user is connected — address their connection by $user->id from now on
}

// Or mint a token and let @aszura/marram-browser run the flow directly against Marram.
$token = $marram->connectToken((string) $user->id, redirectUrl: 'https://yourapp.com/connected'); // needs signingSecret on the Client

// Call the provider's API — you get its response exactly as it sent it.
$response = $marram->proxy->request('GET', 'trello', '1/members/me/boards', (string) $user->id);

// Verify a webhook delivery — use the raw body.
$valid = Marram\Signature::verifyWebhook(getallheaders(), file_get_contents('php://input'), $secret);
```

Errors Marram itself returns throw `Marram\MarramException`; branch on `$e->errorCode`, never
on the message.

## Node.js

See [`node/README.md`](node/README.md).

## Developing

```sh
composer install && composer test           # PHP
cd node && npm install && npm test           # Node
cd browser && npm install && npm test        # Browser
```

`openapi.yaml` is copied from the Marram API (`apps/marram-api/openapi.yaml` in the workers
repo). After updating it, regenerate the Node types with
`npm run openapi:types` in `node/`; `npm run openapi:check` fails while they're stale. All three
packages are released together under one version: tag `vX.Y.Z` (Packagist reads the tag) and
publish `@aszura/marram-node@X.Y.Z` from `node/` and `@aszura/marram-browser@X.Y.Z` from `browser/`.

## License

MIT
