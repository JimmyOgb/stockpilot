/**
 * StockPilot — BinanceAgenticWalletCliClient Unit Tests
 *
 * Tests the programmatic client for the official Binance Agentic Wallet CLI:
 * 1. Executes baw wallet status --json
 * 2. Executes baw wallet settings --json
 * 3. Executes baw wallet tx-lock --binanceChainId 56 --json
 * 4. Executes baw wallet balance --binanceChainId 56 --json
 * 5. Executes baw approvals list --binanceChainId 56 --json
 * 6. Executes baw market-order quote --json
 * 7. Executes baw market-order swap --json
 * 8. Executes baw market-order list --orderId <id> --json
 * 9. Queries BSC RPC eth_getTransactionReceipt
 * 10. Handles CLI non-zero exit codes & structured error messages
 * 11. Handles BSC RPC timeout and HTTP errors
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BinanceAgenticWalletCliClient,
  CommandRunner
} from '../src/execution/binance-agentic-wallet-client.js';

describe('BinanceAgenticWalletCliClient', () => {
  it('1. getWalletStatus executes "baw wallet status --json" and returns status', async () => {
    const mockRunner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(cmd).toBe('baw');
      expect(args).toEqual(['wallet', 'status', '--json']);
      return {
        stdout: JSON.stringify({ success: true, data: { status: 'CONNECTED' } }),
        stderr: '',
        exitCode: 0
      };
    });

    const client = new BinanceAgenticWalletCliClient({ commandRunner: mockRunner });
    const status = await client.getWalletStatus();
    expect(status.status).toBe('CONNECTED');
    expect(mockRunner).toHaveBeenCalledTimes(1);
  });

  it('2. getWalletSettings executes "baw wallet settings --json" and parses quotas', async () => {
    const mockRunner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(cmd).toBe('baw');
      expect(args).toEqual(['wallet', 'settings', '--json']);
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            dailyLimit: 50000,
            quotaUsed: 1200,
            quotaLeft: 48800,
            tradeAllTokens: true,
            abnormalTxnHandling: 'AutoReject'
          }
        }),
        stderr: '',
        exitCode: 0
      };
    });

    const client = new BinanceAgenticWalletCliClient({ commandRunner: mockRunner });
    const settings = await client.getWalletSettings();
    expect(settings.dailyLimit).toBe(50000);
    expect(settings.quotaLeft).toBe(48800);
    expect(settings.tradeAllTokens).toBe(true);
  });

  it('3. getTxLock executes "baw wallet tx-lock --binanceChainId 56 --json"', async () => {
    const mockRunner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(args).toEqual(['wallet', 'tx-lock', '--binanceChainId', '56', '--json']);
      return {
        stdout: JSON.stringify({ success: true, data: { status: 'UNLOCKED' } }),
        stderr: '',
        exitCode: 0
      };
    });

    const client = new BinanceAgenticWalletCliClient({ commandRunner: mockRunner });
    const lock = await client.getTxLock('56');
    expect(lock.status).toBe('UNLOCKED');
  });

  it('4. getBalances executes "baw wallet balance ... --json"', async () => {
    const mockRunner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(args).toEqual(['wallet', 'balance', '--symbol', 'USDC', '--binanceChainId', '56', '--json']);
      return {
        stdout: JSON.stringify({
          success: true,
          data: [
            { symbol: 'USDC', address: '0x8ac7...', binanceChainId: '56', balance: '100.0', price: '1.0', value: '100.0' }
          ]
        }),
        stderr: '',
        exitCode: 0
      };
    });

    const client = new BinanceAgenticWalletCliClient({ commandRunner: mockRunner });
    const balances = await client.getBalances({ symbol: 'USDC', binanceChainId: '56' });
    expect(balances.length).toBe(1);
    expect(balances[0].symbol).toBe('USDC');
    expect(balances[0].balance).toBe('100.0');
  });

  it('5. getApprovals executes "baw approvals list --binanceChainId 56 --json"', async () => {
    const mockRunner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(args).toEqual(['approvals', 'list', '--binanceChainId', '56', '--json']);
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            list: [
              {
                tokenSymbol: 'USDC',
                tokenContract: '0x8ac7...',
                spender: '0x1111...',
                amount: 'unlimited',
                riskyLevel: 'low',
                binanceChainId: '56',
                type: 'approve'
              }
            ]
          }
        }),
        stderr: '',
        exitCode: 0
      };
    });

    const client = new BinanceAgenticWalletCliClient({ commandRunner: mockRunner });
    const approvals = await client.getApprovals('56');
    expect(approvals.length).toBe(1);
    expect(approvals[0].tokenSymbol).toBe('USDC');
  });

  it('6. getMarketOrderQuote executes "baw market-order quote ... --json"', async () => {
    const mockRunner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(args).toContain('market-order');
      expect(args).toContain('quote');
      expect(args).toContain('--fromTokenQty');
      expect(args).toContain('25');
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            fromCoinSymbol: 'USDC',
            fromCoinAmount: '25',
            toCoinSymbol: 'NVDAB',
            toCoinAmount: '0.125',
            slippage: 0.005
          }
        }),
        stderr: '',
        exitCode: 0
      };
    });

    const client = new BinanceAgenticWalletCliClient({ commandRunner: mockRunner });
    const quote = await client.getMarketOrderQuote({
      fromTokenQty: 25,
      fromToken: '0x8ac7...',
      toToken: '0x02fc...',
      binanceChainId: '56',
      slippage: '0.5'
    });

    expect(quote.fromCoinSymbol).toBe('USDC');
    expect(quote.toCoinAmount).toBe('0.125');
  });

  it('7. submitMarketOrderSwap executes "baw market-order swap ... --json"', async () => {
    const mockRunner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(args).toContain('market-order');
      expect(args).toContain('swap');
      expect(args).toContain('--fromTokenQty');
      expect(args).toContain('20');
      expect(args).toContain('--binanceChainId');
      expect(args).toContain('56');
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            orderId: '1234567890'
          }
        }),
        stderr: '',
        exitCode: 0
      };
    });

    const client = new BinanceAgenticWalletCliClient({ commandRunner: mockRunner });
    const swap = await client.submitMarketOrderSwap({
      fromTokenQty: 20,
      fromToken: '0x8ac7...',
      toToken: '0x02fc...',
      binanceChainId: '56',
      slippage: '0.5',
      mev: true,
      gasLevel: 'MEDIUM'
    });

    expect(swap.orderId).toBe('1234567890');
  });

  it('8. getMarketOrderDetail executes "baw market-order list --orderId <id> --json"', async () => {
    const mockRunner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(args).toContain('market-order');
      expect(args).toContain('list');
      expect(args).toContain('--orderId');
      expect(args).toContain('1234567890');
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            list: [
              {
                orderId: '1234567890',
                chain: '56',
                fromToken: '0x8ac7...',
                fromTokenQty: '20',
                toToken: '0x02fc...',
                toTokenQty: '0.1',
                status: 'FINISHED',
                txHash: '0xabc123...'
              }
            ]
          }
        }),
        stderr: '',
        exitCode: 0
      };
    });

    const client = new BinanceAgenticWalletCliClient({ commandRunner: mockRunner });
    const order = await client.getMarketOrderDetail('1234567890', '56');
    expect(order).not.toBeNull();
    expect(order?.orderId).toBe('1234567890');
    expect(order?.status).toBe('FINISHED');
    expect(order?.txHash).toBe('0xabc123...');
  });

  it('9. getBscTransactionReceipt calls BSC JSON-RPC eth_getTransactionReceipt', async () => {
    const validTxHash = '0x' + 'a'.repeat(64);
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: {
          transactionHash: validTxHash,
          blockNumber: '0x280de80', // 42000000
          blockHash: '0xblockhash123',
          from: '0xfrom123',
          to: '0xto123',
          status: '0x1',
          gasUsed: '0x22ab0',
          cumulativeGasUsed: '0x22ab0'
        }
      })
    })) as unknown as typeof fetch;

    const client = new BinanceAgenticWalletCliClient({ fetchFn: mockFetch });
    const receipt = await client.getBscTransactionReceipt(validTxHash);

    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe('0x1');
    expect(receipt?.blockNumber).toBe(42000000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('10. Handles CLI non-zero exit code with error message', async () => {
    const mockRunner: CommandRunner = vi.fn(async () => ({
      stdout: '',
      stderr: 'Error: wallet not signed in. Run "baw auth signin" first.',
      exitCode: 1
    }));

    const client = new BinanceAgenticWalletCliClient({ commandRunner: mockRunner });
    await expect(client.getWalletStatus()).rejects.toThrow('wallet not signed in');
  });

  it('11. Handles BSC RPC HTTP failure gracefully', async () => {
    const validTxHash = '0x' + 'b'.repeat(64);
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 503
    })) as unknown as typeof fetch;

    const client = new BinanceAgenticWalletCliClient({ fetchFn: mockFetch });
    await expect(
      client.getBscTransactionReceipt(validTxHash)
    ).rejects.toThrow('BSC RPC returned HTTP status 503');
  });
});
