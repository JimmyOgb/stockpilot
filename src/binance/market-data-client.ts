/**
 * StockPilot — Typed Binance Web3 Market Data Client
 *
 * Implements authenticated read-only interactions with the Binance Web3 API:
 * 1. GET /api/v1/dex/market/token/search
 * 2. POST /api/v1/dex/market/price
 *
 * Zero-mock architecture: All responses are defensively validated at runtime.
 * Malformed or missing data fails closed.
 */

import { BinanceRequestSigner } from './request-signer.js';

export type MarketDataStatus =
  | 'LIVE'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'NETWORK_ERROR';

export interface BinanceMarketDataClientConfig {
  signer: BinanceRequestSigner;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface TokenSearchQuery {
  keyword: string;
  chainId?: string | number;
}

export interface VerifiedTokenMetadata {
  chainId: string;
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  isRiskToken?: boolean;
}

export interface TokenPriceQuery {
  chainId: string | number;
  contractAddress: string;
}

export interface VerifiedTokenPrice {
  chainId: string;
  contractAddress: string;
  priceUsd: number;
  updatedAt: number;
}

export interface MarketDataResult<T> {
  status: MarketDataStatus;
  data: T | null;
  error?: {
    code?: number | string;
    message: string;
    retryAfterSeconds?: number;
  };
  fetchedAt: number;
}

export class BinanceMarketDataClient {
  private readonly signer: BinanceRequestSigner;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: BinanceMarketDataClientConfig) {
    if (!config || !config.signer) {
      throw new Error('BinanceMarketDataClient requires a valid BinanceRequestSigner instance.');
    }
    this.signer = config.signer;
    this.baseUrl = (config.baseUrl ?? 'https://web3.binance.com').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /**
   * Searches for tokens by keyword (symbol or contract address) on Binance Web3 API.
   * Endpoint: GET /api/v1/dex/market/token/search
   */
  public async searchToken(query: TokenSearchQuery): Promise<MarketDataResult<VerifiedTokenMetadata[]>> {
    const now = Date.now();

    if (!query || typeof query.keyword !== 'string' || query.keyword.trim().length === 0) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: 'Invalid query: keyword must be a non-empty string.' },
        fetchedAt: now
      };
    }

    const queryParams: Record<string, string | number> = {
      keyword: query.keyword.trim()
    };
    if (query.chainId !== undefined) {
      queryParams.chainId = query.chainId;
    }

    const endpointPath = '/api/v1/dex/market/token/search';
    const queryString = this.signer.canonicalizeQueryParams(queryParams);
    const fullUrl = `${this.baseUrl}${endpointPath}?${queryString}`;

    const headers = this.signer.signRequest({
      queryParams
    });

    const fetchResult = await this.executeRequest(fullUrl, {
      method: 'GET',
      headers: {
        ...headers,
        Accept: 'application/json'
      }
    });

    if (fetchResult.status !== 'LIVE' || !fetchResult.rawJson) {
      return {
        status: fetchResult.status,
        data: null,
        error: fetchResult.error,
        fetchedAt: Date.now()
      };
    }

    // Defensive validation of response schema
    const validation = this.validateTokenSearchResponse(fetchResult.rawJson);
    if (!validation.isValid) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: `Malformed token search response: ${validation.reason}` },
        fetchedAt: Date.now()
      };
    }

    return {
      status: 'LIVE',
      data: validation.tokens,
      fetchedAt: Date.now()
    };
  }

  /**
   * Batch queries real-time token spot prices.
   * Endpoint: POST /api/v1/dex/market/price
   */
  public async getPrices(queries: TokenPriceQuery[]): Promise<MarketDataResult<VerifiedTokenPrice[]>> {
    const now = Date.now();

    if (!Array.isArray(queries) || queries.length === 0) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: 'Invalid price query: queries must be a non-empty array.' },
        fetchedAt: now
      };
    }

    // Validate request query elements
    const bodyPayload = queries.map((q) => {
      if (!q.contractAddress || typeof q.contractAddress !== 'string') {
        throw new Error('Invalid price query item: contractAddress is required.');
      }
      return {
        chainId: String(q.chainId),
        contractAddress: q.contractAddress.trim()
      };
    });

    const endpointPath = '/api/v1/dex/market/price';
    const fullUrl = `${this.baseUrl}${endpointPath}`;

    const headers = this.signer.signRequest({
      body: bodyPayload
    });

    const fetchResult = await this.executeRequest(fullUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(bodyPayload)
    });

    if (fetchResult.status !== 'LIVE' || !fetchResult.rawJson) {
      return {
        status: fetchResult.status,
        data: null,
        error: fetchResult.error,
        fetchedAt: Date.now()
      };
    }

    // Defensive validation of price response schema
    const validation = this.validatePriceResponse(fetchResult.rawJson);
    if (!validation.isValid) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: `Malformed price response: ${validation.reason}` },
        fetchedAt: Date.now()
      };
    }

    return {
      status: 'LIVE',
      data: validation.prices,
      fetchedAt: Date.now()
    };
  }

  /**
   * Internal helper executing HTTP request with timeout, status mapping, and Retry-After handling.
   */
  private async executeRequest(
    url: string,
    init: RequestInit
  ): Promise<{
    status: MarketDataStatus;
    rawJson: unknown | null;
    error?: { code?: number | string; message: string; retryAfterSeconds?: number };
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(timer);

      // Handle HTTP Authentication Errors (401, 403)
      if (response.status === 401 || response.status === 403) {
        return {
          status: 'AUTH_FAILED',
          rawJson: null,
          error: {
            code: response.status,
            message: `Authentication failed (HTTP ${response.status}). Check Web3 API key and signature.`
          }
        };
      }

      // Handle Rate Limiting (429)
      if (response.status === 429) {
        const retryHeader = response.headers.get('Retry-After');
        const retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) : undefined;
        return {
          status: 'RATE_LIMITED',
          rawJson: null,
          error: {
            code: 42900,
            message: 'Binance Web3 API rate limit exceeded.',
            retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined
          }
        };
      }

      // Handle other non-2xx HTTP codes
      if (!response.ok) {
        return {
          status: 'UNAVAILABLE',
          rawJson: null,
          error: {
            code: response.status,
            message: `Binance API HTTP error: ${response.status} ${response.statusText}`
          }
        };
      }

      // Parse JSON safely
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        return {
          status: 'INVALID_RESPONSE',
          rawJson: null,
          error: { message: 'Failed to parse Binance API response as JSON.' }
        };
      }

      // Check Binance envelope response (code === 0 && (success === true || success === undefined))
      if (typeof json === 'object' && json !== null) {
        const envelope = json as Record<string, unknown>;
        if (envelope.code !== undefined && envelope.code !== 0) {
          return {
            status: 'UNAVAILABLE',
            rawJson: null,
            error: {
              code: String(envelope.code),
              message: typeof envelope.msg === 'string' ? envelope.msg : 'Unknown Binance API error'
            }
          };
        }
      }

      return {
        status: 'LIVE',
        rawJson: json
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = (err as Error)?.name === 'AbortError';
      return {
        status: 'NETWORK_ERROR',
        rawJson: null,
        error: {
          message: isAbort
            ? `Request timed out after ${this.timeoutMs}ms.`
            : `Network error connecting to Binance: ${(err as Error)?.message ?? 'Unknown'}`
        }
      };
    }
  }

  /**
   * Defensive validation for Token Search response.
   */
  private validateTokenSearchResponse(json: unknown): {
    isValid: boolean;
    tokens: VerifiedTokenMetadata[];
    reason?: string;
  } {
    if (typeof json !== 'object' || json === null) {
      return { isValid: false, tokens: [], reason: 'Response is not a JSON object.' };
    }

    const obj = json as Record<string, unknown>;
    const rawData = obj.data;

    if (!Array.isArray(rawData)) {
      return { isValid: false, tokens: [], reason: 'Field "data" is missing or not an array.' };
    }

    const tokens: VerifiedTokenMetadata[] = [];

    for (let i = 0; i < rawData.length; i++) {
      const item = rawData[i];
      if (typeof item !== 'object' || item === null) {
        return { isValid: false, tokens: [], reason: `Item at index ${i} is not an object.` };
      }

      const t = item as Record<string, unknown>;

      if (typeof t.contractAddress !== 'string' || t.contractAddress.trim().length === 0) {
        return { isValid: false, tokens: [], reason: `Item at index ${i} is missing a valid contractAddress.` };
      }

      if (typeof t.symbol !== 'string' || t.symbol.trim().length === 0) {
        return { isValid: false, tokens: [], reason: `Item at index ${i} is missing a valid symbol.` };
      }

      const decimals = typeof t.decimals === 'number' ? t.decimals : parseInt(String(t.decimals), 10);
      if (isNaN(decimals) || decimals < 0 || decimals > 36) {
        return { isValid: false, tokens: [], reason: `Item at index ${i} has an invalid decimals value.` };
      }

      tokens.push({
        chainId: String(t.chainId ?? ''),
        contractAddress: t.contractAddress.trim(),
        symbol: t.symbol.trim(),
        name: typeof t.name === 'string' ? t.name : t.symbol.trim(),
        decimals,
        isRiskToken: Boolean(t.isRiskToken)
      });
    }

    return { isValid: true, tokens };
  }

  /**
   * Defensive validation for Token Price response.
   */
  private validatePriceResponse(json: unknown): {
    isValid: boolean;
    prices: VerifiedTokenPrice[];
    reason?: string;
  } {
    if (typeof json !== 'object' || json === null) {
      return { isValid: false, prices: [], reason: 'Response is not a JSON object.' };
    }

    const obj = json as Record<string, unknown>;
    const rawData = obj.data;

    if (!Array.isArray(rawData)) {
      return { isValid: false, prices: [], reason: 'Field "data" is missing or not an array.' };
    }

    const prices: VerifiedTokenPrice[] = [];

    for (let i = 0; i < rawData.length; i++) {
      const item = rawData[i];
      if (typeof item !== 'object' || item === null) {
        return { isValid: false, prices: [], reason: `Price item at index ${i} is not an object.` };
      }

      const p = item as Record<string, unknown>;

      if (typeof p.contractAddress !== 'string' || p.contractAddress.trim().length === 0) {
        return { isValid: false, prices: [], reason: `Price item at index ${i} is missing a contractAddress.` };
      }

      // Validate numeric price
      const priceStr = String(p.price);
      const priceNum = parseFloat(priceStr);
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        return { isValid: false, prices: [], reason: `Price item at index ${i} has invalid/non-positive price: "${p.price}".` };
      }

      // Validate timestamp
      let updatedAt = Date.now();
      if (p.updatedAt !== undefined && p.updatedAt !== null) {
        const parsedTime = typeof p.updatedAt === 'number' ? p.updatedAt : Date.parse(String(p.updatedAt));
        if (!isNaN(parsedTime) && parsedTime > 0) {
          updatedAt = parsedTime;
        }
      }

      prices.push({
        chainId: String(p.chainId ?? ''),
        contractAddress: p.contractAddress.trim(),
        priceUsd: priceNum,
        updatedAt
      });
    }

    return { isValid: true, prices };
  }
}
