/**
 * StockPilot — BinanceRwaAssetResolver Unit Tests
 *
 * Verifies registry-driven RWA discovery:
 * - Maps logical (NVDA + bStocks) to live registered token (NVDAB: 0x02fca66c1d1afb4e2a7884261eb00f63598a7436)
 * - Prevents cross-platform substitution (never returns NVDAon when bStocks requested)
 * - Rejects invalidated stale addresses (0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495)
 * - Validates chain ID (56) and EVM address format
 * - Fails closed on unknown platforms or missing assets
 * - Verifies BSC bytecode checks via eth_getCode
 */

import { describe, it, expect } from 'vitest';
import { BinanceRequestSigner } from '../src/binance/request-signer.js';
import { BinanceRwaClient } from '../src/binance/rwa-client.js';
import { BinanceRwaAssetResolver } from '../src/binance/asset-resolver.js';
import { isValidEvmAddress } from '../src/binance/wallet-balance-client.js';

describe('BinanceRwaAssetResolver', () => {
  const testApiKey = 'test-key-resolver';
  const testApiSecret = 'test-secret-resolver';
  const signer = new BinanceRequestSigner({ apiKey: testApiKey, apiSecret: testApiSecret });

  // Official live Binance Web3 RWA registry payload for NVDA
  const liveBinanceNvdaData = [
    {
      ticker: 'NVDA',
      companyName: 'Nvidia Corp',
      assets: [
        {
          platformId: 0,
          binanceChainId: '56',
          tokenContractAddress: '0xa9ee28c80f960b889dfbd1902055218cba016f75',
          tokenSymbol: 'NVDAon',
          assetType: 1
        },
        {
          platformId: 0,
          binanceChainId: 'CT_501',
          tokenContractAddress: 'gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo',
          tokenSymbol: 'NVDAon',
          assetType: 1
        },
        {
          platformId: 0,
          binanceChainId: '1',
          tokenContractAddress: '0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee',
          tokenSymbol: 'NVDAon',
          assetType: 1
        },
        {
          platformId: 0,
          binanceChainId: '56',
          tokenContractAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
          tokenSymbol: 'NVDAB',
          assetType: 1
        }
      ]
    }
  ];

  function createMockRwaClient(mockData: unknown = liveBinanceNvdaData): BinanceRwaClient {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: mockData,
        success: true
      }), { status: 200 });
    }) as unknown as typeof fetch;

    return new BinanceRwaClient({
      signer,
      fetchFn: mockFetch
    });
  }

  describe('Logical Asset & Issuer Resolution', () => {
    it('resolves NVDA + bStocks to NVDAB (0x02fca66c1d1afb4e2a7884261eb00f63598a7436) on BSC Mainnet', async () => {
      const rwaClient = createMockRwaClient();
      const resolver = new BinanceRwaAssetResolver(rwaClient);

      const resolved = await resolver.resolveAsset({
        underlyingTicker: 'NVDA',
        issuerPlatform: 'bStocks'
      });

      expect(resolved.underlyingTicker).toBe('NVDA');
      expect(resolved.issuerPlatform).toBe('bStocks');
      expect(resolved.tokenSymbol).toBe('NVDAB');
      expect(resolved.tokenContractAddress).toBe('0x02fca66c1d1afb4e2a7884261eb00f63598a7436');
      expect(resolved.binanceChainId).toBe('56');
      expect(resolved.decimals).toBe(18);
      expect(resolved.companyName).toBe('Nvidia Corp');
    });

    it('resolves NVDA + Ondo to NVDAon (0xa9ee28c80f960b889dfbd1902055218cba016f75) on BSC Mainnet', async () => {
      const rwaClient = createMockRwaClient();
      const resolver = new BinanceRwaAssetResolver(rwaClient);

      const resolved = await resolver.resolveAsset({
        underlyingTicker: 'NVDA',
        issuerPlatform: 'Ondo'
      });

      expect(resolved.underlyingTicker).toBe('NVDA');
      expect(resolved.issuerPlatform).toBe('Ondo');
      expect(resolved.tokenSymbol).toBe('NVDAon');
      expect(resolved.tokenContractAddress).toBe('0xa9ee28c80f960b889dfbd1902055218cba016f75');
      expect(resolved.binanceChainId).toBe('56');
    });

    it('strictly avoids selecting Ondo asset (NVDAon) when bStocks is requested', async () => {
      const rwaClient = createMockRwaClient();
      const resolver = new BinanceRwaAssetResolver(rwaClient);

      const resolved = await resolver.resolveAsset({
        underlyingTicker: 'NVDA',
        issuerPlatform: 'bStocks'
      });

      expect(resolved.tokenSymbol).not.toBe('NVDAon');
      expect(resolved.tokenContractAddress).not.toBe('0xa9ee28c80f960b889dfbd1902055218cba016f75');
      expect(resolved.tokenSymbol).toBe('NVDAB');
    });

    it('strictly avoids selecting bStocks asset (NVDAB) when Ondo is requested', async () => {
      const rwaClient = createMockRwaClient();
      const resolver = new BinanceRwaAssetResolver(rwaClient);

      const resolved = await resolver.resolveAsset({
        underlyingTicker: 'NVDA',
        issuerPlatform: 'Ondo'
      });

      expect(resolved.tokenSymbol).not.toBe('NVDAB');
      expect(resolved.tokenContractAddress).not.toBe('0x02fca66c1d1afb4e2a7884261eb00f63598a7436');
      expect(resolved.tokenSymbol).toBe('NVDAon');
    });
  });

  describe('Contract & Chain Validation', () => {
    it('fails closed if the discovered contract address is the invalidated stale address (0xA34C...)', async () => {
      const staleMockData = [
        {
          ticker: 'NVDA',
          companyName: 'Nvidia Corp',
          assets: [
            {
              platformId: 3,
              binanceChainId: '56',
              tokenContractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
              tokenSymbol: 'NVDAB',
              assetType: 1
            }
          ]
        }
      ];

      const rwaClient = createMockRwaClient(staleMockData);
      const resolver = new BinanceRwaAssetResolver(rwaClient);

      await expect(
        resolver.resolveAsset({
          underlyingTicker: 'NVDA',
          issuerPlatform: 'bStocks'
        })
      ).rejects.toThrowError(/invalidated stale address/);
    });

    it('fails closed if discovered asset is not on target chain ID (56)', async () => {
      const ethereumOnlyMockData = [
        {
          ticker: 'NVDA',
          companyName: 'Nvidia Corp',
          assets: [
            {
              platformId: 3,
              binanceChainId: '1', // Ethereum Mainnet only
              tokenContractAddress: '0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee',
              tokenSymbol: 'NVDAB',
              assetType: 1
            }
          ]
        }
      ];

      const rwaClient = createMockRwaClient(ethereumOnlyMockData);
      const resolver = new BinanceRwaAssetResolver(rwaClient);

      await expect(
        resolver.resolveAsset({
          underlyingTicker: 'NVDA',
          issuerPlatform: 'bStocks',
          targetChainId: '56'
        })
      ).rejects.toThrowError(/no tokenized assets for "NVDA" found on chain ID 56/);
    });

    it('fails closed if discovered contract address is malformed', async () => {
      const badAddressMockData = [
        {
          ticker: 'NVDA',
          companyName: 'Nvidia Corp',
          assets: [
            {
              platformId: 3,
              binanceChainId: '56',
              tokenContractAddress: 'not-a-valid-hex-address',
              tokenSymbol: 'NVDAB',
              assetType: 1
            }
          ]
        }
      ];

      const rwaClient = createMockRwaClient(badAddressMockData);
      const resolver = new BinanceRwaAssetResolver(rwaClient);

      await expect(
        resolver.resolveAsset({
          underlyingTicker: 'NVDA',
          issuerPlatform: 'bStocks'
        })
      ).rejects.toThrowError(/not a valid non-zero EVM address/);
    });

    it('fails closed for unknown or unsupported issuer platforms', async () => {
      const rwaClient = createMockRwaClient();
      const resolver = new BinanceRwaAssetResolver(rwaClient);

      await expect(
        // @ts-expect-error Testing invalid issuerPlatform
        resolver.resolveAsset({ underlyingTicker: 'NVDA', issuerPlatform: 'FakePlatform' })
      ).rejects.toThrowError(/unsupported or unknown issuer platform/);
    });

    it('fails closed if requested ticker does not exist in registry', async () => {
      const mockFetch = (async () => {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'success',
          data: [],
          success: true
        }), { status: 200 });
      }) as unknown as typeof fetch;

      const rwaClient = new BinanceRwaClient({ signer, fetchFn: mockFetch });
      const resolver = new BinanceRwaAssetResolver(rwaClient);

      await expect(
        resolver.resolveAsset({
          underlyingTicker: 'NONEXISTENT',
          issuerPlatform: 'bStocks'
        })
      ).rejects.toThrowError(/ticker "NONEXISTENT" not found in Binance RWA registry/);
    });
  });

  describe('Wallet Address Zero-Address Rejection', () => {
    it('strictly rejects the zero address (0x000...000) as an application wallet', () => {
      const zeroAddr = '0x0000000000000000000000000000000000000000';
      expect(isValidEvmAddress(zeroAddr)).toBe(false);
      expect(isValidEvmAddress(zeroAddr, { allowZeroAddress: false })).toBe(false);
      expect(isValidEvmAddress(zeroAddr, { allowZeroAddress: true })).toBe(true);

      // Normal non-zero address
      expect(isValidEvmAddress('0x02fca66c1d1afb4e2a7884261eb00f63598a7436')).toBe(true);
    });
  });

  describe('On-Chain Bytecode Verification (eth_getCode)', () => {
    it('verifies deployed contract when eth_getCode returns non-empty bytecode', async () => {
      const rwaClient = createMockRwaClient();
      const mockRpcFetch = (async () => {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: '0x608060405234801561001057600080fd5b50' // Valid bytecode
        }), { status: 200 });
      }) as unknown as typeof fetch;

      const resolver = new BinanceRwaAssetResolver(rwaClient, 'https://rpc.mock', mockRpcFetch);
      const isDeployed = await resolver.verifyContractBytecode('0x02fca66c1d1afb4e2a7884261eb00f63598a7436', 'https://rpc.mock');
      expect(isDeployed).toBe(true);

      const resolved = await resolver.resolveAsset({
        underlyingTicker: 'NVDA',
        issuerPlatform: 'bStocks',
        verifyBytecode: true,
        bscRpcUrl: 'https://rpc.mock'
      });
      expect(resolved.bytecodeVerified).toBe(true);
    });

    it('rejects contract and fails closed when eth_getCode returns 0x (no bytecode)', async () => {
      const rwaClient = createMockRwaClient();
      const mockRpcFetch = (async () => {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: '0x' // Empty code, contract not deployed
        }), { status: 200 });
      }) as unknown as typeof fetch;

      const resolver = new BinanceRwaAssetResolver(rwaClient, 'https://rpc.mock', mockRpcFetch);
      const isDeployed = await resolver.verifyContractBytecode('0x02fca66c1d1afb4e2a7884261eb00f63598a7436', 'https://rpc.mock');
      expect(isDeployed).toBe(false);

      await expect(
        resolver.resolveAsset({
          underlyingTicker: 'NVDA',
          issuerPlatform: 'bStocks',
          verifyBytecode: true,
          bscRpcUrl: 'https://rpc.mock'
        })
      ).rejects.toThrowError(/has no deployed bytecode on BSC Mainnet/);
    });
  });
});
