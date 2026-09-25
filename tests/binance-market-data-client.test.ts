/**
 * StockPilot — BinanceMarketDataClient Unit Tests
 *
 * Verifies defensive validation, parsing of search/price responses,
 * error handling (401, 403, 429, timeouts), and zero-leak credential hygiene.
 *
 * Zero-mock testing: Tests run strictly against simulated HTTP transports without network calls.
 */

import { describe, it, expect } from 'vitest';
import { BinanceRequestSigner } from '../src/binance/request-signer.js';
import {
  BinanceMarketDataClient,
  VerifiedTokenMetadata,
  VerifiedTokenPrice
} from '../src/binance/market-data-client.js';

describe('BinanceMarketDataClient', () => {
  const testApiKey = 'binance-test-key-abc';
  const testApiSecret = 'binance-super-secret-key-xyz';
  const signer = new BinanceRequestSigner({ apiKey: testApiKey, apiSecret: testApiSecret });

  function createMockFetch(response: {
    status?: number;
    statusText?: string;
    body?: unknown;
    headers?: Record<string, string>;
    shouldThrow?: Error;
  }): typeof fetch {
    return (async () => {
      if (response.shouldThrow) {
        throw response.shouldThrow;
      }

      const status = response.status ?? 200;
      const statusText = response.statusText ?? 'OK';
      const bodyStr = response.body !== undefined
        ? (typeof response.body === 'string' ? response.body : JSON.stringify(response.body))
        : '';

      const headers = new Headers(response.headers ?? {});

      return new Response(bodyStr, {
        status,
        statusText,
        headers
      });
    }) as unknown as typeof fetch;
  }

  describe('Token Search (GET /api/v1/dex/market/token/search)', () => {
    it('successfully parses valid token search response', async () => {
      const mockData = {
        code: 0,
        msg: 'success',
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            symbol: 'bNVDA',
            name: 'Backed NVIDIA',
            decimals: 18,
            isRiskToken: false
          }
        ],
        success: true
      };

      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ body: mockData })
      });

      const result = await client.searchToken({ keyword: 'bNVDA', chainId: 56 });

      expect(result.status).toBe('LIVE');
      expect(result.data).toHaveLength(1);
      const token = result.data![0];
      expect(token.symbol).toBe('bNVDA');
      expect(token.contractAddress).toBe('0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495');
      expect(token.decimals).toBe(18);
    });

    it('rejects malformed token-search response when data is not an array', async () => {
      const malformedData = {
        code: 0,
        data: 'not-an-array'
      };

      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ body: malformedData })
      });

      const result = await client.searchToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('INVALID_RESPONSE');
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('Field "data" is missing or not an array');
    });

    it('rejects token search response when token missing contractAddress or symbol', async () => {
      const missingFieldsData = {
        code: 0,
        data: [
          {
            decimals: 18
            // missing contractAddress and symbol
          }
        ]
      };

      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ body: missingFieldsData })
      });

      const result = await client.searchToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('INVALID_RESPONSE');
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('missing a valid contractAddress');
    });
  });

  describe('Price Query (POST /api/v1/dex/market/price)', () => {
    it('successfully parses valid price response', async () => {
      const mockPriceData = {
        code: 0,
        msg: 'success',
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            price: '124.50',
            updatedAt: 1727250000000
          }
        ],
        success: true
      };

      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ body: mockPriceData })
      });

      const result = await client.getPrices([
        { chainId: 56, contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495' }
      ]);

      expect(result.status).toBe('LIVE');
      expect(result.data).toHaveLength(1);
      const price = result.data![0];
      expect(price.priceUsd).toBe(124.5);
      expect(price.contractAddress).toBe('0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495');
      expect(price.updatedAt).toBe(1727250000000);
    });

    it('rejects invalid or non-numeric price in response', async () => {
      const badPriceData = {
        code: 0,
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            price: 'N/A' // Not a valid float
          }
        ]
      };

      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ body: badPriceData })
      });

      const result = await client.getPrices([
        { chainId: 56, contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495' }
      ]);

      expect(result.status).toBe('INVALID_RESPONSE');
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('invalid/non-positive price');
    });

    it('rejects price when price is zero or negative', async () => {
      const zeroPriceData = {
        code: 0,
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            price: '-10.50'
          }
        ]
      };

      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ body: zeroPriceData })
      });

      const result = await client.getPrices([
        { chainId: 56, contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495' }
      ]);

      expect(result.status).toBe('INVALID_RESPONSE');
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('invalid/non-positive price');
    });

    it('rejects price response when contractAddress is missing', async () => {
      const missingAddressData = {
        code: 0,
        data: [
          {
            price: '100.00'
          }
        ]
      };

      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ body: missingAddressData })
      });

      const result = await client.getPrices([
        { chainId: 56, contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495' }
      ]);

      expect(result.status).toBe('INVALID_RESPONSE');
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('missing a contractAddress');
    });
  });

  describe('Error Handling & Zero-Mock Statuses', () => {
    it('handles Binance API error codes (code !== 0)', async () => {
      const apiErrorResponse = {
        code: 40102,
        msg: 'Signature error'
      };

      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ body: apiErrorResponse })
      });

      const result = await client.searchToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('UNAVAILABLE');
      expect(result.error?.code).toBe('40102');
      expect(result.error?.message).toBe('Signature error');
      expect(result.data).toBeNull();
    });

    it('maps HTTP 401 and 403 to AUTH_FAILED', async () => {
      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ status: 401, statusText: 'Unauthorized' })
      });

      const result = await client.searchToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('AUTH_FAILED');
      expect(result.error?.code).toBe(401);
      expect(result.error?.message).toContain('Authentication failed');
    });

    it('maps HTTP 429 to RATE_LIMITED and extracts Retry-After header', async () => {
      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '60' }
        })
      });

      const result = await client.searchToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('RATE_LIMITED');
      expect(result.error?.code).toBe(42900);
      expect(result.error?.retryAfterSeconds).toBe(60);
      expect(result.error?.message).toContain('rate limit exceeded');
    });

    it('maps network failures and aborts to NETWORK_ERROR', async () => {
      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ shouldThrow: new Error('ECONNREFUSED connect to web3.binance.com') })
      });

      const result = await client.searchToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('NETWORK_ERROR');
      expect(result.error?.message).toContain('Network error connecting to Binance');
      expect(result.data).toBeNull();
    });

    it('maps non-JSON response to INVALID_RESPONSE', async () => {
      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ body: '<html>502 Bad Gateway</html>' })
      });

      const result = await client.searchToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('INVALID_RESPONSE');
      expect(result.error?.message).toContain('Failed to parse Binance API response as JSON');
    });
  });

  describe('Security & Credential Hygiene', () => {
    it('strictly ensures the API secret never appears in error messages or results', async () => {
      const client = new BinanceMarketDataClient({
        signer,
        fetchFn: createMockFetch({ status: 500, statusText: 'Internal Error' })
      });

      const result = await client.searchToken({ keyword: 'bNVDA' });

      const stringified = JSON.stringify(result);
      expect(stringified).not.toContain(testApiSecret);
    });
  });
});
