/**
 * StockPilot — Typed Binance Web3 RWA Data Client
 *
 * Implements authenticated read-only interactions with the Binance Web3 RWA API:
 * 1. GET /api/v1/dex/market/rwa/search
 * 2. GET /api/v1/dex/market/rwa/price
 * 3. GET /api/v1/dex/market/rwa/underlying-market
 *
 * Enforces Zero-Mock compliance: All responses are defensively validated at runtime.
 * Malformed or missing data fails closed. Spreads are computed strictly when both
 * tokenPrice and referencePrice are valid positive numbers; otherwise returns null.
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

// 1. RWA Search Query & Response Types
export interface RwaTokenSearchQuery {
  keyword: string;
  platformId?: number;
}

export interface VerifiedRwaAsset {
  platformId: number;
  binanceChainId: string;
  tokenContractAddress: string;
  tokenSymbol: string;
  assetType?: string | number;
}

export interface VerifiedRwaTokenMetadata {
  ticker: string;
  companyName: string;
  assets: VerifiedRwaAsset[];
}

// 2. RWA Price & Spread Query & Response Types
export interface RwaPriceQuery {
  tokenContractAddresses: string | string[];
  binanceChainId?: string | number;
}

export interface RwaPriceAndSpread {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId?: number;
  tokenPrice: number;
  referencePrice: number;
  spread: number | null; // Real spread: (tokenPrice - referencePrice) / referencePrice, or null
  tokenPriceUpdatedAt: number;
}

// 3. Underlying Market Query & Response Types
export interface UnderlyingMarketQuery {
  tokenContractAddress: string;
  binanceChainId?: string | number;
}

export interface UnderlyingMarketStatusResult {
  status: RwaMarketStatus;
  rawMarketStatus?: string;
  rawReasonCode?: string | null;
  rawReasonMsg?: string | null;
  openState?: boolean;
  nextOpenTime?: number;
  nextCloseTime?: number;
  referencePrice?: number | null;
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
   * Official query params: keyword, optional platformId
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
    if (query.platformId !== undefined) {
      queryParams.platformId = query.platformId;
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
   * Retrieves tokenPrice and referencePrice, then calculates real spread.
   * spread = (tokenPrice - referencePrice) / referencePrice
   * If either price is missing, non-positive, or invalid, spread is returned as null (for '—' rendering).
   * Endpoint: GET /build/api/v1/dex/market/rwa/price
   * Official query params: binanceChainId, tokenContractAddresses
   */
  public async getRwaPriceAndSpread(query: RwaPriceQuery): Promise<RwaDataResult<RwaPriceAndSpread[]>> {
    const now = Date.now();

    if (!query) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: 'Invalid price query: query is required.' },
        fetchedAt: now
      };
    }

    const addressList = Array.isArray(query.tokenContractAddresses)
      ? query.tokenContractAddresses.map(a => a.trim()).filter(a => a.length > 0)
      : typeof query.tokenContractAddresses === 'string' && query.tokenContractAddresses.trim().length > 0
        ? [query.tokenContractAddresses.trim()]
        : [];

    if (addressList.length === 0) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: 'Invalid price query: tokenContractAddresses must contain at least one contract address.' },
        fetchedAt: now
      };
    }

    const queryParams: Record<string, string | number> = {
      binanceChainId: String(query.binanceChainId ?? '56'),
      tokenContractAddresses: addressList.join(',')
    };

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

    const validation = this.validatePriceAndSpreadResponse(fetchResult.rawJson, addressList);
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
      data: validation.priceData,
      fetchedAt: Date.now()
    };
  }

  /**
   * Retrieves market status and session timing for the underlying traditional asset.
   * Distinguishes: OPEN, CLOSED, PAUSED, HALTED, UNAVAILABLE, UNKNOWN.
   * Endpoint: GET /build/api/v1/dex/market/rwa/underlying-market
   * Official query params: binanceChainId, tokenContractAddress
   */
  public async getUnderlyingMarketStatus(query: UnderlyingMarketQuery): Promise<RwaDataResult<UnderlyingMarketStatusResult>> {
    const now = Date.now();

    if (!query || typeof query.tokenContractAddress !== 'string' || query.tokenContractAddress.trim().length === 0) {
      return {
        status: 'INVALID_RESPONSE',
        data: null,
        error: { message: 'Invalid query: tokenContractAddress is required.' },
        fetchedAt: now
      };
    }

    const queryParams: Record<string, string | number> = {
      binanceChainId: String(query.binanceChainId ?? '56'),
      tokenContractAddress: query.tokenContractAddress.trim()
    };

    const endpointPath = '/api/v1/dex/market/rwa/underlying-market';
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
   * Documented schema:
   * data[] -> ticker, companyName, assets[] -> platformId, binanceChainId, tokenContractAddress, tokenSymbol, assetType
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

      if (typeof t.ticker !== 'string' || t.ticker.trim().length === 0) {
        return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: `Item at index ${i} is missing ticker.` };
      }

      if (!Array.isArray(t.assets)) {
        return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: `Item at index ${i} is missing assets array.` };
      }

      const validatedAssets: VerifiedRwaAsset[] = [];
      for (let j = 0; j < t.assets.length; j++) {
        const a = t.assets[j];
        if (typeof a !== 'object' || a === null) {
          return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: `Asset at index ${i}.${j} is not an object.` };
        }
        const assetObj = a as Record<string, unknown>;

        if (typeof assetObj.tokenContractAddress !== 'string' || assetObj.tokenContractAddress.trim().length === 0) {
          return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: `Asset at index ${i}.${j} missing tokenContractAddress.` };
        }

        if (typeof assetObj.tokenSymbol !== 'string' || assetObj.tokenSymbol.trim().length === 0) {
          return { isValid: false, tokens: [], status: 'INVALID_RESPONSE', reason: `Asset at index ${i}.${j} missing tokenSymbol.` };
        }

        validatedAssets.push({
          platformId: typeof assetObj.platformId === 'number' ? assetObj.platformId : parseInt(String(assetObj.platformId), 10) || 0,
          binanceChainId: String(assetObj.binanceChainId ?? ''),
          tokenContractAddress: assetObj.tokenContractAddress.trim(),
          tokenSymbol: assetObj.tokenSymbol.trim(),
          assetType: typeof assetObj.assetType === 'string' || typeof assetObj.assetType === 'number' ? assetObj.assetType : undefined
        });
      }

      tokens.push({
        ticker: t.ticker.trim(),
        companyName: typeof t.companyName === 'string' ? t.companyName.trim() : t.ticker.trim(),
        assets: validatedAssets
      });
    }

    return { isValid: true, tokens };
  }

  /**
   * Defensive validation for RWA Price & Spread response.
   * Documented schema:
   * data[] -> binanceChainId, tokenContractAddress, platformId, tokenPrice, referencePrice, tokenPriceUpdatedAt
   */
  private validatePriceAndSpreadResponse(
    json: unknown,
    requestedAddresses: string[]
  ): {
    isValid: boolean;
    priceData: RwaPriceAndSpread[];
    status?: RwaClientStatus;
    reason?: string;
  } {
    if (typeof json !== 'object' || json === null) {
      return { isValid: false, priceData: [], status: 'INVALID_RESPONSE', reason: 'Price response is not a JSON object.' };
    }

    const obj = json as Record<string, unknown>;
    const rawData = obj.data;

    if (!Array.isArray(rawData)) {
      return { isValid: false, priceData: [], status: 'INVALID_RESPONSE', reason: 'Field "data" is missing or not an array.' };
    }

    if (rawData.length === 0) {
      return { isValid: false, priceData: [], status: 'UNAVAILABLE', reason: `No price data returned for requested tokens.` };
    }

    const priceList: RwaPriceAndSpread[] = [];

    for (let i = 0; i < rawData.length; i++) {
      const item = rawData[i];
      if (typeof item !== 'object' || item === null) {
        return { isValid: false, priceData: [], status: 'INVALID_RESPONSE', reason: `Price item at index ${i} is not an object.` };
      }

      const p = item as Record<string, unknown>;

      if (typeof p.tokenContractAddress !== 'string' || p.tokenContractAddress.trim().length === 0) {
        return { isValid: false, priceData: [], status: 'INVALID_RESPONSE', reason: `Price item at index ${i} missing tokenContractAddress.` };
      }

      // Extract official tokenPrice & referencePrice
      const rawTokenPrice = p.tokenPrice;
      const rawReferencePrice = p.referencePrice;

      // Validate tokenPrice
      const tokenPriceNum = rawTokenPrice !== undefined && rawTokenPrice !== null ? parseFloat(String(rawTokenPrice)) : NaN;
      const hasValidTokenPrice = Number.isFinite(tokenPriceNum) && tokenPriceNum > 0;

      // Validate referencePrice
      const refPriceNum = rawReferencePrice !== undefined && rawReferencePrice !== null ? parseFloat(String(rawReferencePrice)) : NaN;
      const hasValidRefPrice = Number.isFinite(refPriceNum) && refPriceNum > 0;

      // Fail closed if BOTH prices are completely absent or invalid
      if (!hasValidTokenPrice && !hasValidRefPrice) {
        return {
          isValid: false,
          priceData: [],
          status: 'INVALID_RESPONSE',
          reason: `Invalid price data at index ${i}: tokenPrice ("${rawTokenPrice}") and referencePrice ("${rawReferencePrice}") are both invalid.`
        };
      }

      // Calculate spread deterministically ONLY when both values are real, positive finite numbers
      let spread: number | null = null;
      if (hasValidTokenPrice && hasValidRefPrice) {
        spread = (tokenPriceNum - refPriceNum) / refPriceNum;
      }

      // Parse updatedAt
      let updatedAt = Date.now();
      const rawUpdatedAt = p.tokenPriceUpdatedAt ?? p.updatedAt;
      if (rawUpdatedAt !== undefined && rawUpdatedAt !== null) {
        const parsedTime = typeof rawUpdatedAt === 'number' ? rawUpdatedAt : Date.parse(String(rawUpdatedAt));
        if (!isNaN(parsedTime) && parsedTime > 0) {
          updatedAt = parsedTime;
        }
      }

      priceList.push({
        binanceChainId: String(p.binanceChainId ?? '56'),
        tokenContractAddress: p.tokenContractAddress.trim(),
        platformId: typeof p.platformId === 'number' ? p.platformId : undefined,
        tokenPrice: hasValidTokenPrice ? tokenPriceNum : NaN,
        referencePrice: hasValidRefPrice ? refPriceNum : NaN,
        spread,
        tokenPriceUpdatedAt: updatedAt
      });
    }

    return {
      isValid: true,
      priceData: priceList
    };
  }

  /**
   * Defensive validation for Underlying Market response.
   * Documented schema:
   * data -> statusInfo (openState, marketStatus, reasonCode, reasonMsg, nextOpenTime, nextCloseTime), marketData (referencePrice)
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

    // Extract statusInfo (documented) or direct fields (envelope fallback)
    const statusInfo = (typeof data.statusInfo === 'object' && data.statusInfo !== null)
      ? (data.statusInfo as Record<string, unknown>)
      : data;

    const rawMarketStatus = typeof statusInfo.marketStatus === 'string' ? statusInfo.marketStatus.toLowerCase().trim() : undefined;
    const rawReasonCode = typeof statusInfo.reasonCode === 'string' ? statusInfo.reasonCode.toUpperCase().trim() : (statusInfo.reasonCode === null ? null : undefined);
    const rawReasonMsg = typeof statusInfo.reasonMsg === 'string' ? statusInfo.reasonMsg.trim() : (statusInfo.reasonMsg === null ? null : undefined);
    const openState = typeof statusInfo.openState === 'boolean' ? statusInfo.openState : undefined;

    // Check if statusInfo is empty
    if (!rawMarketStatus && rawReasonCode === undefined && openState === undefined) {
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
      reasonCode: rawReasonCode ?? undefined,
      openState
    });

    // Parse timing fields
    const nextOpenTime = typeof statusInfo.nextOpenTime === 'number' && statusInfo.nextOpenTime > 0 ? statusInfo.nextOpenTime : undefined;
    const nextCloseTime = typeof statusInfo.nextCloseTime === 'number' && statusInfo.nextCloseTime > 0 ? statusInfo.nextCloseTime : undefined;

    // Parse marketData.referencePrice
    let referencePrice: number | null = null;
    const marketData = (typeof data.marketData === 'object' && data.marketData !== null) ? (data.marketData as Record<string, unknown>) : null;
    if (marketData && marketData.referencePrice !== undefined && marketData.referencePrice !== null) {
      const parsedRef = parseFloat(String(marketData.referencePrice));
      if (Number.isFinite(parsedRef) && parsedRef > 0) {
        referencePrice = parsedRef;
      }
    }

    let updatedAt = Date.now();
    const rawUpdatedAt = data.updatedAt ?? statusInfo.updatedAt;
    if (rawUpdatedAt !== undefined && rawUpdatedAt !== null) {
      const parsedTime = typeof rawUpdatedAt === 'number' ? rawUpdatedAt : Date.parse(String(rawUpdatedAt));
      if (!isNaN(parsedTime) && parsedTime > 0) {
        updatedAt = parsedTime;
      }
    }

    return {
      isValid: true,
      marketData: {
        status,
        rawMarketStatus,
        rawReasonCode,
        rawReasonMsg,
        openState,
        nextOpenTime,
        nextCloseTime,
        referencePrice,
        updatedAt
      }
    };
  }

  /**
   * Deterministic mapping to typed RwaMarketStatus.
   */
  private mapToRwaMarketStatus(fields: {
    marketStatus?: string;
    reasonCode?: string;
    openState?: boolean;
  }): RwaMarketStatus {
    const s = fields.marketStatus ?? '';
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
