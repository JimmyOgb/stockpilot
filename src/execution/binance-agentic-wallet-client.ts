/**
 * StockPilot — Official Binance Agentic Wallet Client
 *
 * Implements the programmatic interface to the Binance Agentic Wallet (baw CLI & BSC RPC):
 * - Wallet session status & lock queries
 * - Security settings & remaining daily quota verification
 * - Token balances & active EVM approvals
 * - Spot market-order quotes & swaps (BSC Mainnet)
 * - Order lifecycle tracking to terminal states (FINISHED / FAILED)
 * - BSC Mainnet transaction receipt confirmation (eth_getTransactionReceipt)
 *
 * Zero-Mock & Security Invariants:
 * - NEVER implements private-key storage or exposes keys
 * - ALWAYS queries official wallet status, settings, tx-lock, and approvals
 * - NEVER bypasses wallet policy or auto-approves tokens silently
 * - STRICTLY spot orders only (market-order swap / quote)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AgenticWalletStatus,
  AgenticWalletSettings,
  AgenticWalletTxLock,
  AgenticWalletBalanceItem,
  AgenticWalletApprovalItem,
  AgenticMarketOrderQuoteParams,
  AgenticMarketOrderQuote,
  AgenticMarketOrderSwapParams,
  AgenticMarketOrderSwapResult,
  AgenticMarketOrderDetail,
  BscTransactionReceipt
} from '../types/index.js';

const execFileAsync = promisify(execFile);

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  command: string,
  args: string[]
) => Promise<CommandExecutionResult>;

export interface BinanceAgenticWalletClientConfig {
  cliBinaryPath?: string; // Default 'baw'
  commandRunner?: CommandRunner;
  bscRpcUrl?: string;     // Default 'https://bsc-dataseed.binance.org/'
  fetchFn?: typeof fetch;
  timeoutMs?: number;     // Default 15000ms
}

export interface IBinanceAgenticWalletClient {
  getWalletStatus(): Promise<AgenticWalletStatus>;
  getWalletSettings(): Promise<AgenticWalletSettings>;
  getTxLock(binanceChainId?: string): Promise<AgenticWalletTxLock>;
  getBalances(params?: {
    symbol?: string;
    tokenAddress?: string;
    binanceChainId?: string;
  }): Promise<AgenticWalletBalanceItem[]>;
  getApprovals(binanceChainId?: string): Promise<AgenticWalletApprovalItem[]>;
  getMarketOrderQuote(params: AgenticMarketOrderQuoteParams): Promise<AgenticMarketOrderQuote>;
  submitMarketOrderSwap(params: AgenticMarketOrderSwapParams): Promise<AgenticMarketOrderSwapResult>;
  getMarketOrderDetail(orderId: string, binanceChainId?: string): Promise<AgenticMarketOrderDetail | null>;
  getBscTransactionReceipt(txHash: string): Promise<BscTransactionReceipt | null>;
}

export class BinanceAgenticWalletCliClient implements IBinanceAgenticWalletClient {
  private readonly cliBinary: string;
  private readonly runner: CommandRunner;
  private readonly bscRpcUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config?: BinanceAgenticWalletClientConfig) {
    this.cliBinary = config?.cliBinaryPath ?? 'baw';
    this.bscRpcUrl = config?.bscRpcUrl ?? process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org/';
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
    this.timeoutMs = config?.timeoutMs ?? 15000;

    if (config?.commandRunner) {
      this.runner = config.commandRunner;
    } else {
      this.runner = async (command: string, args: string[]): Promise<CommandExecutionResult> => {
        try {
          const { stdout, stderr } = await execFileAsync(command, args, {
            timeout: this.timeoutMs,
            maxBuffer: 10 * 1024 * 1024
          });
          return { stdout, stderr, exitCode: 0 };
        } catch (err: unknown) {
          const error = err as { stdout?: string; stderr?: string; code?: number; message?: string };
          return {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? error.message ?? String(err),
            exitCode: error.code ?? 1
          };
        }
      };
    }
  }

  /**
   * Helper to execute baw CLI command and parse JSON output.
   */
  private async executeBawCommand<T>(args: string[]): Promise<T> {
    // Ensure --json is always passed for structured parsing
    const finalArgs = args.includes('--json') ? args : [...args, '--json'];
    const result = await this.runner(this.cliBinary, finalArgs);

    if (result.exitCode !== 0) {
      let parsedError: Record<string, unknown> | null = null;
      try {
        parsedError = JSON.parse(result.stdout || result.stderr);
      } catch {
        // Not JSON
      }

      const msg = parsedError?.message || parsedError?.error || result.stderr || result.stdout;
      throw new Error(`[BinanceAgenticWallet] CLI error (${this.cliBinary} ${args.join(' ')}): ${msg}`);
    }

    try {
      const parsed = JSON.parse(result.stdout) as {
        success?: boolean;
        data?: T;
        error?: string;
        message?: string;
      };

      if (parsed.success === false) {
        throw new Error(parsed.message || parsed.error || 'Agentic wallet operation unsuccessful.');
      }

      // If wrapped in { success: true, data: ... }
      if (parsed.data !== undefined) {
        return parsed.data as T;
      }
      return parsed as unknown as T;
    } catch (err: unknown) {
      if ((err as Error).message.includes('[BinanceAgenticWallet]')) {
        throw err;
      }
      throw new Error(`[BinanceAgenticWallet] Failed to parse CLI JSON response: ${(err as Error).message}. Raw output: ${result.stdout.slice(0, 300)}`);
    }
  }

  /**
   * Check wallet authentication & connection status.
   * Syntax: baw wallet status --json
   */
  public async getWalletStatus(): Promise<AgenticWalletStatus> {
    const data = await this.executeBawCommand<{ status: 'CONNECTED' | 'UNCONNECTED' | 'CREATING' }>(['wallet', 'status']);
    return { status: data.status };
  }

  /**
   * View the wallet's current security configuration and daily quota.
   * Syntax: baw wallet settings --json
   */
  public async getWalletSettings(): Promise<AgenticWalletSettings> {
    const data = await this.executeBawCommand<AgenticWalletSettings>(['wallet', 'settings']);
    return data;
  }

  /**
   * Check whether the wallet is currently locked from sending new transactions.
   * Syntax: baw wallet tx-lock --binanceChainId <id> --json
   */
  public async getTxLock(binanceChainId = '56'): Promise<AgenticWalletTxLock> {
    const data = await this.executeBawCommand<{ status: 'UNLOCKED' | 'LOCKED' }>([
      'wallet',
      'tx-lock',
      '--binanceChainId',
      binanceChainId
    ]);
    return { status: data.status };
  }

  /**
   * Query token balances. Only tokens with value >= $0.01 returned by CLI.
   * Syntax: baw wallet balance [--symbol <symbol>] [--tokenAddress <addr>] [--binanceChainId <id>] --json
   */
  public async getBalances(params?: {
    symbol?: string;
    tokenAddress?: string;
    binanceChainId?: string;
  }): Promise<AgenticWalletBalanceItem[]> {
    const args = ['wallet', 'balance'];
    if (params?.symbol) args.push('--symbol', params.symbol);
    if (params?.tokenAddress) args.push('--tokenAddress', params.tokenAddress);
    if (params?.binanceChainId) args.push('--binanceChainId', params.binanceChainId);

    const data = await this.executeBawCommand<AgenticWalletBalanceItem[]>(args);
    return Array.isArray(data) ? data : [];
  }

  /**
   * List active EVM token authorizations / approvals.
   * Syntax: baw approvals list [--binanceChainId <id>] --json
   */
  public async getApprovals(binanceChainId = '56'): Promise<AgenticWalletApprovalItem[]> {
    const args = ['approvals', 'list', '--binanceChainId', binanceChainId];
    const data = await this.executeBawCommand<{ list: AgenticWalletApprovalItem[] }>(args);
    return data.list || [];
  }

  /**
   * Get a spot swap quote without trading.
   * Syntax: baw market-order quote --fromTokenQty <qty> --fromToken <addr> --toToken <addr> --binanceChainId <id> [--slippage <slippage>] --json
   */
  public async getMarketOrderQuote(params: AgenticMarketOrderQuoteParams): Promise<AgenticMarketOrderQuote> {
    const args = [
      'market-order',
      'quote',
      '--fromTokenQty',
      String(params.fromTokenQty),
      '--fromToken',
      params.fromToken,
      '--toToken',
      params.toToken,
      '--binanceChainId',
      params.binanceChainId
    ];
    if (params.slippage) args.push('--slippage', params.slippage);

    return this.executeBawCommand<AgenticMarketOrderQuote>(args);
  }

  /**
   * Swap tokens on BSC Mainnet at current market price (SPOT ONLY).
   * Syntax: baw market-order swap --fromTokenQty <qty> --fromToken <addr> --toToken <addr> --binanceChainId 56 [--slippage <slippage>] [--mev true] --json
   */
  public async submitMarketOrderSwap(params: AgenticMarketOrderSwapParams): Promise<AgenticMarketOrderSwapResult> {
    const args = [
      'market-order',
      'swap',
      '--fromTokenQty',
      String(params.fromTokenQty),
      '--fromToken',
      params.fromToken,
      '--toToken',
      params.toToken,
      '--binanceChainId',
      params.binanceChainId
    ];
    if (params.slippage) args.push('--slippage', params.slippage);
    if (params.mev !== undefined) args.push('--mev', String(params.mev));
    if (params.gasLevel) args.push('--gasLevel', params.gasLevel);

    const result = await this.executeBawCommand<{ orderId: string }>(args);
    return { orderId: String(result.orderId) };
  }

  /**
   * Look up a specific market order by ID.
   * Syntax: baw market-order list --orderId <orderId> --json
   */
  public async getMarketOrderDetail(orderId: string, binanceChainId = '56'): Promise<AgenticMarketOrderDetail | null> {
    const args = ['market-order', 'list', '--orderId', orderId, '--binanceChainId', binanceChainId];
    const data = await this.executeBawCommand<{ list: AgenticMarketOrderDetail[] }>(args);

    if (data.list && data.list.length > 0) {
      return data.list[0];
    }
    return null;
  }

  /**
   * Confirm transaction execution on-chain via BSC JSON-RPC (eth_getTransactionReceipt).
   */
  public async getBscTransactionReceipt(txHash: string): Promise<BscTransactionReceipt | null> {
    if (!txHash || !txHash.startsWith('0x') || txHash.length !== 66) {
      return null;
    }

    try {
      const res = await this.fetchFn(this.bscRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [txHash]
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!res.ok) {
        throw new Error(`BSC RPC returned HTTP status ${res.status}`);
      }

      const json = (await res.json()) as {
        result?: {
          transactionHash: string;
          blockNumber: string;
          blockHash: string;
          from: string;
          to: string;
          status: string;
          gasUsed: string;
          cumulativeGasUsed: string;
          effectiveGasPrice?: string;
        } | null;
        error?: { message: string };
      };

      if (json.error) {
        throw new Error(`BSC RPC error: ${json.error.message}`);
      }

      if (!json.result) {
        // Transaction is still pending (not yet mined into a block)
        return null;
      }

      const raw = json.result;
      return {
        transactionHash: raw.transactionHash,
        blockNumber: parseInt(raw.blockNumber, 16),
        blockHash: raw.blockHash,
        from: raw.from,
        to: raw.to,
        status: raw.status as '0x1' | '0x0',
        gasUsed: raw.gasUsed,
        cumulativeGasUsed: raw.cumulativeGasUsed,
        effectiveGasPrice: raw.effectiveGasPrice
      };
    } catch (err: unknown) {
      throw new Error(`Failed to query BSC receipt for tx ${txHash}: ${(err as Error).message}`);
    }
  }
}
