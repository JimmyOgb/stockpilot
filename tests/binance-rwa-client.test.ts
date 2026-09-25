/**
 * StockPilot — BinanceRwaClient Unit Tests
 *
 * Verifies authenticated RWA search, price discovery, deterministic spread calculation,
 * underlying market status mapping, fail-closed defensive validation, and credential hygiene.
 *
 * Zero-mock testing: Runs strictly against hermetic simulated HTTP transports with zero live network calls.
 */

import { describe, it, expect } from 'vitest';
import { BinanceRequestSigner } from '../src/binance/request-signer.js';
import {
  BinanceRwaClient,
  BinanceRwaMarketStateProvider,
  UnderlyingMarketStatusResult
} from '../src/binance/rwa-client.js';

describe('BinanceRwaClient', () => {
  const testApiKey = 'binance-test-rwa-key-123';
  const testApiSecret = 'binance-super-secret-rwa-secret-456';
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

  describe('RWA Search (GET /api/v1/dex/market/rwa/search)', () => {
    it('successfully parses valid bNVDA search response', async () => {
      const mockSearchData = {
        code: 0,
        msg: 'success',
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            symbol: 'bNVDA',
            name: 'Backed NVIDIA',
            decimals: 18,
            underlyingTicker: 'NVDA',
            platformId: 3,
            isRiskToken: false
          }
        ],
        success: true
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: mockSearchData })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA', chainId: 56 });

      expect(result.status).toBe('LIVE');
      expect(result.data).toHaveLength(1);
      const token = result.data![0];
      expect(token.symbol).toBe('bNVDA');
      expect(token.contractAddress).toBe('0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495');
      expect(token.decimals).toBe(18);
      expect(token.underlyingTicker).toBe('NVDA');
    });

    it('returns UNAVAILABLE when token is not found (empty data array)', async () => {
      const emptySearchData = {
        code: 0,
        msg: 'success',
        data: [],
        success: true
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: emptySearchData })
      });

      const result = await client.searchRwaToken({ keyword: 'NONEXISTENT' });

      expect(result.status).toBe('UNAVAILABLE');
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('not found');
    });

    it('rejects malformed search response when data is not an array', async () => {
      const malformedData = {
        code: 0,
        data: { some: 'object' }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: malformedData })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('INVALID_RESPONSE');
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('Field "data" is missing or not an array');
    });

    it('handles Binance API error code (code !== 0)', async () => {
      const apiErrorData = {
        code: 40411,
        msg: 'Unsupported chain'
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: apiErrorData })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA', chainId: 999999 });

      expect(result.status).toBe('UNAVAILABLE');
      expect(result.error?.code).toBe('40411');
      expect(result.error?.message).toBe('Unsupported chain');
    });
  });

  describe('RWA Price & Spread Intelligence (GET /api/v1/dex/market/rwa/price)', () => {
    it('calculates deterministic spread when onChainPrice and referencePrice are valid', async () => {
      const mockPriceData = {
        code: 0,
        msg: 'success',
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            onChainPrice: '124.50',
            referencePrice: '123.80',
            updatedAt: 1727250000000
          }
        ],
        success: true
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: mockPriceData })
      });

      const result = await client.getRwaPriceAndSpread({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
        chainId: 56
      });

      expect(result.status).toBe('LIVE');
      expect(result.data).not.toBeNull();
      expect(result.data!.onChainPrice).toBe(124.50);
      expect(result.data!.referencePrice).toBe(123.80);

      // Expected spread: (124.50 - 123.80) / 123.80 = 0.70 / 123.80 = 0.00565428... (~0.565%)
      const expectedSpread = (124.50 - 123.80) / 123.80;
      expect(result.data!.spread).toBeCloseTo(expectedSpread, 6);
    });

    it('returns spread: null when referencePrice is missing (renders "—")', async () => {
      const missingRefData = {
        code: 0,
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            onChainPrice: '124.50',
            referencePrice: null, // Market closed or feed unavailable
            updatedAt: 1727250000000
          }
        ]
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: missingRefData })
      });

      const result = await client.getRwaPriceAndSpread({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.onChainPrice).toBe(124.50);
      expect(Number.isNaN(result.data!.referencePrice)).toBe(true);
      expect(result.data!.spread).toBeNull();
    });

    it('returns spread: null when referencePrice is zero or negative', async () => {
      const zeroRefData = {
        code: 0,
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            onChainPrice: '124.50',
            referencePrice: '0.00',
            updatedAt: 1727250000000
          }
        ]
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: zeroRefData })
      });

      const result = await client.getRwaPriceAndSpread({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.spread).toBeNull();
    });

    it('returns spread: null when onChainPrice is non-numeric or negative', async () => {
      const badOnChainData = {
        code: 0,
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            onChainPrice: '-10.50',
            referencePrice: '123.80'
          }
        ]
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: badOnChainData })
      });

      const result = await client.getRwaPriceAndSpread({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.spread).toBeNull();
    });

    it('fails closed with INVALID_RESPONSE when both onChainPrice and referencePrice are invalid', async () => {
      const invalidBothData = {
        code: 0,
        data: [
          {
            chainId: '56',
            contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            onChainPrice: null,
            referencePrice: null
          }
        ]
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: invalidBothData })
      });

      const result = await client.getRwaPriceAndSpread({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('INVALID_RESPONSE');
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('both invalid');
    });

    it('handles empty price data gracefully', async () => {
      const emptyData = {
        code: 0,
        data: []
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: emptyData })
      });

      const result = await client.getRwaPriceAndSpread({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('UNAVAILABLE');
      expect(result.data).toBeNull();
    });
  });

  describe('Underlying Market Status (GET /api/v1/dex/market/rwa/underlying-market-data)', () => {
    it('correctly maps OPEN status for regular session', async () => {
      const openData = {
        code: 0,
        data: {
          marketStatus: 'regular',
          openState: true,
          reasonCode: 'TRADING',
          reasonMsg: 'Regular trading hours',
          nextCloseTime: 1727292540000,
          updatedAt: 1727250000000
        }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: openData })
      });

      const result = await client.getUnderlyingMarketStatus({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.status).toBe('OPEN');
      expect(result.data!.rawStatus).toBe('regular');
      expect(result.data!.rawReasonCode).toBe('TRADING');
      expect(result.data!.nextCloseTime).toBe(1727292540000);
    });

    it('correctly maps CLOSED status', async () => {
      const closedData = {
        code: 0,
        data: {
          marketStatus: 'closed',
          openState: false,
          reasonCode: 'MARKET_CLOSED',
          reasonMsg: 'Market is closed outside normal trading sessions',
          nextOpenTime: 1727330400000,
          updatedAt: 1727250000000
        }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: closedData })
      });

      const result = await client.getUnderlyingMarketStatus({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.status).toBe('CLOSED');
      expect(result.data!.rawReasonCode).toBe('MARKET_CLOSED');
      expect(result.data!.nextOpenTime).toBe(1727330400000);
    });

    it('correctly maps PAUSED status for corporate actions', async () => {
      const pausedData = {
        code: 0,
        data: {
          marketStatus: 'pause',
          openState: false,
          reasonCode: 'ASSET_PAUSED',
          reasonMsg: 'Paused for stock_split execution'
        }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: pausedData })
      });

      const result = await client.getUnderlyingMarketStatus({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.status).toBe('PAUSED');
      expect(result.data!.rawReasonCode).toBe('ASSET_PAUSED');
      expect(result.data!.rawReasonMsg).toContain('stock_split');
    });

    it('correctly maps HALTED status', async () => {
      const haltedData = {
        code: 0,
        data: {
          marketStatus: 'halted',
          openState: false,
          reasonCode: 'HALTED',
          reasonMsg: 'Volatility circuit breaker halt'
        }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: haltedData })
      });

      const result = await client.getUnderlyingMarketStatus({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.status).toBe('HALTED');
    });

    it('maps empty/unpopulated status data to UNAVAILABLE', async () => {
      const emptyStatusData = {
        code: 0,
        data: {}
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: emptyStatusData })
      });

      const result = await client.getUnderlyingMarketStatus({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.status).toBe('UNAVAILABLE');
    });

    it('maps unrecognized/unknown status to UNKNOWN', async () => {
      const unknownData = {
        code: 0,
        data: {
          marketStatus: 'custom_exotic_session_status_123'
        }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: unknownData })
      });

      const result = await client.getUnderlyingMarketStatus({
        contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.status).toBe('UNKNOWN');
    });
  });

  describe('HTTP Errors & Network Failures', () => {
    it('maps HTTP 401/403 to AUTH_FAILED', async () => {
      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ status: 401, statusText: 'Unauthorized' })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('AUTH_FAILED');
      expect(result.error?.code).toBe(401);
      expect(result.error?.message).toContain('Authentication failed');
    });

    it('maps HTTP 429 to RATE_LIMITED with retryAfterSeconds', async () => {
      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '30' }
        })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('RATE_LIMITED');
      expect(result.error?.code).toBe(42900);
      expect(result.error?.retryAfterSeconds).toBe(30);
    });

    it('maps HTTP 500 to UNAVAILABLE', async () => {
      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ status: 500, statusText: 'Internal Server Error' })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('UNAVAILABLE');
      expect(result.error?.code).toBe(500);
      expect(result.error?.message).toContain('server error');
    });

    it('maps network timeouts and aborts to NETWORK_ERROR', async () => {
      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ shouldThrow: new Error('Network connection reset') })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('NETWORK_ERROR');
      expect(result.error?.message).toContain('Network error connecting to Binance');
    });
  });

  describe('Credential Hygiene & Security', () => {
    it('strictly ensures the API secret never leaks in error messages or results', async () => {
      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ status: 500, statusText: 'Internal Error' })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA' });

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(testApiSecret);
    });
  });

  describe('BinanceRwaMarketStateProvider Integration', () => {
    it('resolves MARKET_OPEN when underlying status is OPEN and fresh', () => {
      let currentStatus: UnderlyingMarketStatusResult | null = {
        status: 'OPEN',
        updatedAt: 1000000
      };

      const provider = new BinanceRwaMarketStateProvider(() => currentStatus);

      const resolved = provider.resolveMarketState({
        referenceTimestamp: 1000000,
        currentTimestamp: 1000010, // 10s old
        maxStalenessSeconds: 60
      });

      expect(resolved).toBe('MARKET_OPEN');
    });

    it('resolves MARKET_CLOSED when underlying status is CLOSED, PAUSED, or HALTED', () => {
      let currentStatus: UnderlyingMarketStatusResult | null = {
        status: 'CLOSED',
        updatedAt: 1000000
      };

      const provider = new BinanceRwaMarketStateProvider(() => currentStatus);

      const resolvedClosed = provider.resolveMarketState({
        referenceTimestamp: 1000000,
        currentTimestamp: 1000010,
        maxStalenessSeconds: 60
      });
      expect(resolvedClosed).toBe('MARKET_CLOSED');

      // Test PAUSED
      currentStatus = { status: 'PAUSED', updatedAt: 1000000 };
      expect(provider.resolveMarketState({
        referenceTimestamp: 1000000,
        currentTimestamp: 1000010,
        maxStalenessSeconds: 60
      })).toBe('MARKET_CLOSED');

      // Test HALTED
      currentStatus = { status: 'HALTED', updatedAt: 1000000 };
      expect(provider.resolveMarketState({
        referenceTimestamp: 1000000,
        currentTimestamp: 1000010,
        maxStalenessSeconds: 60
      })).toBe('MARKET_CLOSED');
    });

    it('fails closed to REFERENCE_STALE when status is stale', () => {
      const currentStatus: UnderlyingMarketStatusResult = {
        status: 'OPEN',
        updatedAt: 1000000
      };

      const provider = new BinanceRwaMarketStateProvider(() => currentStatus);

      const resolved = provider.resolveMarketState({
        referenceTimestamp: 1000000,
        currentTimestamp: 1000000 + 100 * 1000, // 100 seconds later (exceeds 60s max)
        maxStalenessSeconds: 60
      });

      expect(resolved).toBe('REFERENCE_STALE');
    });

    it('fails closed to REFERENCE_STALE when status supplier returns null', () => {
      const provider = new BinanceRwaMarketStateProvider(() => null);

      const resolved = provider.resolveMarketState({
        referenceTimestamp: 1000000,
        currentTimestamp: 1000010,
        maxStalenessSeconds: 60
      });

      expect(resolved).toBe('REFERENCE_STALE');
    });
  });
});
