/**
 * StockPilot — BinanceRequestSigner Unit Tests
 *
 * Verifies deterministic HMAC-SHA256 signature generation, timestamp handling,
 * parameter canonicalization, and zero-leak credential hygiene.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  BinanceRequestSigner,
  createBinanceRequestSigner
} from '../src/binance/request-signer.js';

describe('BinanceRequestSigner', () => {
  const testApiKey = 'binance-web3-test-key-998877';
  const testApiSecret = 'super-secret-hmac-key-do-not-leak';
  // Exact example timestamp documented in official Binance Web3 API portal:
  const documentedTimestamp = '2026-05-11T10:08:57.715Z';

  describe('Constructor & Validation', () => {
    it('initializes successfully with valid key and secret', () => {
      const signer = new BinanceRequestSigner({
        apiKey: testApiKey,
        apiSecret: testApiSecret
      });
      expect(signer).toBeInstanceOf(BinanceRequestSigner);
    });

    it('throws error when API key is missing or empty', () => {
      expect(() => new BinanceRequestSigner({ apiKey: '', apiSecret: testApiSecret }))
        .toThrow('API key is required');
      expect(() => new BinanceRequestSigner({ apiKey: '   ', apiSecret: testApiSecret }))
        .toThrow('API key is required');
      // @ts-expect-error testing missing apiKey
      expect(() => new BinanceRequestSigner({ apiSecret: testApiSecret }))
        .toThrow('API key is required');
    });

    it('throws error when API secret is missing or empty', () => {
      expect(() => new BinanceRequestSigner({ apiKey: testApiKey, apiSecret: '' }))
        .toThrow('API secret is required');
      expect(() => new BinanceRequestSigner({ apiKey: testApiKey, apiSecret: '   ' }))
        .toThrow('API secret is required');
      // @ts-expect-error testing missing apiSecret
      expect(() => new BinanceRequestSigner({ apiKey: testApiKey }))
        .toThrow('API secret is required');
    });

    it('never includes the API secret in thrown error messages', () => {
      try {
        new BinanceRequestSigner({ apiKey: '', apiSecret: 'my-sensitive-secret-token' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain('my-sensitive-secret-token');
      }
    });
  });

  describe('Timestamp Handling', () => {
    const signer = new BinanceRequestSigner({ apiKey: testApiKey, apiSecret: testApiSecret });

    it('accepts and preserves valid ISO 8601 strings', () => {
      const formatted = signer.formatTimestamp(documentedTimestamp);
      expect(formatted).toBe('2026-05-11T10:08:57.715Z');
    });

    it('converts Date object to ISO 8601 UTC string with milliseconds', () => {
      const date = new Date(Date.UTC(2026, 8, 25, 8, 30, 0, 500));
      const formatted = signer.formatTimestamp(date);
      expect(formatted).toBe('2026-09-25T08:30:00.500Z');
    });

    it('converts millisecond epoch integer to ISO 8601 UTC string', () => {
      const epoch = Date.parse('2026-09-25T08:00:00.000Z');
      const formatted = signer.formatTimestamp(epoch);
      expect(formatted).toBe('2026-09-25T08:00:00.000Z');
    });

    it('rejects invalid or malformed timestamps', () => {
      expect(() => signer.formatTimestamp('not-a-timestamp')).toThrow('not a valid ISO 8601 format');
      expect(() => signer.formatTimestamp(new Date('invalid-date'))).toThrow('Date object is invalid');
      expect(() => signer.formatTimestamp(-100)).toThrow('must be a positive finite integer');
    });
  });

  describe('Canonicalization (Query & Body)', () => {
    const signer = new BinanceRequestSigner({ apiKey: testApiKey, apiSecret: testApiSecret });

    it('sorts query parameters alphabetically by key and URI-encodes values', () => {
      const canonical = signer.canonicalizeQueryParams({
        toTokenAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
        chainId: 56,
        amount: '1000000000000000000',
        fromTokenAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
      });

      expect(canonical).toBe(
        'amount=1000000000000000000&chainId=56&fromTokenAddress=0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d&toTokenAddress=0x02fca66c1d1afb4e2a7884261eb00f63598a7436'
      );
    });

    it('filters out undefined and null query parameters', () => {
      const canonical = signer.canonicalizeQueryParams({
        b: 'valueB',
        empty: undefined,
        nothing: null,
        a: 'valueA'
      });
      expect(canonical).toBe('a=valueA&b=valueB');
    });

    it('strips leading ? when query string is supplied directly', () => {
      const canonical = signer.canonicalizeQueryParams('?chainId=56&symbol=bNVDA');
      expect(canonical).toBe('chainId=56&symbol=bNVDA');
    });

    it('canonicalizes JSON object body to string', () => {
      const body = { address: '0x123', chainId: '56' };
      const canonical = signer.canonicalizeBody(body);
      expect(canonical).toBe(JSON.stringify(body));
    });

    it('handles empty query and empty body as empty strings', () => {
      expect(signer.canonicalizeQueryParams(undefined)).toBe('');
      expect(signer.canonicalizeBody(undefined)).toBe('');
    });
  });

  describe('Deterministic Signature Generation & Test Vectors', () => {
    /**
     * OFFICIAL DOCUMENTATION TEST VECTOR NOTE:
     * The official Binance Web3 API documentation specifies the HMAC-SHA256 algorithm and
     * headers (X-OC-APIKEY, X-OC-TIMESTAMP, X-OC-SIGN with Base64 encoding), but does NOT
     * publish an arbitrary static RFC-style public test vector key/secret pair in the dev portal.
     *
     * The deterministic test below tests the exact documented HMAC-SHA256 specification
     * by independently verifying against Node.js crypto.createHmac over the canonical string.
     */
    it('produces exact deterministic Base64 HMAC-SHA256 signature for documented payload', () => {
      const signer = new BinanceRequestSigner({
        apiKey: testApiKey,
        apiSecret: testApiSecret
      });

      const options = {
        method: 'GET',
        requestPath: '/build/api/v1/dex/market/token/search',
        timestamp: documentedTimestamp,
        queryParams: {
          chainId: 56,
          keyword: 'bNVDA'
        }
      };

      const headers = signer.signRequest(options);

      // Official preHash formula: timestamp + method + requestPath + body
      // requestPath with query: /build/api/v1/dex/market/token/search?chainId=56&keyword=bNVDA
      // For GET: body is empty string
      const expectedPayload = `${documentedTimestamp}GET/build/api/v1/dex/market/token/search?chainId=56&keyword=bNVDA`;
      const expectedSignature = createHmac('sha256', testApiSecret)
        .update(expectedPayload, 'utf8')
        .digest('base64');

      expect(headers['X-OC-APIKEY']).toBe(testApiKey);
      expect(headers['X-OC-TIMESTAMP']).toBe(documentedTimestamp);
      expect(headers['X-OC-SIGN']).toBe(expectedSignature);
      expect(typeof headers['X-OC-SIGN']).toBe('string');
      expect(headers['X-OC-SIGN'].length).toBeGreaterThan(0);
    });

    it('produces deterministic signature for POST body payload', () => {
      const signer = new BinanceRequestSigner({
        apiKey: testApiKey,
        apiSecret: testApiSecret
      });

      const body = [{ chainId: '56', contractAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436' }];
      const options = {
        method: 'POST',
        requestPath: '/build/api/v1/dex/market/price',
        timestamp: documentedTimestamp,
        body
      };

      const headers = signer.signRequest(options);

      // Official preHash formula: timestamp + method + requestPath + body
      const expectedPayload = `${documentedTimestamp}POST/build/api/v1/dex/market/price${JSON.stringify(body)}`;
      const expectedSignature = createHmac('sha256', testApiSecret)
        .update(expectedPayload, 'utf8')
        .digest('base64');

      expect(headers['X-OC-SIGN']).toBe(expectedSignature);
    });

    it('attaches optional X-OC-NONCE when provided', () => {
      const signer = new BinanceRequestSigner({ apiKey: testApiKey, apiSecret: testApiSecret });
      const headers = signer.signRequest({
        timestamp: documentedTimestamp,
        nonce: 'custom-nonce-12345'
      });

      expect(headers['X-OC-NONCE']).toBe('custom-nonce-12345');
    });
  });

  describe('Security & Secret Isolation', () => {
    it('strictly ensures the returned headers never contain the API secret', () => {
      const signer = new BinanceRequestSigner({
        apiKey: testApiKey,
        apiSecret: testApiSecret
      });

      const headers = signer.signRequest({ timestamp: documentedTimestamp });

      // Headers keys must only be X-OC-* headers
      const keys = Object.keys(headers);
      expect(keys).toEqual(['X-OC-APIKEY', 'X-OC-TIMESTAMP', 'X-OC-SIGN']);

      // No value in the headers may match the secret
      const values = Object.values(headers);
      expect(values).not.toContain(testApiSecret);

      // JSON representation of headers must not leak secret
      const json = JSON.stringify(headers);
      expect(json).not.toContain(testApiSecret);
    });
  });

  describe('Factory Helper (createBinanceRequestSigner)', () => {
    it('creates signer from explicit parameters', () => {
      const signer = createBinanceRequestSigner({
        apiKey: testApiKey,
        apiSecret: testApiSecret
      });
      expect(signer).toBeInstanceOf(BinanceRequestSigner);
    });

    it('throws error when environment variables are missing', () => {
      const originalKey = process.env.BINANCE_WEB3_API_KEY;
      const originalSecret = process.env.BINANCE_WEB3_API_SECRET;
      delete process.env.BINANCE_WEB3_API_KEY;
      delete process.env.BINANCE_WEB3_API_SECRET;

      try {
        expect(() => createBinanceRequestSigner()).toThrow(
          'Missing BINANCE_WEB3_API_KEY or BINANCE_WEB3_API_SECRET'
        );
      } finally {
        if (originalKey) process.env.BINANCE_WEB3_API_KEY = originalKey;
        if (originalSecret) process.env.BINANCE_WEB3_API_SECRET = originalSecret;
      }
    });
  });
});
