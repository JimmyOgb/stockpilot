/**
 * StockPilot — Typed Binance Web3 RWA Data Client
 *
 * Implements authenticated read-only interactions with the Binance Web3 RWA API:
 * 1. GET /api/v1/dex/market/rwa/search
 * 2. GET /api/v1/dex/market/rwa/price
 * 3. GET /api/v1/dex/market/rwa/underlying-market-data
 *
 * Enforces Zero-Mock compliance: All responses are defensively validated at runtime.
 * Malformed or missing data fails closed. Spreads are computed strictly when both
 * on-chain and reference prices are valid positive numbers; otherwise returns null.
 */

import { BinanceRequestSigner } from './request-signer.js';
import {
  IMarketStateProvider,
  MarketStateParams
} from '../strategy/risk-engine.js';
import { MarketState } from '../types/index.js';

export type RwaClientStatus =
  | 'LIVE'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'NETWORK_ERROR';

export type RwaMarketStatus =
  | 'OPEN'
  | 'CLOSED'
  | 'PAUSED'
  | 'HALTED'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export interface BinanceRwaClientConfig {
  signer: BinanceRequestSigner;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface RwaTokenSearchQuery {
  keyword: string;
  chainId?: string | number;
}

export interface VerifiedRwaTokenMetadata {
  chainId: string;
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  underlyingTicker?: string;
  platformId?: number;
  isRiskToken?: boolean;
}

export interface RwaPriceQuery {
  contractAddress: string;
  chainId?: string | number;
}

export interface RwaPriceAndSpread {
  chainId: string;
  contractAddress: string;
  onChainPrice: number;
  referencePrice: number;
  spread: number | null; // Real spread: (onChainPrice - referencePrice) / referencePrice, or null
  updatedAt: number;
}

export interface UnderlyingMarketStatusResult {
  status: RwaMarketStatus;
  rawStatus?: string;
  rawReasonCode?: string;
  rawReasonMsg?: string;
  nextOpenTime?: number;
  nextCloseTime?: number;
  updatedAt: number;
}

export interface RwaDataResult<T> {
  status: RwaClientStatus;
  data: T | null;
  error?: {
    code?: number | string;
    message: string;
    retryAfterSeconds?: number;
  };
  fetchedAt: number;
}

export class BinanceRwaClient {
  private readonly signer: BinanceRequestSigner;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: BinanceRwaClientConfig) {
    if (!config || !config.signer) {
      throw new Error('BinanceRwaClient requires a valid BinanceRequestSigner instance.');
    }
    this.signer = config.signer;
    // Normalize base URL: ensure no trailing slash, and ensure /build base path is cleanly handled
    const rawBase = (config.baseUrl ?? 'https://web3.binance.com/build').replace(/\/+$/, '');
    this.baseUrl = rawBase.endsWith('/build') ? rawBase : `${rawBase}/build`;
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /**
   * Searches for supported RWA / tokenized-stock assets on Binance Web3 API.
   * Endpoint: GET /build/api/v1/dex/market/rwa/search
   */
  public async searchRwaToken(query: RwaTokenSearchQuery): Promise<RwaDataResult<VerifiedRwaTokenMetadata[]>> {
    const now = Date.now();

    if (!query || typeof query.keyword !== 'string' || query.keyword.trim().length === 0) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: 'Invalid search query: keyword must be a non-empty string.' },
        fetchedAt: now
      };
    }

    const queryParams: Record<string, string | number> = {
      keyword: query.keyword.trim()
    };
    if (query.chainId !== undefined) {
      queryParams.chainId = String(query.chainId);
    }

    const endpointPath = '/api/v1/dex/market/rwa/search';
    const requestPath = `/build${endpointPath}`;
    const queryString = this.signer.canonicalizeQueryParams(queryParams);
    const fullUrl = `${this.baseUrl}${endpointPath}?${queryString}`;

    const headers = this.signer.signRequest({
      method: 'GET',
      requestPath,
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
    const validation = this.validateRwaSearchResponse(fetchResult.rawJson, query.keyword);
    if (!validation.isValid) {
      return {
        status: validation.status ?? 'INVALID_RESPONSE',
        data: null,
        error: { message: validation.reason ?? 'Failed to validate RWA search response.' },
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
   * Retrieves on-chain token price and underlying reference price, then calculates real spread.
   * spread = (onChainPrice - referencePrice) / referencePrice
   * If either price is missing, non-positive, or invalid, spread is returned as null (for '—' rendering).
   * Endpoint: GET /build/api/v1/dex/market/rwa/price
   */
  public async getRwaPriceAndSpread(query: RwaPriceQuery): Promise<RwaDataResult<RwaPriceAndSpread>> {
    const now = Date.now();

    if (!query || typeof query.contractAddress !== 'string' || query.contractAddress.trim().length === 0) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: 'Invalid price query: contractAddress is required.' },
        fetchedAt: now
      };
    }

    const queryParams: Record<string, string | number> = {
      contractAddress: query.contractAddress.trim()
    };
    if (query.chainId !== undefined) {
      queryParams.chainId = String(query.chainId);
    }

    const endpointPath = '/api/v1/dex/market/rwa/price';
    const requestPath = `/build${endpointPath}`;
    const queryString = this.signer.canonicalizeQueryParams(queryParams);
    const fullUrl = `${this.baseUrl}${endpointPath}?${queryString}`;

    const headers = this.signer.signRequest({
      method: 'GET',
      requestPath,
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

    const validation = this.validatePriceAndSpreadResponse(fetchResult.rawJson, query.contractAddress);
    if (!validation.isValid) {
      return {
        status: validation.status ?? 'INVALID_RESPONSE',
        data: null,
        error: { message: validation.reason ?? 'Failed to parse RWA price response.' },
        fetchedAt: Date.now()
      };
    }

    return {
      status: 'LIVE',
      data: validation.priceData!,
      fetchedAt: Date.now()
    };
  }

  /**
   * Retrieves market status and session timing for the underlying traditional asset.
   * Distinguishes: OPEN, CLOSED, PAUSED, HALTED, UNAVAILABLE, UNKNOWN.
   * Endpoint: GET /build/api/v1/dex/market/rwa/underlying-market-data
   */
  public async getUnderlyingMarketStatus(query: RwaPriceQuery): Promise<RwaDataResult<UnderlyingMarketStatusResult>> {
    const now = Date.now();

    if (!query || typeof query.contractAddress !== 'string' || query.contractAddress.trim().length === 0) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: 'Invalid query: contractAddress is required.' },
        fetchedAt: now
      };
    }

    const queryParams: Record<string, string | number> = {
      contractAddress: query.contractAddress.trim()
    };
    if (query.chainId !== undefined) {
      queryParams.chainId = String(query.chainId);
    }

    const endpointPath = '/api/v1/dex/market/rwa/underlying-market-data';
    const requestPath = `/build${endpointPath}`;
    const queryString = this.signer.canonicalizeQueryParams(queryParams);
    const fullUrl = `${this.baseUrl}${endpointPath}?${queryString}`;

    const headers = this.signer.signRequest({
      method: 'GET',
      requestPath,
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

    const validation = this.validateUnderlyingMarketDataResponse(fetchResult.rawJson);
    if (!validation.isValid) {
      return {
        status: validation.status ?? 'INVALID_RESPONSE',
        data: null,
        error: { message: validation.reason ?? 'Failed to parse underlying market data.' },
        fetchedAt: Date.now()
      };
    }

    return {
      status: 'LIVE',
      data: validation.marketData!,
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
    status: RwaClientStatus;
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

      // Handle server error responses (5xx)
      if (response.status >= 500) {
        return {
          status: 'UNAVAILABLE',
          rawJson: null,
          error: {
            code: response.status,
            message: `Binance server error (HTTP ${response.status}). Service temporarily unavailable.`
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
   * Defensive validation for RWA Token Search response.
   */
  private validateRwaSearchResponse(
    json: unknown,
    keyword: string
  ): {
    isValid: boolean;
    tokens: VerifiedRwaTokenMetadata[];
    status?: RwaClientStatus;
    reason?: string;
  } {
    if (typeof json !== 'object' || json === null) {
      return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: 'Response is not a JSON object.' };
    }

    const obj = json as Record<string, unknown>;
    const rawData = obj.data;

    if (!Array.isArray(rawData)) {
      return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: 'Field "data" is missing or not an array.' };
    }

    if (rawData.length === 0) {
      return {
        isValid: false,
        tokens: [],
        status: 'UNAVAILABLE',
        reason: `RWA token not found for keyword: "${keyword}".`
      };
    }

    const tokens: VerifiedRwaTokenMetadata[] = [];

    for (let i = 0; i < rawData.length; i++) {
      const item = rawData[i];
      if (typeof item !== 'object' || item === null) {
        return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: `Item at index ${i} is not an object.` };
      }

      const t = item as Record<string, unknown>;

      if (typeof t.contractAddress !== 'string' || t.contractAddress.trim().length === 0) {
        return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: `Item at index ${i} is missing contractAddress.` };
      }

      if (typeof t.symbol !== 'string' || t.symbol.trim().length === 0) {
        return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: `Item at index ${i} is missing symbol.` };
      }

      const decimals = typeof t.decimals === 'number' ? t.decimals : parseInt(String(t.decimals), 10);
      if (isNaN(decimals) || decimals < 0 || decimals > 36) {
        return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: `Item at index ${i} has invalid decimals.` };
      }

      tokens.push({
        chainId: String(t.chainId ?? ''),
        contractAddress: t.contractAddress.trim(),
        symbol: t.symbol.trim(),
        name: typeof t.name === 'string' ? t.name : t.symbol.trim(),
        decimals,
        underlyingTicker: typeof t.underlyingTicker === 'string' ? t.underlyingTicker : undefined,
        platformId: typeof t.platformId === 'number' ? t.platformId : undefined,
        isRiskToken: Boolean(t.isRiskToken)
      });
    }

    return { isValid: true, tokens };
  }

  /**
   * Defensive validation for RWA Price & Spread response.
   */
  private validatePriceAndSpreadResponse(
    json: unknown,
    expectedContract: string
  ): {
    isValid: boolean;
    priceData?: RwaPriceAndSpread;
    status?: RwaClientStatus;
    reason?: string;
  } {
    if (typeof json !== 'object' || json === null) {
      return { isValid: false, status: 'INVALID_RESPONSE', reason: 'Price response is not a JSON object.' };
    }

    const obj = json as Record<string, unknown>;
    let item: Record<string, unknown> | null = null;

    if (Array.isArray(obj.data)) {
      if (obj.data.length === 0) {
        return { isValid: false, status: 'UNAVAILABLE', reason: `No price data returned for ${expectedContract}.` };
      }
      item = obj.data[0] as Record<string, unknown>;
    } else if (typeof obj.data === 'object' && obj.data !== null) {
      item = obj.data as Record<string, unknown>;
    }

    if (!item) {
      return { isValid: false, status: 'INVALID_RESPONSE', reason: 'Field "data" is missing or empty.' };
    }

    // Extract onChainPrice
    const rawOnChain = item.onChainPrice ?? item.onchainPrice ?? item.tokenPrice;
    // Extract referencePrice
    const rawReference = item.referencePrice ?? item.underlyingPrice ?? item.stockPrice;

    // Validate onChainPrice
    const onChainNum = rawOnChain !== undefined && rawOnChain !== null ? parseFloat(String(rawOnChain)) : NaN;
    const hasValidOnChain = Number.isFinite(onChainNum) && onChainNum > 0;

    // Validate referencePrice
    const refNum = rawReference !== undefined && rawReference !== null ? parseFloat(String(rawReference)) : NaN;
    const hasValidRef = Number.isFinite(refNum) && refNum > 0;

    // Fail closed if BOTH prices are completely absent or invalid
    if (!hasValidOnChain && !hasValidRef) {
      return {
        isValid: false,
        status: 'INVALID_RESPONSE',
        reason: `Invalid price data: onChainPrice ("${rawOnChain}") and referencePrice ("${rawReference}") are both invalid.`
      };
    }

    // Calculate spread deterministically ONLY when both values are real, positive finite numbers
    let spread: number | null = null;
    if (hasValidOnChain && hasValidRef) {
      spread = (onChainNum - refNum) / refNum;
    }

    // Parse timestamp
    let updatedAt = Date.now();
    if (item.updatedAt !== undefined && item.updatedAt !== null) {
      const parsedTime = typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(String(item.updatedAt));
      if (!isNaN(parsedTime) && parsedTime > 0) {
        updatedAt = parsedTime;
      }
    }

    return {
      isValid: true,
      priceData: {
        chainId: String(item.chainId ?? '56'),
        contractAddress: String(item.contractAddress ?? expectedContract).trim(),
        onChainPrice: hasValidOnChain ? onChainNum : NaN,
        referencePrice: hasValidRef ? refNum : NaN,
        spread,
        updatedAt
      }
    };
  }

  /**
   * Defensive validation for Underlying Market Data response.
   */
  private validateUnderlyingMarketDataResponse(
    json: unknown
  ): {
    isValid: boolean;
    marketData?: UnderlyingMarketStatusResult;
    status?: RwaClientStatus;
    reason?: string;
  } {
    if (typeof json !== 'object' || json === null) {
      return { isValid: false, status: 'INVALID_RESPONSE', reason: 'Response is not a JSON object.' };
    }

    const obj = json as Record<string, unknown>;
    const data = (typeof obj.data === 'object' && obj.data !== null) ? (obj.data as Record<string, unknown>) : null;

    if (!data) {
      return { isValid: false, status: 'INVALID_RESPONSE', reason: 'Field "data" is missing or not an object.' };
    }

    // Extract status fields
    const rawMarketStatus = typeof data.marketStatus === 'string' ? data.marketStatus.toLowerCase().trim() : undefined;
    const rawStatus = typeof data.status === 'string' ? data.status.toLowerCase().trim() : undefined;
    const rawReasonCode = typeof data.reasonCode === 'string' ? data.reasonCode.toUpperCase().trim() : undefined;
    const rawReasonMsg = typeof data.reasonMsg === 'string' ? data.reasonMsg.trim() : undefined;
    const openState = typeof data.openState === 'boolean' ? data.openState : undefined;

    // Check if empty or unavailable
    if (!rawMarketStatus && !rawStatus && !rawReasonCode && openState === undefined) {
      return {
        isValid: true,
        marketData: {
          status: 'UNAVAILABLE',
          updatedAt: Date.now()
        }
      };
    }

    // Determine typed RwaMarketStatus
    const status = this.mapToRwaMarketStatus({
      marketStatus: rawMarketStatus,
      status: rawStatus,
      reasonCode: rawReasonCode,
      openState
    });

    // Parse timing fields
    const nextOpenTime = typeof data.nextOpenTime === 'number' && data.nextOpenTime > 0 ? data.nextOpenTime : undefined;
    const nextCloseTime = typeof data.nextCloseTime === 'number' && data.nextCloseTime > 0 ? data.nextCloseTime : undefined;

    let updatedAt = Date.now();
    if (data.updatedAt !== undefined && data.updatedAt !== null) {
      const parsedTime = typeof data.updatedAt === 'number' ? data.updatedAt : Date.parse(String(data.updatedAt));
      if (!isNaN(parsedTime) && parsedTime > 0) {
        updatedAt = parsedTime;
      }
    }

    return {
      isValid: true,
      marketData: {
        status,
        rawStatus: rawMarketStatus ?? rawStatus,
        rawReasonCode,
        rawReasonMsg,
        nextOpenTime,
        nextCloseTime,
        updatedAt
      }
    };
  }

  /**
   * Deterministic mapping to typed RwaMarketStatus.
   */
  private mapToRwaMarketStatus(fields: {
    marketStatus?: string;
    status?: string;
    reasonCode?: string;
    openState?: boolean;
  }): RwaMarketStatus {
    const s = fields.marketStatus ?? fields.status ?? '';
    const r = fields.reasonCode ?? '';

    // Halted check
    if (s.includes('halt') || r.includes('HALT')) {
      return 'HALTED';
    }

    // Paused check
    if (s.includes('pause') || r.includes('PAUSE') || r.includes('ASSET_PAUSED') || r.includes('MARKET_PAUSED')) {
      return 'PAUSED';
    }

    // Open check
    if (
      s === 'open' ||
      s === 'regular' ||
      s === 'premarket' ||
      s === 'postmarket' ||
      s === 'overnight' ||
      (fields.openState === true && r === 'TRADING') ||
      (fields.openState === true && !r)
    ) {
      return 'OPEN';
    }

    // Closed check
    if (s === 'closed' || r === 'MARKET_CLOSED' || fields.openState === false) {
      return 'CLOSED';
    }

    if (!s && !r && fields.openState === undefined) {
      return 'UNAVAILABLE';
    }

    return 'UNKNOWN';
  }
}

/**
 * BinanceRwaMarketStateProvider
 *
 * Implements StockPilot's pluggable IMarketStateProvider interface by delegating
 * to live status obtained from the Binance RWA Data API.
 */
export class BinanceRwaMarketStateProvider implements IMarketStateProvider {
  constructor(private readonly latestStatusSupplier: () => UnderlyingMarketStatusResult | null) {}

  public resolveMarketState(params: MarketStateParams): MarketState {
    if (params.forceState) {
      return params.forceState;
    }

    const latest = this.latestStatusSupplier();
    if (!latest) {
      return 'REFERENCE_STALE';
    }

    const ageSeconds = Math.max(0, Math.floor((params.currentTimestamp - latest.updatedAt) / 1000));
    if (ageSeconds > params.maxStalenessSeconds) {
      return 'REFERENCE_STALE';
    }

    if (latest.status === 'OPEN') {
      return 'MARKET_OPEN';
    }

    if (latest.status === 'CLOSED' || latest.status === 'PAUSED' || latest.status === 'HALTED') {
      return 'MARKET_CLOSED';
    }

    return 'REFERENCE_STALE';
  }
}
