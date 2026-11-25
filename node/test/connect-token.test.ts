import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { Marram, mintConnectToken } from '../src/index.ts';

const SECRET = Buffer.alloc(32, 7).toString('base64');
const API_KEY = `sk_${'a'.repeat(32)}_01ORG_01ENV`;

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('connect tokens', () => {
  it('mints an HS256 token whose claims and signature verify', async () => {
    const marram = new Marram({ apiKey: API_KEY, signingSecret: SECRET });
    const now = new Date('2026-11-03T12:00:00Z');

    const minted = await marram.connectToken({
      externalUserId: 'user-1',
      provider: 'google',
      now,
    });

    const [header, payload, signature] = minted.token.split('.');
    assert.deepEqual(decodeSegment(header!), { alg: 'HS256', typ: 'JWT' });

    const claims = decodeSegment(payload!);
    assert.equal(claims.typ, 'marram');
    assert.equal(claims.use, 'connect');
    assert.equal(claims.sub, 'user-1');
    assert.equal(claims.env, '01ENV');
    assert.equal(claims.org, '01ORG');
    assert.equal(claims.provider, 'google');
    assert.equal(claims.jti, minted.jti);
    assert.equal(claims.iat, Math.floor(now.getTime() / 1000));
    assert.equal(claims.exp, minted.expiresAt);
    // The default life is the maximum: the provider step is capped at ten minutes regardless.
    assert.equal((claims.exp as number) - (claims.iat as number), 600);

    // The worker verifies HMAC-SHA256 with the base64-decoded secret — recompute it here.
    const expected = createHmac('sha256', Buffer.from(SECRET, 'base64'))
      .update(`${header}.${payload}`)
      .digest('base64url');
    assert.equal(signature, expected);
  });

  it('signs a redirectUrl into the token, and leaves the claim out otherwise', async () => {
    const marram = new Marram({ apiKey: API_KEY, signingSecret: SECRET });

    const withRedirect = await marram.connectToken({
      externalUserId: 'user-1',
      redirectUrl: 'https://app.test/back',
    });
    assert.equal(
      decodeSegment(withRedirect.token.split('.')[1]!).redirectUrl,
      'https://app.test/back',
    );

    const without = await marram.signInToken();
    assert.equal('redirectUrl' in decodeSegment(without.token.split('.')[1]!), false);
  });

  it('refuses a life over ten minutes rather than quietly shortening it', async () => {
    const mint = (expiresIn: number) =>
      mintConnectToken({
        use: 'signin',
        organizationId: '01ORG',
        environmentId: '01ENV',
        signingSecret: SECRET,
        expiresIn,
      });

    await assert.rejects(mint(601), /at most 600 seconds/);

    const minted = await mint(600);
    const claims = decodeSegment(minted.token.split('.')[1]!);
    assert.equal((claims.exp as number) - (claims.iat as number), 600);
    assert.equal(claims.sub, undefined);
  });

  it('requires externalUserId for connect, a signing secret, and a full API key', async () => {
    await assert.rejects(
      mintConnectToken({
        use: 'connect',
        organizationId: '01ORG',
        environmentId: '01ENV',
        signingSecret: SECRET,
      }),
      /externalUserId/,
    );

    const noSecret = new Marram({ apiKey: API_KEY });
    assert.throws(() => noSecret.connectToken({ externalUserId: 'user-1' }), /signingSecret/);

    const badKey = new Marram({ apiKey: 'sk_only_three', signingSecret: SECRET });
    assert.throws(() => badKey.signInToken(), /API key/);
  });
});
