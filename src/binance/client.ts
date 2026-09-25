/**
 * Binance Web3 API Client Interface
 * Handles portfolio balance polling, spot quote discovery, and market status checks.
 */

import { PortfolioBalance, MarketState } from '../types/index.js';

export interface SpotQuoteRequest {
  fromTokenAddress: string;
  toTokenAddress: string;
  amountInRaw: bigint;
  slippageToleranceBps: number;
}

export interface SpotQuoteResponse {
  quoteId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amountInRaw: bigint;
  expectedAmountOutRaw: bigint;
  minAmountOutRaw: bigint;
  priceImpactPct: number;
  routeData: unknown;
  quoteTimestamp: number;
}

export interface IBinanceWeb3Client {
  /**
   * Fetches tokenized stock and stablecoin balances for a given BSC wallet.
   */
  getWalletBalances(walletAddress: string): Promise<PortfolioBalance[]>;

  /**
   * Queries Binance Web3 swap / DEX aggregator for spot execution route.
   */
  getSpotQuote(request: SpotQuoteRequest): Promise<SpotQuoteResponse>;

  /**
   * Checks current reference market status and timestamp.
   */
  getReferenceMarketStatus(symbol: string): Promise<{
    state: MarketState;
    lastUpdated: number;
  }>;
}
