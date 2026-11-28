<?php

declare(strict_types=1);

namespace Marram\Resources;

use Psr\Http\Message\ResponseInterface;
use Marram\MarramException;
use Marram\Transport;

/** Calls provider APIs with the connection's credentials. */
final class ProviderProxy
{
    public function __construct(private readonly Transport $transport)
    {
    }

    /**
     * Calls the provider. Provider errors are returned, only Marram errors throw.
     *
     * @param string                $path        e.g. "1/boards/abc123"
     * @param mixed                 $body        Sent as JSON; $contentType sets what the provider gets.
     * @param array<string, string> $query
     * @param array<string, string> $headers
     * @param string|null           $version     See X-Marram-Version-Served on the response.
     * @param string|null           $contentType e.g. application/x-www-form-urlencoded
     *
     * @throws MarramException
     */
    public function request(
        string $method,
        string $provider,
        string $path,
        string $externalUserId,
        mixed $body = null,
        array $query = [],
        array $headers = [],
        ?string $integrationKey = null,
        ?string $version = null,
        ?string $contentType = null,
    ): ResponseInterface {
        $response = $this->transport->send(
            strtoupper($method),
            $this->path($provider, $path),
            $this->headers($headers, $externalUserId, $integrationKey, $version, $contentType),
            $query,
            $body,
        );

        // Only Marram's own errors carry this header.
        if ($response->hasHeader('x-marram-error-code')) {
            throw MarramException::fromResponse($response);
        }

        return $response;
    }

    /**
     * Calls the provider async; the response is POSTed to $callbackUrl (public HTTPS).
     * Verify the callback with Signature::verifyWebhook().
     *
     * @param array<string, string> $query
     * @param array<string, string> $headers
     *
     * @return array{requestId: string}
     *
     * @throws MarramException
     */
    public function enqueue(
        string $method,
        string $provider,
        string $path,
        string $externalUserId,
        string $callbackUrl,
        mixed $body = null,
        array $query = [],
        array $headers = [],
        ?string $integrationKey = null,
        ?string $version = null,
        ?string $contentType = null,
    ): array {
        $response = $this->transport->send(
            strtoupper($method),
            $this->path($provider, $path),
            [
                ...$this->headers($headers, $externalUserId, $integrationKey, $version, $contentType),
                'x-marram-callback-url' => $callbackUrl,
            ],
            $query,
            $body,
        );

        if ($response->getStatusCode() !== 202) {
            throw MarramException::fromResponse($response);
        }

        /** @var array{requestId: string} */
        return json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
    }

    private function path(string $provider, string $path): string
    {
        $providerPath = ltrim($path, '/');
        if ($providerPath === '' || self::isUnsafe($providerPath)) {
            throw new \InvalidArgumentException('Marram: the proxy path must be a provider API path, with no dot segments or fragment.');
        }

        return 'proxy/' . Transport::segment($provider) . '/' . $providerPath;
    }

    /**
     * A dot segment would lift the call out of /proxy/{provider}/ onto another Marram route, run
     * with this API key. URL parsing resolves `%2e%2e` as `..` and reads `\` as `/` before Marram
     * sees the path, so the API can't refuse it: this check is the only one. A `#` would cut the
     * path and drop the query.
     */
    private static function isUnsafe(string $providerPath): bool
    {
        if (str_contains($providerPath, '#')) {
            return true;
        }

        foreach (preg_split('#[/\\\\]#', $providerPath) ?: [] as $part) {
            $part = str_ireplace('%2e', '.', $part);
            if ($part === '.' || $part === '..') {
                return true;
            }
        }

        return false;
    }

    /**
     * Caller headers can't override x-marram-*.
     *
     * @param array<string, string> $headers
     *
     * @return array<string, string|null>
     */
    private function headers(
        array $headers,
        string $externalUserId,
        ?string $integrationKey,
        ?string $version,
        ?string $contentType,
    ): array {
        $merged = [];
        foreach ($headers as $name => $value) {
            if (stripos((string) $name, 'x-marram-') !== 0) {
                $merged[$name] = $value;
            }
        }

        return [
            ...$merged,
            'x-marram-external-user-id' => $externalUserId,
            'x-marram-integration-key' => $integrationKey,
            'x-marram-version' => $version,
            'x-marram-content-type' => $contentType,
        ];
    }
}
