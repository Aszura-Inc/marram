<?php

declare(strict_types=1);

namespace Marram;

/**
 * Parses the redirectUrl query: status=connected and claimCode on success, error/error_message on
 * failure. The redirect never carries a key — claim with the flowId and verifier you kept from
 * init, plus this claimCode, the one-time code only this redirect carries.
 */
final class ConnectionRedirect
{
    private function __construct(
        public readonly bool $ok,
        public readonly ?string $error,
        public readonly ?string $errorMessage,
        public readonly ?string $claimCode = null,
    ) {
    }

    public static function parse(string $url): self
    {
        parse_str((string) parse_url($url, PHP_URL_QUERY), $params);

        $error = $params['error'] ?? null;
        if (is_string($error)) {
            $message = $params['error_message'] ?? null;

            return new self(false, $error, is_string($message) ? $message : null);
        }

        if (($params['status'] ?? null) !== 'connected') {
            return new self(false, 'missing_status', null);
        }

        $claimCode = $params['claimCode'] ?? null;
        if (!is_string($claimCode) || $claimCode === '') {
            return new self(false, 'missing_claim_code', null);
        }

        return new self(true, null, null, $claimCode);
    }
}
