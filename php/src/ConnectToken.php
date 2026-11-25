<?php

declare(strict_types=1);

namespace Marram;

/**
 * Connect and sign-in tokens: short-lived HS256 JWTs minted locally with your environment's
 * signing secret — no API call. The browser sends one as its bearer credential to start (and for
 * connect, claim) a flow directly against Marram. You normally mint through
 * Client::connectToken() / Client::signInToken(), which fill the organization and environment
 * from your API key.
 */
final class ConnectToken
{
    /** The longest life a token may declare; Marram refuses anything longer. */
    public const MAX_LIFE_SECONDS = 600;

    // The maximum, and the life of the temporary record init parks: the user has ten minutes
    // with the provider whatever the token says, so a shorter default only cuts the page's time
    // to click.
    public const DEFAULT_LIFE_SECONDS = 600;

    private function __construct(
        public readonly string $token,
        /** The token's unique id: each jti acts once (one flow or one disconnect); claim echoes it. */
        public readonly string $jti,
        /** Unix seconds. */
        public readonly int $expiresAt,
    ) {
    }

    /**
     * @param 'connect'|'signin' $use
     * @param string|null        $externalUserId Required for 'connect'; optional for 'signin'.
     * @param string             $signingSecret  Base64 signing secret from your dashboard.
     * @param int                $expiresIn      Seconds until expiry, at most 600 (the default).
     * @param string|null        $redirectUrl    Where the user lands, http(s). Marram ignores
     *                                           whatever the page sends instead, and a redirect
     *                                           allowlist, if set, must still match. Never copy
     *                                           this from the browser unchecked.
     */
    public static function mint(
        string $use,
        string $organizationId,
        string $environmentId,
        string $signingSecret,
        ?string $externalUserId = null,
        ?string $provider = null,
        ?string $integrationKey = null,
        int $expiresIn = self::DEFAULT_LIFE_SECONDS,
        ?int $now = null,
        ?string $redirectUrl = null,
    ): self {
        if (!in_array($use, ['connect', 'signin'], true)) {
            throw new \InvalidArgumentException("Marram: \$use must be 'connect' or 'signin'.");
        }
        if ($use === 'connect' && ($externalUserId === null || $externalUserId === '')) {
            throw new \InvalidArgumentException('Marram: a connect token needs $externalUserId.');
        }

        $key = base64_decode($signingSecret, true);
        if ($key === false || $key === '') {
            throw new \InvalidArgumentException('Marram: $signingSecret must be the base64 secret from the dashboard.');
        }

        if ($expiresIn <= 0) {
            throw new \InvalidArgumentException('Marram: $expiresIn must be positive.');
        }
        if ($expiresIn > self::MAX_LIFE_SECONDS) {
            throw new \InvalidArgumentException(
                'Marram: $expiresIn must be at most ' . self::MAX_LIFE_SECONDS . ' seconds.',
            );
        }

        $iat = $now ?? time();
        $jti = self::uuid();

        $payload = [
            'typ' => 'marram',
            'use' => $use,
            'env' => $environmentId,
            'org' => $organizationId,
            'jti' => $jti,
            'iat' => $iat,
            'exp' => $iat + $expiresIn,
        ];
        if ($externalUserId !== null) {
            $payload['sub'] = $externalUserId;
        }
        if ($provider !== null) {
            $payload['provider'] = $provider;
        }
        if ($integrationKey !== null) {
            $payload['integrationKey'] = $integrationKey;
        }
        if ($redirectUrl !== null) {
            $payload['redirectUrl'] = $redirectUrl;
        }

        $input = self::base64Url((string) json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_THROW_ON_ERROR))
            . '.' . self::base64Url((string) json_encode($payload, JSON_THROW_ON_ERROR));

        $signature = hash_hmac('sha256', $input, $key, true);

        return new self($input . '.' . self::base64Url($signature), $jti, $iat + $expiresIn);
    }

    /**
     * The organization and environment a 4-part sk_ key names; null for anything else.
     *
     * @return array{organizationId: string, environmentId: string}|null
     */
    public static function parseApiKeyIds(string $apiKey): ?array
    {
        $parts = explode('_', $apiKey);
        if (count($parts) !== 4 || $parts[0] !== 'sk' || $parts[2] === '' || $parts[3] === '') {
            return null;
        }

        return ['organizationId' => $parts[2], 'environmentId' => $parts[3]];
    }

    private static function base64Url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    private static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0F) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3F) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
