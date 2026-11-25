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
        if ($providerPath === '' || in_array('..', explode('/', $providerPath), true)) {
            throw new \InvalidArgumentException('Marram: the proxy path must be a non-empty provider API path.');
        }

        return 'proxy/' . Transport::segment($provider) . '/' . $providerPath;
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
