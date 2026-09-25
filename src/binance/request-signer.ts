/**
 * StockPilot — Binance Web3 API Request Signer
 *
 * Implements deterministic HMAC-SHA256 request authentication
 * for the Binance Web3 API (X-OC-APIKEY, X-OC-TIMESTAMP, X-OC-SIGN).
 *
 * Independent of Express, UI, wallets, or trading logic.
 * NEVER logs or exposes the API secret.
 */

import { createHmac } from 'crypto';

export interface BinanceSignerConfig {
  apiKey: string;
  apiSecret: string;
}

export interface BinanceAuthHeaders {
  'X-OC-APIKEY': string;
  'X-OC-TIMESTAMP': string;
  'X-OC-SIGN': string;
  'X-OC-NONCE'?: string;
}

export interface SignRequestOptions {
  /**
   * Explicit timestamp (Date, millisecond epoch number, or ISO 8601 string).
   * Enables deterministic testing and NTP synchronization.
   */
  timestamp?: Date | number | string;

  /**
   * Optional anti-replay nonce.
   */
  nonce?: string;

  /**
   * Request query parameters as an object or raw query string.
   */
  queryParams?: Record<string, string | number | boolean | undefined | null> | string;

  /**
   * Request body (object to be serialized to JSON, or raw string).
   */
  body?: unknown;
}

export class BinanceRequestSigner {
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(config: BinanceSignerConfig) {
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid Binance credentials configuration: config object is required.');
    }

    if (!config.apiKey || typeof config.apiKey !== 'string' || config.apiKey.trim().length === 0) {
      throw new Error('Invalid Binance credentials: API key is required and cannot be empty.');
    }

    if (!config.apiSecret || typeof config.apiSecret !== 'string' || config.apiSecret.trim().length === 0) {
      throw new Error('Invalid Binance credentials: API secret is required and cannot be empty.');
    }

    this.apiKey = config.apiKey.trim();
    this.apiSecret = config.apiSecret.trim();
  }

  /**
   * Formats and validates the timestamp into UTC ISO 8601 with milliseconds (e.g. 2026-05-11T10:08:57.715Z).
   */
  public formatTimestamp(timestamp?: Date | number | string): string {
    if (!timestamp) {
      return new Date().toISOString();
    }

    if (timestamp instanceof Date) {
      if (isNaN(timestamp.getTime())) {
        throw new Error('Invalid timestamp: Date object is invalid.');
      }
      return timestamp.toISOString();
    }

    if (typeof timestamp === 'number') {
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error('Invalid timestamp: Epoch number must be a positive finite integer.');
      }
      return new Date(timestamp).toISOString();
    }

    if (typeof timestamp === 'string') {
      const trimmed = timestamp.trim();
      const parsed = Date.parse(trimmed);
      if (isNaN(parsed)) {
        throw new Error(`Invalid timestamp: String "${trimmed}" is not a valid ISO 8601 format.`);
      }
      // Ensure proper ISO representation
      return new Date(parsed).toISOString();
    }

    throw new Error('Invalid timestamp: Type must be Date, epoch number, or ISO 8601 string.');
  }

  /**
   * Canonicalizes query parameters by sorting keys alphabetically and URI-encoding components.
   */
  public canonicalizeQueryParams(
    params?: Record<string, string | number | boolean | undefined | null> | string
  ): string {
    if (!params) {
      return '';
    }

    if (typeof params === 'string') {
      let trimmed = params.trim();
      if (trimmed.startsWith('?')) {
        trimmed = trimmed.substring(1);
      }
      return trimmed;
    }

    if (typeof params === 'object') {
      const sortedKeys = Object.keys(params).sort();
      const pairs: string[] = [];

      for (const key of sortedKeys) {
        const val = params[key];
        if (val !== undefined && val !== null) {
          pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
        }
      }

      return pairs.join('&');
    }

    return '';
  }

  /**
   * Canonicalizes the request body. If given an object, serializes to deterministic JSON.
   */
  public canonicalizeBody(body?: unknown): string {
    if (body === undefined || body === null) {
      return '';
    }

    if (typeof body === 'string') {
      return body;
    }

    try {
      return JSON.stringify(body);
    } catch {
      throw new Error('Failed to canonicalize request body: JSON serialization failed.');
    }
  }

  /**
   * Constructs the payload string to sign according to the Binance Web3 API specification:
   * Combines canonical parameters (query or body) with the ISO 8601 timestamp.
   */
  public buildPayloadToSign(params: {
    canonicalQuery: string;
    canonicalBody: string;
    isoTimestamp: string;
  }): string {
    let payloadPart = '';

    if (params.canonicalQuery.length > 0) {
      payloadPart = params.canonicalQuery;
    } else if (params.canonicalBody.length > 0) {
      payloadPart = params.canonicalBody;
    }

    // Specification: Combining the request parameters with the X-OC-TIMESTAMP value
    return `${payloadPart}${params.isoTimestamp}`;
  }

  /**
   * Computes deterministic Base64-encoded HMAC-SHA256 signature.
   */
  public computeSignature(payloadToSign: string): string {
    return createHmac('sha256', this.apiSecret)
      .update(payloadToSign, 'utf8')
      .digest('base64');
  }

  /**
   * Generates the authenticated headers for a Binance Web3 API request.
   * NEVER exposes or returns the API secret.
   */
  public signRequest(options: SignRequestOptions = {}): BinanceAuthHeaders {
    const isoTimestamp = this.formatTimestamp(options.timestamp);
    const canonicalQuery = this.canonicalizeQueryParams(options.queryParams);
    const canonicalBody = this.canonicalizeBody(options.body);

    const payloadToSign = this.buildPayloadToSign({
      canonicalQuery,
      canonicalBody,
      isoTimestamp
    });

    const signature = this.computeSignature(payloadToSign);

    const headers: BinanceAuthHeaders = {
      'X-OC-APIKEY': this.apiKey,
      'X-OC-TIMESTAMP': isoTimestamp,
      'X-OC-SIGN': signature
    };

    if (options.nonce && typeof options.nonce === 'string' && options.nonce.trim().length > 0) {
      headers['X-OC-NONCE'] = options.nonce.trim();
    }

    return headers;
  }
}

/**
 * Factory helper to instantiate BinanceRequestSigner from environment or explicit config.
 */
export function createBinanceRequestSigner(config?: Partial<BinanceSignerConfig>): BinanceRequestSigner {
  const apiKey = config?.apiKey ?? process.env.BINANCE_WEB3_API_KEY;
  const apiSecret = config?.apiSecret ?? process.env.BINANCE_WEB3_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Cannot create BinanceRequestSigner: Missing BINANCE_WEB3_API_KEY or BINANCE_WEB3_API_SECRET.'
    );
  }

  return new BinanceRequestSigner({ apiKey, apiSecret });
}
