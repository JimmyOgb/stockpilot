/**
 * StockPilot — Registry-Driven RWA Asset Resolver
 *
 * Dynamically resolves live tokenized equity assets on BSC Mainnet using Binance Web3 RWA API.
 * Separates logical underlying equity asset (e.g. "NVDA") from specific issuer derivative tokens
 * (e.g. bStocks "NVDAB" vs Ondo "NVDAon").
 *
 * Enforces Zero-Mock compliance and strict validation:
 * - Queries live Binance RWA registry by underlying ticker (e.g. keyword="NVDA").
 * - Validates BSC chain ID (56).
 * - Validates non-zero EVM contract address.
 * - Explicitly rejects invalidated stale addresses (0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495).
 * - Optionally verifies active on-chain bytecode via eth_getCode.
 * - Fails closed if no matching asset exists for requested issuer platform.
 */

import { BinanceRwaClient } from './rwa-client.js';
import { isValidEvmAddress, STALE_A34C_BNVDA_ADDRESS } from './wallet-balance-client.js';
import { RwaIssuerPlatform, RwaAssetDescriptor } from '../types/index.js';

export interface ResolveRwaAssetParams {
  underlyingTicker: string;          // e.g. "NVDA"
  issuerPlatform: RwaIssuerPlatform; // e.g. "bStocks" | "Ondo" | "xStocks"
  targetChainId?: string;            // Default: "56" (BSC Mainnet)
  verifyBytecode?: boolean;          // Optional BSC eth_getCode check
  bscRpcUrl?: string;
}

export interface ResolvedRwaAsset extends RwaAssetDescriptor {
  companyName: string;
  bytecodeVerified?: boolean;
}

export class BinanceRwaAssetResolver {
  constructor(
    private readonly rwaClient: BinanceRwaClient,
    private readonly defaultBscRpcUrl: string = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/',
    private readonly fetchFn: typeof fetch = globalThis.fetch
  ) {}

  /**
   * Resolves a logical stock asset + issuer platform (e.g. NVDA + bStocks)
   * to its live, validated on-chain token contract from Binance Web3 RWA registry.
   */
  public async resolveAsset(params: ResolveRwaAssetParams): Promise<ResolvedRwaAsset> {
    const ticker = params.underlyingTicker?.trim().toUpperCase();
    if (!ticker) {
      throw new Error('Asset resolution failed: underlyingTicker must be specified.');
    }

    const platform = params.issuerPlatform;
    if (!platform || !['bStocks', 'Ondo', 'xStocks'].includes(platform)) {
      throw new Error(`Asset resolution failed: unsupported or unknown issuer platform "${String(platform)}".`);
    }

    const targetChainId = String(params.targetChainId ?? '56').trim();

    // 1. Query Binance RWA Registry for underlying equity ticker
    const searchResult = await this.rwaClient.searchRwaToken({ keyword: ticker });
    if (searchResult.status !== 'LIVE' || !searchResult.data || searchResult.data.length === 0) {
      throw new Error(
        `Asset resolution failed: ticker "${ticker}" not found in Binance RWA registry (Status: ${searchResult.status}).`
      );
    }

    // 2. Locate exact underlying ticker entry
    const matchedTicker = searchResult.data.find(
      t => t.ticker.toUpperCase() === ticker
    );
    if (!matchedTicker) {
      throw new Error(
        `Asset resolution failed: no exact ticker match for "${ticker}" in Binance RWA search results.`
      );
    }

    // 3. Filter candidate assets for target chain (BSC Mainnet / Chain 56)
    const chainAssets = matchedTicker.assets.filter(
      a => String(a.binanceChainId) === targetChainId
    );
    if (chainAssets.length === 0) {
      throw new Error(
        `Asset resolution failed: no tokenized assets for "${ticker}" found on chain ID ${targetChainId}.`
      );
    }

    // 4. Select issuer platform asset with strict discrimination
    // Naming conventions in Binance RWA Registry on BSC:
    // - bStocks (Backed Finance): Symbol ends with "B" (e.g. NVDAB) or begins with "b" (e.g. bNVDA), strictly NOT ending in "on"
    // - Ondo Finance: Symbol ends with "on" (e.g. NVDAon) or contains "ondo"
    // - xStocks: Symbol ends with "x" or begins with "x"
    let selectedAsset = chainAssets.find(a => {
      const sym = a.tokenSymbol.trim();
      const symUpper = sym.toUpperCase();

      if (platform === 'bStocks') {
        // Must match bStocks pattern and NOT match Ondo pattern
        const isOndo = sym.toLowerCase().endsWith('on') || sym.toLowerCase().includes('ondo');
        if (isOndo) return false;
        return symUpper.endsWith('B') || sym.startsWith('b') || symUpper === `${ticker}B`;
      }

      if (platform === 'Ondo') {
        return sym.toLowerCase().endsWith('on') || sym.toLowerCase().includes('ondo');
      }

      if (platform === 'xStocks') {
        return sym.toLowerCase().endsWith('x') || sym.toLowerCase().startsWith('x');
      }

      return false;
    });

    // Secondary fallback by platformId if returned in registry
    if (!selectedAsset) {
      selectedAsset = chainAssets.find(a => {
        if (platform === 'bStocks' && (a.platformId === 3 || a.platformId === 0)) {
          // Verify symbol does not conflict with Ondo
          return !a.tokenSymbol.toLowerCase().endsWith('on');
        }
        if (platform === 'Ondo' && (a.platformId === 1 || a.tokenSymbol.toLowerCase().endsWith('on'))) {
          return true;
        }
        return false;
      });
    }

    if (!selectedAsset) {
      const availableSymbols = chainAssets.map(a => `${a.tokenSymbol} (${a.tokenContractAddress})`).join(', ');
      throw new Error(
        `Asset resolution failed: no matching ${platform} asset found on chain ${targetChainId} for "${ticker}". Discovered assets: [${availableSymbols}].`
      );
    }

    // 5. Strict address and chain validation
    const contractAddress = selectedAsset.tokenContractAddress.trim();

    if (!isValidEvmAddress(contractAddress, { allowZeroAddress: false })) {
      throw new Error(
        `Asset resolution failed: discovered contract address "${contractAddress}" is not a valid non-zero EVM address.`
      );
    }

    // Explicitly reject invalidated stale address
    if (contractAddress.toLowerCase() === STALE_A34C_BNVDA_ADDRESS.toLowerCase()) {
      throw new Error(
        `Asset resolution failed: discovered contract is the invalidated stale address ${STALE_A34C_BNVDA_ADDRESS}. Must use live registered asset.`
      );
    }

    // 6. Optional BSC on-chain bytecode verification via eth_getCode
    let bytecodeVerified = false;
    if (params.verifyBytecode) {
      const rpcUrl = params.bscRpcUrl || this.defaultBscRpcUrl;
      bytecodeVerified = await this.verifyContractBytecode(contractAddress, rpcUrl);
      if (!bytecodeVerified) {
        throw new Error(
          `Asset resolution failed: contract address ${contractAddress} has no deployed bytecode on BSC Mainnet.`
        );
      }
    }

    return {
      underlyingTicker: ticker,
      issuerPlatform: platform,
      tokenSymbol: selectedAsset.tokenSymbol.trim(),
      tokenContractAddress: contractAddress,
      binanceChainId: targetChainId,
      platformId: selectedAsset.platformId,
      companyName: matchedTicker.companyName,
      decimals: 18,
      bytecodeVerified
    };
  }

  /**
   * Queries BSC RPC eth_getCode to confirm a contract is actually deployed at the address.
   */
  public async verifyContractBytecode(contractAddress: string, rpcUrl: string): Promise<boolean> {
    try {
      const payload = {
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'eth_getCode',
        params: [contractAddress, 'latest']
      };

      const res = await this.fetchFn(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) return false;
      const json = await res.json() as Record<string, unknown>;
      const code = typeof json.result === 'string' ? json.result.trim().toLowerCase() : null;

      // '0x' or '0x0' indicates no bytecode at the address
      return !!code && code !== '0x' && code !== '0x0' && code.length > 2;
    } catch {
      return false;
    }
  }
}
