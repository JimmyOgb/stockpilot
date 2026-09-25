/**
 * StockPilot — BinanceRwaClient Unit Tests
 *
 * Verifies authenticated RWA search, price discovery, deterministic spread calculation,
 * underlying market status mapping, fail-closed defensive validation, and credential hygiene
 * strictly against the CURRENT official Binance Web3 API schema.
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
    captureRequest?: (url: string, init?: RequestInit) => void;
  }): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      if (response.captureRequest) {
        response.captureRequest(url, init);
      }

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

  describe('RWA Search (GET /build/api/v1/dex/market/rwa/search)', () => {
    it('successfully parses valid official bNVDA search response with nested assets', async () => {
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};

      const mockSearchData = {
        code: 0,
        msg: 'success',
        data: [
          {
            ticker: 'NVDA',
            companyName: 'NVIDIA Corp',
            assets: [
              {
                platformId: 3,
                binanceChainId: '56',
                tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
                tokenSymbol: 'bNVDA',
                assetType: 'stock'
              }
            ]
          }
        ],
        success: true
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({
          body: mockSearchData,
          captureRequest: (url, init) => {
            capturedUrl = url;
            capturedHeaders = (init?.headers as Record<string, string>) ?? {};
          }
        })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA' });

      expect(result.status).toBe('LIVE');
      expect(result.data).toHaveLength(1);
      const token = result.data![0];
      expect(token.ticker).toBe('NVDA');
      expect(token.companyName).toBe('NVIDIA Corp');
      expect(token.assets).toHaveLength(1);

      const asset = token.assets[0];
      expect(asset.tokenSymbol).toBe('bNVDA');
      expect(asset.tokenContractAddress).toBe('0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495');
      expect(asset.binanceChainId).toBe('56');
      expect(asset.platformId).toBe(3);

      // Verify exact URL construction and absence of duplicated /build
      expect(capturedUrl).toBe('https://web3.binance.com/build/api/v1/dex/market/rwa/search?keyword=bNVDA');
      expect(capturedUrl).not.toContain('/build/build');
      expect(capturedHeaders['X-OC-APIKEY']).toBe(testApiKey);
      expect(capturedHeaders['X-OC-SIGN']).toBeDefined();
    });

    it('sends optional platformId when provided', async () => {
      let capturedUrl = '';

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({
          body: { code: 0, msg: 'success', data: [], success: true },
          captureRequest: (url) => { capturedUrl = url; }
        })
      });

      await client.searchRwaToken({ keyword: 'bNVDA', platformId: 3 });

      // Sorted alphabetically: keyword=bNVDA&platformId=3
      expect(capturedUrl).toBe('https://web3.binance.com/build/api/v1/dex/market/rwa/search?keyword=bNVDA&platformId=3');
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

    it('handles Binance API business error code (code !== 0)', async () => {
      const apiErrorData = {
        code: 40411,
        msg: 'Unsupported platform'
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: apiErrorData })
      });

      const result = await client.searchRwaToken({ keyword: 'bNVDA', platformId: 999 });

      expect(result.status).toBe('UNAVAILABLE');
      expect(result.error?.code).toBe('40411');
      expect(result.error?.message).toBe('Unsupported platform');
    });
  });

  describe('RWA Price & Spread Intelligence (GET /build/api/v1/dex/market/rwa/price)', () => {
    it('uses official query parameters: binanceChainId and tokenContractAddresses', async () => {
      let capturedUrl = '';

      const mockPriceData = {
        code: 0,
        msg: 'success',
        data: [
          {
            binanceChainId: '56',
            tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            platformId: 3,
            tokenPrice: '124.50',
            referencePrice: '123.80',
            tokenPriceUpdatedAt: 1727250000000
          }
        ],
        success: true
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({
          body: mockPriceData,
          captureRequest: (url) => { capturedUrl = url; }
        })
      });

      const result = await client.getRwaPriceAndSpread({
        tokenContractAddresses: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
        binanceChainId: 56
      });

      expect(result.status).toBe('LIVE');
      expect(result.data).toHaveLength(1);
      const item = result.data![0];
      expect(item.tokenPrice).toBe(124.50);
      expect(item.referencePrice).toBe(123.80);
      expect(item.tokenContractAddress).toBe('0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495');
      expect(item.binanceChainId).toBe('56');

      // Expected spread: (124.50 - 123.80) / 123.80 = 0.00565428... (~0.565%)
      const expectedSpread = (124.50 - 123.80) / 123.80;
      expect(item.spread).toBeCloseTo(expectedSpread, 6);

      // Verify exact query parameter names in URL
      expect(capturedUrl).toContain('binanceChainId=56');
      expect(capturedUrl).toContain('tokenContractAddresses=0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495');
      expect(capturedUrl).not.toContain('chainId=');
      expect(capturedUrl).not.toContain('contractAddress=');
      expect(capturedUrl).not.toContain('/build/build');
    });

    it('returns spread: null when referencePrice is missing (renders "—")', async () => {
      const missingRefData = {
        code: 0,
        data: [
          {
            binanceChainId: '56',
            tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            tokenPrice: '124.50',
            referencePrice: null,
            tokenPriceUpdatedAt: 1727250000000
          }
        ]
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: missingRefData })
      });

      const result = await client.getRwaPriceAndSpread({
        tokenContractAddresses: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data![0].tokenPrice).toBe(124.50);
      expect(Number.isNaN(result.data![0].referencePrice)).toBe(true);
      expect(result.data![0].spread).toBeNull();
    });

    it('returns spread: null when referencePrice is zero or negative', async () => {
      const zeroRefData = {
        code: 0,
        data: [
          {
            binanceChainId: '56',
            tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            tokenPrice: '124.50',
            referencePrice: '0.00',
            tokenPriceUpdatedAt: 1727250000000
          }
        ]
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: zeroRefData })
      });

      const result = await client.getRwaPriceAndSpread({
        tokenContractAddresses: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data![0].spread).toBeNull();
    });

    it('returns spread: null when tokenPrice is non-numeric or negative', async () => {
      const badTokenPriceData = {
        code: 0,
        data: [
          {
            binanceChainId: '56',
            tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            tokenPrice: '-10.50',
            referencePrice: '123.80'
          }
        ]
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: badTokenPriceData })
      });

      const result = await client.getRwaPriceAndSpread({
        tokenContractAddresses: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data![0].spread).toBeNull();
    });

    it('fails closed with INVALID_RESPONSE when both tokenPrice and referencePrice are invalid', async () => {
      const invalidBothData = {
        code: 0,
        data: [
          {
            binanceChainId: '56',
            tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
            tokenPrice: null,
            referencePrice: null
          }
        ]
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: invalidBothData })
      });

      const result = await client.getRwaPriceAndSpread({
        tokenContractAddresses: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
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
        tokenContractAddresses: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('UNAVAILABLE');
      expect(result.data).toBeNull();
    });
  });

  describe('Underlying Market (GET /build/api/v1/dex/market/rwa/underlying-market)', () => {
    it('uses exact official endpoint: /underlying-market with statusInfo and marketData', async () => {
      let capturedUrl = '';

      const openData = {
        code: 0,
        data: {
          statusInfo: {
            openState: true,
            marketStatus: 'regular',
            reasonCode: 'TRADING',
            reasonMsg: 'Regular trading session',
            nextOpenTime: 1727330400000,
            nextCloseTime: 1727292540000
          },
          marketData: {
            referencePrice: '123.80'
          },
          updatedAt: 1727250000000
        },
        success: true
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({
          body: openData,
          captureRequest: (url) => { capturedUrl = url; }
        })
      });

      const result = await client.getUnderlyingMarketStatus({
        tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
        binanceChainId: 56
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.status).toBe('OPEN');
      expect(result.data!.rawMarketStatus).toBe('regular');
      expect(result.data!.rawReasonCode).toBe('TRADING');
      expect(result.data!.openState).toBe(true);
      expect(result.data!.referencePrice).toBe(123.80);
      expect(result.data!.nextCloseTime).toBe(1727292540000);

      // Verify exact official URL path
      expect(capturedUrl).toContain('/api/v1/dex/market/rwa/underlying-market?');
      expect(capturedUrl).not.toContain('/underlying-market-data');
      expect(capturedUrl).toContain('binanceChainId=56');
      expect(capturedUrl).toContain('tokenContractAddress=0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495');
    });

    it('correctly maps CLOSED status', async () => {
      const closedData = {
        code: 0,
        data: {
          statusInfo: {
            openState: false,
            marketStatus: 'closed',
            reasonCode: 'MARKET_CLOSED',
            reasonMsg: 'Market is closed outside normal trading sessions',
            nextOpenTime: 1727330400000
          }
        }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: closedData })
      });

      const result = await client.getUnderlyingMarketStatus({
        tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
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
          statusInfo: {
            openState: false,
            marketStatus: 'pause',
            reasonCode: 'ASSET_PAUSED',
            reasonMsg: 'Paused for stock_split execution'
          }
        }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: pausedData })
      });

      const result = await client.getUnderlyingMarketStatus({
        tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
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
          statusInfo: {
            openState: false,
            marketStatus: 'halted',
            reasonCode: 'HALTED',
            reasonMsg: 'Volatility circuit breaker halt'
          }
        }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: haltedData })
      });

      const result = await client.getUnderlyingMarketStatus({
        tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
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
        tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
      });

      expect(result.status).toBe('LIVE');
      expect(result.data!.status).toBe('UNAVAILABLE');
    });

    it('maps unrecognized/unknown status to UNKNOWN', async () => {
      const unknownData = {
        code: 0,
        data: {
          statusInfo: {
            marketStatus: 'custom_exotic_session_status_123'
          }
        }
      };

      const client = new BinanceRwaClient({
        signer,
        fetchFn: createMockFetch({ body: unknownData })
      });

      const result = await client.getUnderlyingMarketStatus({
        tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
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
