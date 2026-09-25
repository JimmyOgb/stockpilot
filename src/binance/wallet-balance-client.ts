/**
 * StockPilot — Typed Binance Web3 Wallet Balance Client with Direct BSC RPC Verification
 *
 * Implements authenticated read-only interactions with the Binance Web3 Wallet API:
 * - POST /build/api/v1/dex/balance/token-balances-by-address
 *
 * Pair-wise verified against an independent BSC JSON-RPC eth_call (ERC-20 balanceOf).
 * Enforces Zero-Mock compliance: Balances are strictly marked VERIFIED only when both
 * independent sources yield matching raw integer token amounts. Precision is preserved
 * via BigInt uint256 calculations.
 */

import { BinanceRequestSigner } from './request-signer.js';

export type BalanceVerificationStatus =
  | 'VERIFIED'
  | 'MISMATCH'
  | 'BINANCE_UNAVAILABLE'
  | 'RPC_UNAVAILABLE'
  | 'BOTH_UNAVAILABLE'
  | 'INVALID_WALLET'
  | 'INVALID_RESPONSE';

export interface BinanceWalletBalanceClientConfig {
  signer: BinanceRequestSigner;
  baseUrl?: string;
  bscRpcUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  rpcFetchFn?: typeof fetch;
}

export interface TokenBalanceTarget {
  tokenContractAddress: string;
  symbol: string;
  decimals: number;
  binanceChainId?: string | number;
}

export interface QueryWalletBalancesParams {
  walletAddress: string;
  tokens: TokenBalanceTarget[];
  excludeRiskToken?: '0' | '1';
}

export interface VerifiedTokenBalance {
  binanceChainId: string;
  tokenContractAddress: string;
  symbol: string;
  decimals: number;
  binanceRawBalance: bigint | null;
  binanceFormattedBalance: string | null;
  rpcRawBalance: bigint | null;
  rpcFormattedBalance: string | null;
  verifiedRawBalance: bigint | null; // Non-null ONLY if status === 'VERIFIED'
  verifiedFormattedBalance: string | null; // Non-null ONLY if status === 'VERIFIED'
  verificationStatus: BalanceVerificationStatus;
  checkedAt: number;
  discrepancyReason?: string;
}

export interface WalletPortfolioBalanceResult {
  walletAddress: string;
  balances: VerifiedTokenBalance[];
  overallStatus: BalanceVerificationStatus;
  checkedAt: number;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const STALE_A34C_BNVDA_ADDRESS = '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495';

/**
 * Validates Ethereum / BSC hex wallet addresses (0x + 40 hex chars).
 * Rejects the zero address (0x000...000) for active application portfolio wallets.
 */
export function isValidEvmAddress(
  address: string,
  options?: { allowZeroAddress?: boolean }
): boolean {
  if (typeof address !== 'string') return false;
  const trimmed = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return false;
  if (!options?.allowZeroAddress && trimmed.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    return false;
  }
  return true;
}

/**
 * Formats a raw integer token balance (BigInt) with its decimal precision into a human-readable string.
 * Completely avoids floating-point precision loss.
 */
export function formatUnits(rawAmount: bigint, decimals: number): string {
  if (rawAmount === 0n) return '0';
  const isNegative = rawAmount < 0n;
  const abs = isNegative ? -rawAmount : rawAmount;
  const str = abs.toString().padStart(decimals + 1, '0');
  const integerPart = str.slice(0, str.length - decimals) || '0';
  let fractionPart = str.slice(str.length - decimals);
  // Trim trailing zeros
  fractionPart = fractionPart.replace(/0+$/, '');
  const result = fractionPart.length > 0 ? `${integerPart}.${fractionPart}` : integerPart;
  return isNegative ? `-${result}` : result;
}

/**
 * Parses a decimal string into a raw BigInt integer balance using token decimals.
 */
export function parseUnits(formattedAmount: string, decimals: number): bigint {
  const trimmed = formattedAmount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal string: "${formattedAmount}"`);
  }
  const isNegative = trimmed.startsWith('-');
  const cleanStr = isNegative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ''] = cleanStr.split('.');
  const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals);
  const combined = BigInt(intPart + paddedFrac);
  return isNegative ? -combined : combined;
}

/**
 * Encodes an ERC-20 balanceOf(address) calldata:
 * Method selector: 0x70a08231 (keccak256("balanceOf(address)")[0..4])
 * Parameter: 32-byte left-padded wallet address.
 */
export function encodeErc20BalanceOfCalldata(walletAddress: string): string {
  if (!isValidEvmAddress(walletAddress)) {
    throw new Error(`Cannot encode balanceOf for invalid address: "${walletAddress}"`);
  }
  const cleanAddress = walletAddress.trim().toLowerCase().replace(/^0x/, '');
  const padded = cleanAddress.padStart(64, '0');
  return `0x70a08231${padded}`;
}

export class BinanceWalletBalanceClient {
  private readonly signer: BinanceRequestSigner;
  private readonly baseUrl: string;
  private readonly bscRpcUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly rpcFetchFn: typeof fetch;

  constructor(config: BinanceWalletBalanceClientConfig) {
    if (!config || !config.signer) {
      throw new Error('BinanceWalletBalanceClient requires a valid BinanceRequestSigner instance.');
    }
    this.signer = config.signer;
    const rawBase = (config.baseUrl ?? 'https://web3.binance.com/build').replace(/\/+$/, '');
    this.baseUrl = rawBase.endsWith('/build') ? rawBase : `${rawBase}/build`;
    this.bscRpcUrl = config.bscRpcUrl ?? (process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.rpcFetchFn = config.rpcFetchFn ?? this.fetchFn;
  }

  /**
   * Safe JSON representation preventing any credential leakage during serialization.
   */
  public toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      bscRpcUrl: this.bscRpcUrl,
      timeoutMs: this.timeoutMs
    };
  }

  /**
   * Retrieves wallet balances from Binance Web3 API and independently verifies each balance
   * against direct BSC JSON-RPC eth_call (balanceOf).
   */
  public async getVerifiedWalletBalances(
    params: QueryWalletBalancesParams
  ): Promise<WalletPortfolioBalanceResult> {
    const now = Date.now();

    // 1. Strict wallet address validation (fail closed before any network request)
    if (!params || !isValidEvmAddress(params.walletAddress)) {
      return {
        walletAddress: params?.walletAddress ?? '',
        balances: [],
        overallStatus: 'INVALID_WALLET',
        checkedAt: now
      };
    }

    const cleanWallet = params.walletAddress.trim();

    if (!Array.isArray(params.tokens) || params.tokens.length === 0) {
      return {
        walletAddress: cleanWallet,
        balances: [],
        overallStatus: 'INVALID_RESPONSE',
        checkedAt: now
      };
    }

    // 2. Query both independent sources concurrently
    const [binanceResult, rpcResults] = await Promise.all([
      this.fetchBinanceBalances(cleanWallet, params.tokens, params.excludeRiskToken ?? '0'),
      this.fetchRpcBalances(cleanWallet, params.tokens)
    ]);

    // 3. Reconcile and pair-wise verify each requested token balance
    const verifiedBalances: VerifiedTokenBalance[] = [];
    let hasVerified = false;
    let hasMismatch = false;
    let hasBinanceUnavailable = false;
    let hasRpcUnavailable = false;
    let hasBothUnavailable = false;

    for (const token of params.tokens) {
      const contractNorm = token.tokenContractAddress.trim().toLowerCase();
      const binanceItem = binanceResult.tokens.get(contractNorm);
      const rpcItem = rpcResults.get(contractNorm);

      const chainIdStr = String(token.binanceChainId ?? '56');
      let status: BalanceVerificationStatus;
      let verifiedRaw: bigint | null = null;
      let verifiedFormatted: string | null = null;
      let discrepancyReason: string | undefined;

      const binanceAvailable = binanceResult.isSuccess && binanceItem && binanceItem.rawBalance !== null;
      const rpcAvailable = rpcItem && rpcItem.isSuccess && rpcItem.rawBalance !== null;

      if (binanceAvailable && rpcAvailable && binanceItem && rpcItem && binanceItem.rawBalance !== null && rpcItem.rawBalance !== null) {
        const bRaw: bigint = binanceItem.rawBalance;
        const rRaw: bigint = rpcItem.rawBalance;
        if (bRaw === rRaw) {
          status = 'VERIFIED';
          verifiedRaw = bRaw;
          verifiedFormatted = formatUnits(verifiedRaw, token.decimals);
          hasVerified = true;
        } else {
          status = 'MISMATCH';
          discrepancyReason = `Balance discrepancy detected: Binance reported ${bRaw.toString()} units vs BSC RPC ${rRaw.toString()} units.`;
          hasMismatch = true;
        }
      } else if (!binanceAvailable && rpcAvailable) {
        status = 'BINANCE_UNAVAILABLE';
        discrepancyReason = `Binance Web3 API balance unavailable (${binanceResult.error ?? 'not found'}), but verified via BSC RPC.`;
        hasBinanceUnavailable = true;
      } else if (binanceAvailable && !rpcAvailable) {
        status = 'RPC_UNAVAILABLE';
        discrepancyReason = `BSC JSON-RPC balance unavailable (${rpcItem?.error ?? 'call failed'}), but provided via Binance Web3 API.`;
        hasRpcUnavailable = true;
      } else {
        status = 'BOTH_UNAVAILABLE';
        discrepancyReason = `Both Binance API and BSC JSON-RPC failed to retrieve balance.`;
        hasBothUnavailable = true;
      }

      verifiedBalances.push({
        binanceChainId: chainIdStr,
        tokenContractAddress: token.tokenContractAddress.trim(),
        symbol: token.symbol,
        decimals: token.decimals,
        binanceRawBalance: binanceItem?.rawBalance ?? null,
        binanceFormattedBalance: binanceItem?.formattedBalance ?? null,
        rpcRawBalance: rpcItem?.rawBalance ?? null,
        rpcFormattedBalance: rpcItem?.formattedBalance ?? null,
        verifiedRawBalance: verifiedRaw,
        verifiedFormattedBalance: verifiedFormatted,
        verificationStatus: status,
        checkedAt: now,
        discrepancyReason
      });
    }

    // Determine overall status
    let overallStatus: BalanceVerificationStatus = 'VERIFIED';
    if (hasMismatch) {
      overallStatus = 'MISMATCH';
    } else if (hasBothUnavailable) {
      overallStatus = 'BOTH_UNAVAILABLE';
    } else if (hasBinanceUnavailable && !hasRpcUnavailable && !hasVerified) {
      overallStatus = 'BINANCE_UNAVAILABLE';
    } else if (hasRpcUnavailable && !hasBinanceUnavailable && !hasVerified) {
      overallStatus = 'RPC_UNAVAILABLE';
    } else if (!hasVerified) {
      overallStatus = 'BOTH_UNAVAILABLE';
    }

    return {
      walletAddress: cleanWallet,
      balances: verifiedBalances,
      overallStatus,
      checkedAt: now
    };
  }

  /**
   * Internal helper: Queries Binance Web3 Wallet API for token balances.
   * Endpoint: POST /build/api/v1/dex/balance/token-balances-by-address
   */
  private async fetchBinanceBalances(
    walletAddress: string,
    tokens: TokenBalanceTarget[],
    excludeRiskToken: '0' | '1'
  ): Promise<{
    isSuccess: boolean;
    tokens: Map<string, { rawBalance: bigint | null; formattedBalance: string | null }>;
    error?: string;
  }> {
    const endpointPath = '/api/v1/dex/balance/token-balances-by-address';
    const requestPath = `/build${endpointPath}`;
    const fullUrl = `${this.baseUrl}${endpointPath}`;

    const bodyPayload = {
      address: walletAddress,
      tokenContractAddresses: tokens.map(t => ({
        binanceChainId: String(t.binanceChainId ?? '56'),
        tokenContractAddress: t.tokenContractAddress.trim()
      })),
      excludeRiskToken
    };

    const headers = this.signer.signRequest({
      method: 'POST',
      requestPath,
      body: bodyPayload,
      recvWindow: 60000
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(fullUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        return {
          isSuccess: false,
          tokens: new Map(),
          error: `HTTP ${response.status} ${response.statusText}`
        };
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        return {
          isSuccess: false,
          tokens: new Map(),
          error: 'Failed to parse Binance response JSON.'
        };
      }

      const validated = this.parseBinanceBalanceResponse(json, tokens);
      return validated;
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = (err as Error)?.name === 'AbortError';
      return {
        isSuccess: false,
        tokens: new Map(),
        error: isAbort ? `Binance request timed out after ${this.timeoutMs}ms.` : (err as Error)?.message ?? 'Network error'
      };
    }
  }

  /**
   * Internal helper: Defensively parses Binance balance response.
   */
  private parseBinanceBalanceResponse(
    json: unknown,
    targets: TokenBalanceTarget[]
  ): {
    isSuccess: boolean;
    tokens: Map<string, { rawBalance: bigint | null; formattedBalance: string | null }>;
    error?: string;
  } {
    const result = new Map<string, { rawBalance: bigint | null; formattedBalance: string | null }>();

    if (typeof json !== 'object' || json === null) {
      return { isSuccess: false, tokens: result, error: 'Binance response is not an object.' };
    }

    const envelope = json as Record<string, unknown>;
    if (envelope.code !== undefined && envelope.code !== 0) {
      return {
        isSuccess: false,
        tokens: result,
        error: `Binance business error code ${envelope.code}: ${envelope.msg ?? 'Unknown'}`
      };
    }

    const rawData = envelope.data;
    if (!Array.isArray(rawData)) {
      return { isSuccess: false, tokens: result, error: 'Field "data" is missing or not an array.' };
    }

    // Flatten possible nested tokenAssets structure
    const flattenedAssets: Record<string, unknown>[] = [];
    for (const item of rawData) {
      if (typeof item === 'object' && item !== null) {
        const itemObj = item as Record<string, unknown>;
        if (Array.isArray(itemObj.tokenAssets)) {
          for (const asset of itemObj.tokenAssets) {
            if (typeof asset === 'object' && asset !== null) {
              flattenedAssets.push(asset as Record<string, unknown>);
            }
          }
        } else if (itemObj.tokenContractAddress !== undefined || itemObj.balance !== undefined) {
          flattenedAssets.push(itemObj);
        }
      }
    }

    for (const target of targets) {
      const targetAddrNorm = target.tokenContractAddress.trim().toLowerCase();
      const matched = flattenedAssets.find(a =>
        typeof a.tokenContractAddress === 'string' &&
        a.tokenContractAddress.trim().toLowerCase() === targetAddrNorm
      );

      if (!matched) {
        result.set(targetAddrNorm, { rawBalance: null, formattedBalance: null });
        continue;
      }

      let rawBal: bigint | null = null;
      let formattedBal: string | null = null;

      if (typeof matched.rawBalance === 'string' && matched.rawBalance.trim().length > 0) {
        try {
          rawBal = BigInt(matched.rawBalance.trim());
          formattedBal = formatUnits(rawBal, target.decimals);
        } catch {
          rawBal = null;
        }
      } else if (typeof matched.balance === 'string' && matched.balance.trim().length > 0) {
        try {
          rawBal = parseUnits(matched.balance.trim(), target.decimals);
          formattedBal = matched.balance.trim();
        } catch {
          rawBal = null;
        }
      }

      result.set(targetAddrNorm, { rawBalance: rawBal, formattedBalance: formattedBal });
    }

    return {
      isSuccess: true,
      tokens: result
    };
  }

  /**
   * Internal helper: Queries BSC JSON-RPC eth_call (ERC-20 balanceOf) for each target token.
   */
  private async fetchRpcBalances(
    walletAddress: string,
    tokens: TokenBalanceTarget[]
  ): Promise<Map<string, { isSuccess: boolean; rawBalance: bigint | null; formattedBalance: string | null; error?: string }>> {
    const results = new Map<string, { isSuccess: boolean; rawBalance: bigint | null; formattedBalance: string | null; error?: string }>();

    const rpcPromises = tokens.map(async (token) => {
      const contractNorm = token.tokenContractAddress.trim().toLowerCase();
      try {
        const calldata = encodeErc20BalanceOfCalldata(walletAddress);
        const rpcPayload = {
          jsonrpc: '2.0',
          id: Math.floor(Math.random() * 1000000),
          method: 'eth_call',
          params: [
            {
              to: token.tokenContractAddress.trim(),
              data: calldata
            },
            'latest'
          ]
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await this.rpcFetchFn(this.bscRpcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(rpcPayload),
          signal: controller.signal
        });
        clearTimeout(timer);

        if (!response.ok) {
          results.set(contractNorm, {
            isSuccess: false,
            rawBalance: null,
            formattedBalance: null,
            error: `RPC HTTP ${response.status} ${response.statusText}`
          });
          return;
        }

        const rpcJson = await response.json() as Record<string, unknown>;
        if (rpcJson.error) {
          const errObj = rpcJson.error as Record<string, unknown>;
          results.set(contractNorm, {
            isSuccess: false,
            rawBalance: null,
            formattedBalance: null,
            error: `RPC error: ${errObj?.message ?? 'Unknown'}`
          });
          return;
        }

        const rawHex = typeof rpcJson.result === 'string' ? rpcJson.result.trim() : null;
        if (!rawHex || !rawHex.startsWith('0x') || rawHex === '0x') {
          results.set(contractNorm, {
            isSuccess: false,
            rawBalance: null,
            formattedBalance: null,
            error: `Malformed RPC result: "${rawHex}"`
          });
          return;
        }

        const rawBalance = BigInt(rawHex);
        const formattedBalance = formatUnits(rawBalance, token.decimals);

        results.set(contractNorm, {
          isSuccess: true,
          rawBalance,
          formattedBalance
        });
      } catch (err: unknown) {
        const isAbort = (err as Error)?.name === 'AbortError';
        results.set(contractNorm, {
          isSuccess: false,
          rawBalance: null,
          formattedBalance: null,
          error: isAbort ? `RPC request timed out after ${this.timeoutMs}ms.` : (err as Error)?.message ?? 'RPC error'
        });
      }
    });

    await Promise.all(rpcPromises);
    return results;
  }
}
