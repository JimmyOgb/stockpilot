/**
 * StockPilot — Wallet & Connected Portfolio Domain Types
 * BSC Mainnet (Chain ID 56)
 */

export type WalletConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'WRONG_NETWORK'
  | 'NO_WALLET_DETECTED'
  | 'CONNECTION_REJECTED';

export type WalletProviderType =
  | 'BINANCE_WEB3'
  | 'METAMASK'
  | 'INJECTED'
  | 'NONE';

export type PortfolioLoadStatus =
  | 'IDLE'
  | 'LOADING'
  | 'VERIFIED'
  | 'MISMATCH'
  | 'UNAVAILABLE'
  | 'INSUFFICIENT_LIVE_PORTFOLIO';

export interface ConnectedTokenBalance {
  symbol: string;
  name: string;
  contractAddress: string;
  decimals: number;
  rawBalance: string;
  formattedBalance: string;
  priceUsd: number;
  valueUsd: number;
  verificationStatus: 'VERIFIED' | 'MISMATCH' | 'UNAVAILABLE';
}

export interface WalletPortfolioResponse {
  success: boolean;
  walletAddress: string;
  chainId: number;
  network: string;
  balances: ConnectedTokenBalance[];
  totalValueUsd: number;
  isZeroPortfolio: boolean;
  portfolioStatus: 'VERIFIED' | 'MISMATCH' | 'UNAVAILABLE' | 'EMPTY';
  decisionState: 'INSUFFICIENT_LIVE_PORTFOLIO' | 'PORTFOLIO_READY' | 'UNAVAILABLE';
  executionGate: 'EXECUTION_BLOCKED' | 'READY';
  explanation: string;
  checkedAt: number;
  error?: string;
}

export interface WalletState {
  status: WalletConnectionStatus;
  providerType: WalletProviderType;
  address: string | null;
  chainId: number | null;
  isBscMainnet: boolean;
  error: string | null;
  portfolio: WalletPortfolioResponse | null;
  portfolioStatus: PortfolioLoadStatus;
}
