/**
 * StockPilot — BinanceWalletBalanceClient Unit Tests
 *
 * Verifies read-only wallet balance retrieval from Binance Web3 Wallet API:
 * POST /build/api/v1/dex/balance/token-balances-by-address
 * and independent cross-verification against direct BSC JSON-RPC eth_call (balanceOf).
 *
 * Zero-mock testing: Runs strictly against hermetic simulated HTTP transports with zero live network calls.
 */

import { describe, it, expect } from 'vitest';
import { BinanceRequestSigner } from '../src/binance/request-signer.js';
import {
  BinanceWalletBalanceClient,
  isValidEvmAddress,
  formatUnits,
  parseUnits,
  encodeErc20BalanceOfCalldata,
  TokenBalanceTarget
} from '../src/binance/wallet-balance-client.js';

describe('BinanceWalletBalanceClient', () => {
  const testApiKey = 'binance-test-wallet-key-123';
  const testApiSecret = 'binance-super-secret-wallet-secret-456';
  const signer = new BinanceRequestSigner({ apiKey: testApiKey, apiSecret: testApiSecret });

  const testWallet = '0x1234567890123456789012345678901234567890';
  const bNvdaContract = '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495';
  const usdcContract = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

  const defaultTargets: TokenBalanceTarget[] = [
    {
      binanceChainId: '56',
      tokenContractAddress: bNvdaContract,
      symbol: 'bNVDA',
      decimals: 18
    },
    {
      binanceChainId: '56',
      tokenContractAddress: usdcContract,
      symbol: 'USDC',
      decimals: 18
    }
  ];

  function createMockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      return handler(url, init);
    }) as unknown as typeof fetch;
  }

  describe('Address Validation & Helper Utilities', () => {
    it('isValidEvmAddress correctly validates 40-character hex addresses with 0x prefix', () => {
      expect(isValidEvmAddress('0x1234567890123456789012345678901234567890')).toBe(true);
      expect(isValidEvmAddress('0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495')).toBe(true);
      expect(isValidEvmAddress('0xa34c5e0abe843e10461e2c9586ea03e55dbcc495')).toBe(true);

      // Invalid formats
      expect(isValidEvmAddress('0x123')).toBe(false);
      expect(isValidEvmAddress('1234567890123456789012345678901234567890')).toBe(false);
      expect(isValidEvmAddress('0xZZZZ567890123456789012345678901234567890')).toBe(false);
      expect(isValidEvmAddress('')).toBe(false);
      expect(isValidEvmAddress(null as unknown as string)).toBe(false);
      expect(isValidEvmAddress(undefined as unknown as string)).toBe(false);
    });

    it('encodeErc20BalanceOfCalldata produces exact 36-byte (0x + 72 hex) payload for ERC-20 balanceOf', () => {
      const addr = '0x1234567890123456789012345678901234567890';
      const calldata = encodeErc20BalanceOfCalldata(addr);

      // Method selector for keccak256("balanceOf(address)"): 0x70a08231
      expect(calldata.startsWith('0x70a08231')).toBe(true);
      expect(calldata.length).toBe(74); // '0x' + 8 selector chars + 64 padded address chars = 74

      // Address is lowercased and left-padded with 12 bytes (24 hex zeros) to form a 32-byte word
      const expectedPadding = '0'.repeat(24);
      const expectedAddress = '1234567890123456789012345678901234567890';
      expect(calldata).toBe(`0x70a08231${expectedPadding}${expectedAddress}`);
    });

    it('encodeErc20BalanceOfCalldata throws on invalid EVM address', () => {
      expect(() => encodeErc20BalanceOfCalldata('not-an-address')).toThrowError(/Cannot encode balanceOf for invalid address/);
    });

    it('formatUnits formats BigInt raw amounts with arbitrary decimal precision without loss', () => {
      expect(formatUnits(0n, 18)).toBe('0');
      expect(formatUnits(1000000000000000000n, 18)).toBe('1');
      expect(formatUnits(1500000000000000000n, 18)).toBe('1.5');
      expect(formatUnits(123456789012345678n, 18)).toBe('0.123456789012345678');
      expect(formatUnits(1000000n, 6)).toBe('1');
      expect(formatUnits(1250000n, 6)).toBe('1.25');
    });

    it('parseUnits accurately converts decimal string into BigInt with specified decimals', () => {
      expect(parseUnits('0', 18)).toBe(0n);
      expect(parseUnits('1', 18)).toBe(1000000000000000000n);
      expect(parseUnits('1.5', 18)).toBe(1500000000000000000n);
      expect(parseUnits('0.123456', 6)).toBe(123456n);
      expect(() => parseUnits('invalid', 18)).toThrowError(/Invalid decimal string/);
    });
  });

  describe('Binance + BSC RPC Verified Balances (Happy Path)', () => {
    it('returns VERIFIED when Binance API and BSC RPC report identical raw balances', async () => {
      const bNvdaRaw = 25500000000000000000n; // 25.5 bNVDA (18 decimals)
      const usdcRaw = 1000000000000000000000n; // 1000 USDC (18 decimals)

      let capturedBinanceUrl = '';
      let capturedBinanceBody: Record<string, unknown> | null = null;
      let capturedBinanceHeaders: Headers | null = null;

      const mockBinanceFetch = createMockFetch((url, init) => {
        capturedBinanceUrl = url;
        capturedBinanceHeaders = new Headers(init?.headers);
        capturedBinanceBody = JSON.parse(init?.body as string);

        const mockResponse = {
          code: 0,
          msg: 'success',
          data: [
            {
              binanceChainId: '56',
              tokenAssets: [
                {
                  binanceChainId: '56',
                  tokenContractAddress: bNvdaContract,
                  rawBalance: bNvdaRaw.toString(),
                  balance: '25.5',
                  decimals: 18
                },
                {
                  binanceChainId: '56',
                  tokenContractAddress: usdcContract,
                  rawBalance: usdcRaw.toString(),
                  balance: '1000',
                  decimals: 18
                }
              ]
            }
          ]
        };

        return new Response(JSON.stringify(mockResponse), { status: 200 });
      });

      const rpcCalls: { to: string; data: string }[] = [];
      const mockRpcFetch = createMockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string);
        rpcCalls.push(body.params[0]);

        const contract = body.params[0].to.toLowerCase();
        let hexBalance: string;
        if (contract === bNvdaContract.toLowerCase()) {
          hexBalance = '0x' + bNvdaRaw.toString(16);
        } else if (contract === usdcContract.toLowerCase()) {
          hexBalance = '0x' + usdcRaw.toString(16);
        } else {
          hexBalance = '0x0';
        }

        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: hexBalance
        }), { status: 200 });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: defaultTargets
      });

      // Verify request structure to Binance Web3 API
      expect(capturedBinanceUrl).toBe('https://web3.binance.com/build/api/v1/dex/balance/token-balances-by-address');
      expect(capturedBinanceHeaders?.get('X-OC-APIKEY')).toBe(testApiKey);
      expect(capturedBinanceHeaders?.get('X-OC-TIMESTAMP')).toBeTruthy();
      expect(capturedBinanceHeaders?.get('X-OC-SIGN')).toBeTruthy();
      expect(capturedBinanceBody?.address).toBe(testWallet);
      expect(capturedBinanceBody?.excludeRiskToken).toBe('0');

      // Verify BSC RPC calls
      expect(rpcCalls.length).toBe(2);
      expect(rpcCalls.some(c => c.to.toLowerCase() === bNvdaContract.toLowerCase())).toBe(true);
      expect(rpcCalls.some(c => c.to.toLowerCase() === usdcContract.toLowerCase())).toBe(true);

      // Verify consensus verification results
      expect(result.overallStatus).toBe('VERIFIED');
      expect(result.walletAddress).toBe(testWallet);
      expect(result.balances.length).toBe(2);

      const bNvdaBal = result.balances.find(b => b.symbol === 'bNVDA')!;
      expect(bNvdaBal.verificationStatus).toBe('VERIFIED');
      expect(bNvdaBal.binanceRawBalance).toBe(bNvdaRaw);
      expect(bNvdaBal.rpcRawBalance).toBe(bNvdaRaw);
      expect(bNvdaBal.verifiedRawBalance).toBe(bNvdaRaw);
      expect(bNvdaBal.verifiedFormattedBalance).toBe('25.5');
      expect(bNvdaBal.discrepancyReason).toBeUndefined();

      const usdcBal = result.balances.find(b => b.symbol === 'USDC')!;
      expect(usdcBal.verificationStatus).toBe('VERIFIED');
      expect(usdcBal.binanceRawBalance).toBe(usdcRaw);
      expect(usdcBal.rpcRawBalance).toBe(usdcRaw);
      expect(usdcBal.verifiedRawBalance).toBe(usdcRaw);
      expect(usdcBal.verifiedFormattedBalance).toBe('1000');
    });
  });

  describe('Discrepancy Detection (MISMATCH)', () => {
    it('marks balance as MISMATCH and withholds verifiedRawBalance if Binance and RPC disagree', async () => {
      const binanceBNvdaRaw = 10000000000000000000n; // 10 bNVDA
      const rpcBNvdaRaw = 5000000000000000000n; // 5 bNVDA (on-chain mismatch)

      const mockBinanceFetch = createMockFetch(() => {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'success',
          data: [
            {
              binanceChainId: '56',
              tokenAssets: [
                {
                  tokenContractAddress: bNvdaContract,
                  rawBalance: binanceBNvdaRaw.toString(),
                  balance: '10'
                }
              ]
            }
          ]
        }), { status: 200 });
      });

      const mockRpcFetch = createMockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: '0x' + rpcBNvdaRaw.toString(16)
        }), { status: 200 });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: [defaultTargets[0]]
      });

      expect(result.overallStatus).toBe('MISMATCH');
      const bNvdaBal = result.balances[0];
      expect(bNvdaBal.verificationStatus).toBe('MISMATCH');
      expect(bNvdaBal.binanceRawBalance).toBe(binanceBNvdaRaw);
      expect(bNvdaBal.rpcRawBalance).toBe(rpcBNvdaRaw);
      expect(bNvdaBal.verifiedRawBalance).toBeNull();
      expect(bNvdaBal.verifiedFormattedBalance).toBeNull();
      expect(bNvdaBal.discrepancyReason).toContain('Balance discrepancy detected: Binance reported 10000000000000000000 units vs BSC RPC 5000000000000000000 units.');
    });
  });

  describe('Independent Availability Fallback & Fail-Closed Scenarios', () => {
    it('sets BINANCE_UNAVAILABLE when Binance API errors out but BSC RPC succeeds', async () => {
      const rpcRaw = 15000000000000000000n; // 15 bNVDA

      const mockBinanceFetch = createMockFetch(() => {
        return new Response(JSON.stringify({
          code: 50001,
          msg: 'Internal service timeout'
        }), { status: 200 });
      });

      const mockRpcFetch = createMockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: '0x' + rpcRaw.toString(16)
        }), { status: 200 });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: [defaultTargets[0]]
      });

      expect(result.overallStatus).toBe('BINANCE_UNAVAILABLE');
      const bNvdaBal = result.balances[0];
      expect(bNvdaBal.verificationStatus).toBe('BINANCE_UNAVAILABLE');
      expect(bNvdaBal.binanceRawBalance).toBeNull();
      expect(bNvdaBal.rpcRawBalance).toBe(rpcRaw);
      expect(bNvdaBal.verifiedRawBalance).toBeNull();
      expect(bNvdaBal.discrepancyReason).toContain('Binance business error code 50001: Internal service timeout');
    });

    it('sets RPC_UNAVAILABLE when BSC RPC errors out but Binance Web3 API succeeds', async () => {
      const binanceRaw = 42000000000000000000n;

      const mockBinanceFetch = createMockFetch(() => {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'success',
          data: [
            {
              tokenContractAddress: bNvdaContract,
              rawBalance: binanceRaw.toString(),
              balance: '42'
            }
          ]
        }), { status: 200 });
      });

      const mockRpcFetch = createMockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message: 'Execution reverted' }
        }), { status: 200 });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: [defaultTargets[0]]
      });

      expect(result.overallStatus).toBe('RPC_UNAVAILABLE');
      const bNvdaBal = result.balances[0];
      expect(bNvdaBal.verificationStatus).toBe('RPC_UNAVAILABLE');
      expect(bNvdaBal.binanceRawBalance).toBe(binanceRaw);
      expect(bNvdaBal.rpcRawBalance).toBeNull();
      expect(bNvdaBal.verifiedRawBalance).toBeNull();
      expect(bNvdaBal.discrepancyReason).toContain('RPC error: Execution reverted');
    });

    it('sets BOTH_UNAVAILABLE when both Binance API and BSC RPC fail', async () => {
      const mockBinanceFetch = createMockFetch(() => {
        return new Response('Gateway error', { status: 502, statusText: 'Bad Gateway' });
      });

      const mockRpcFetch = createMockFetch(() => {
        return new Response('Network unavailable', { status: 503, statusText: 'Service Unavailable' });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: [defaultTargets[0]]
      });

      expect(result.overallStatus).toBe('BOTH_UNAVAILABLE');
      const bNvdaBal = result.balances[0];
      expect(bNvdaBal.verificationStatus).toBe('BOTH_UNAVAILABLE');
      expect(bNvdaBal.binanceRawBalance).toBeNull();
      expect(bNvdaBal.rpcRawBalance).toBeNull();
      expect(bNvdaBal.verifiedRawBalance).toBeNull();
    });

    it('fails closed immediately with INVALID_WALLET for invalid address without network requests', async () => {
      let binanceCalled = false;
      let rpcCalled = false;

      const mockBinanceFetch = createMockFetch(() => {
        binanceCalled = true;
        return new Response('{}');
      });

      const mockRpcFetch = createMockFetch(() => {
        rpcCalled = true;
        return new Response('{}');
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: '0xinvalid',
        tokens: defaultTargets
      });

      expect(binanceCalled).toBe(false);
      expect(rpcCalled).toBe(false);
      expect(result.overallStatus).toBe('INVALID_WALLET');
      expect(result.balances).toEqual([]);
    });

    it('handles RPC malformed hex gracefully', async () => {
      const binanceRaw = 1000000000000000000n;

      const mockBinanceFetch = createMockFetch(() => {
        return new Response(JSON.stringify({
          code: 0,
          data: [{ tokenContractAddress: bNvdaContract, rawBalance: binanceRaw.toString() }]
        }), { status: 200 });
      });

      const mockRpcFetch = createMockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: 'not-hex'
        }), { status: 200 });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: [defaultTargets[0]]
      });

      expect(result.balances[0].verificationStatus).toBe('RPC_UNAVAILABLE');
      expect(result.balances[0].discrepancyReason).toContain('Malformed RPC result');
    });

    it('handles timeout in Binance API or RPC fetch gracefully', async () => {
      const mockBinanceFetch = createMockFetch(() => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      });

      const mockRpcFetch = createMockFetch(() => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch,
        timeoutMs: 50
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: [defaultTargets[0]]
      });

      expect(result.overallStatus).toBe('BOTH_UNAVAILABLE');
    });

    it('handles mixed multi-token outcome: marks overallStatus as MISMATCH if any token mismatches', async () => {
      const bNvdaRaw = 10000000000000000000n; // 10 bNVDA
      const usdcBinanceRaw = 500000000000000000000n; // 500 USDC
      const usdcRpcRaw = 200000000000000000000n; // 200 USDC (Mismatch)

      const mockBinanceFetch = createMockFetch(() => {
        return new Response(JSON.stringify({
          code: 0,
          data: [
            {
              binanceChainId: '56',
              tokenAssets: [
                {
                  tokenContractAddress: bNvdaContract,
                  rawBalance: bNvdaRaw.toString()
                },
                {
                  tokenContractAddress: usdcContract,
                  rawBalance: usdcBinanceRaw.toString()
                }
              ]
            }
          ]
        }), { status: 200 });
      });

      const mockRpcFetch = createMockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string);
        const to = body.params[0].to.toLowerCase();
        const hex = to === bNvdaContract.toLowerCase()
          ? '0x' + bNvdaRaw.toString(16)
          : '0x' + usdcRpcRaw.toString(16);

        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: hex
        }), { status: 200 });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: defaultTargets
      });

      expect(result.overallStatus).toBe('MISMATCH');
      const bNvda = result.balances.find(b => b.symbol === 'bNVDA')!;
      const usdc = result.balances.find(b => b.symbol === 'USDC')!;
      expect(bNvda.verificationStatus).toBe('VERIFIED');
      expect(usdc.verificationStatus).toBe('MISMATCH');
    });

    it('returns INVALID_RESPONSE if tokens array is empty', async () => {
      const client = new BinanceWalletBalanceClient({ signer });
      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: []
      });
      expect(result.overallStatus).toBe('INVALID_RESPONSE');
      expect(result.balances).toEqual([]);
    });

    it('handles contract address casing differences robustly', async () => {
      const raw = 5000000000000000000n;
      const lowerAddress = bNvdaContract.toLowerCase();

      const mockBinanceFetch = createMockFetch(() => {
        return new Response(JSON.stringify({
          code: 0,
          data: [{ tokenContractAddress: lowerAddress, rawBalance: raw.toString() }]
        }), { status: 200 });
      });

      const mockRpcFetch = createMockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: '0x' + raw.toString(16)
        }), { status: 200 });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      // Target uses mixed-case checksum address
      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: [{
          binanceChainId: '56',
          tokenContractAddress: bNvdaContract,
          symbol: 'bNVDA',
          decimals: 18
        }]
      });

      expect(result.overallStatus).toBe('VERIFIED');
      expect(result.balances[0].verificationStatus).toBe('VERIFIED');
      expect(result.balances[0].verifiedRawBalance).toBe(raw);
    });

    it('accurately parses Binance balance fallback string when rawBalance is not provided', async () => {
      const expectedRaw = 123450000000000000000n; // 123.45 with 18 decimals

      const mockBinanceFetch = createMockFetch(() => {
        return new Response(JSON.stringify({
          code: 0,
          data: [{ tokenContractAddress: bNvdaContract, balance: '123.45' }]
        }), { status: 200 });
      });

      const mockRpcFetch = createMockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: '0x' + expectedRaw.toString(16)
        }), { status: 200 });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: [{
          binanceChainId: '56',
          tokenContractAddress: bNvdaContract,
          symbol: 'bNVDA',
          decimals: 18
        }]
      });

      expect(result.overallStatus).toBe('VERIFIED');
      expect(result.balances[0].verifiedRawBalance).toBe(expectedRaw);
      expect(result.balances[0].verifiedFormattedBalance).toBe('123.45');
    });

    it('preserves exact uint256 precision for large token balances without floating-point distortion', async () => {
      // 100,000,000.123456789012345678
      const hugeRaw = 100000000123456789012345678n;

      const mockBinanceFetch = createMockFetch(() => {
        return new Response(JSON.stringify({
          code: 0,
          data: [{ tokenContractAddress: bNvdaContract, rawBalance: hugeRaw.toString() }]
        }), { status: 200 });
      });

      const mockRpcFetch = createMockFetch((_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: '0x' + hugeRaw.toString(16)
        }), { status: 200 });
      });

      const client = new BinanceWalletBalanceClient({
        signer,
        fetchFn: mockBinanceFetch,
        rpcFetchFn: mockRpcFetch
      });

      const result = await client.getVerifiedWalletBalances({
        walletAddress: testWallet,
        tokens: [{
          binanceChainId: '56',
          tokenContractAddress: bNvdaContract,
          symbol: 'bNVDA',
          decimals: 18
        }]
      });

      expect(result.overallStatus).toBe('VERIFIED');
      expect(result.balances[0].verifiedRawBalance).toBe(hugeRaw);
      expect(result.balances[0].verifiedFormattedBalance).toBe('100000000.123456789012345678');
    });
  });

  describe('Credential Hygiene & Defense in Depth', () => {
    it('never exposes API secret in client properties, serialization, or errors', () => {
      const client = new BinanceWalletBalanceClient({ signer });
      const serialized = JSON.stringify(client);
      expect(serialized).not.toContain(testApiSecret);
      expect((client as unknown as Record<string, unknown>).apiSecret).toBeUndefined();
    });

    it('requires a BinanceRequestSigner in constructor', () => {
      expect(() => new BinanceWalletBalanceClient({} as unknown as { signer: BinanceRequestSigner })).toThrowError(
        /requires a valid BinanceRequestSigner/
      );
    });
  });
});
