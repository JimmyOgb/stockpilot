/**
 * StockPilot — Production EVM & Binance Web3 Wallet Hook
 *
 * Implements real, secure, Zero-Mock wallet connection:
 * - Detects Binance Web3 Wallet (window.binance, provider.isBinance, or EIP-6963)
 * - Detects MetaMask / Injected EVM wallets (window.ethereum)
 * - EIP-6963 multi-wallet discovery support
 * - Enforces BSC Mainnet (Chain ID 56 / 0x38)
 * - Requests network switch / addition to BSC Mainnet when wrong network detected
 * - Handles user rejection (EIP-1193 4001) cleanly
 * - Persists session for active tab/session via sessionStorage
 * - Re-queries real BSC balances via /api/wallet/balances
 * - Zero fake addresses, zero private key requests or custody
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  WalletConnectionStatus,
  WalletProviderType,
  PortfolioLoadStatus,
  WalletPortfolioResponse,
  WalletState
} from '../types/wallet.js';

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<any>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  isBinance?: boolean;
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
}

export interface Eip6963ProviderDetail {
  info: {
    uuid: string;
    name: string;
    icon: string;
    rdns: string;
  };
  provider: Eip1193Provider;
}

export const BSC_CHAIN_ID_DECIMAL = 56;
export const BSC_CHAIN_ID_HEX = '0x38';

export const BSC_CHAIN_PARAMS = {
  chainId: BSC_CHAIN_ID_HEX,
  chainName: 'BNB Smart Chain Mainnet',
  nativeCurrency: {
    name: 'BNB',
    symbol: 'BNB',
    decimals: 18
  },
  rpcUrls: [
    'https://bsc-dataseed.binance.org/',
    'https://bsc-dataseed1.defibit.io/',
    'https://bsc-dataseed1.ninicoin.io/'
  ],
  blockExplorerUrls: ['https://bscscan.com']
};

export const SESSION_STORAGE_KEY = 'stockpilot_wallet_connected';
export const SESSION_PROVIDER_KEY = 'stockpilot_wallet_provider_type';

/**
 * Abbreviates an EVM hex address into 0x1234...ABCD format
 */
export function abbreviateAddress(address: string | null | undefined): string {
  if (!address || typeof address !== 'string' || address.length < 10) {
    return '0x........';
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function useWallet() {
  const [status, setStatus] = useState<WalletConnectionStatus>('DISCONNECTED');
  const [providerType, setProviderType] = useState<WalletProviderType>('NONE');
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [portfolio, setPortfolio] = useState<WalletPortfolioResponse | null>(null);
  const [portfolioStatus, setPortfolioStatus] = useState<PortfolioLoadStatus>('IDLE');

  const activeProviderRef = useRef<Eip1193Provider | null>(null);
  const announcedProvidersRef = useRef<Eip6963ProviderDetail[]>([]);

  // Listen to EIP-6963 announcements
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleAnnouncement = (event: Event) => {
      const customEvent = event as CustomEvent<Eip6963ProviderDetail>;
      if (customEvent.detail && customEvent.detail.provider) {
        const existingIdx = announcedProvidersRef.current.findIndex(
          p => p.info.uuid === customEvent.detail.info.uuid
        );
        if (existingIdx >= 0) {
          announcedProvidersRef.current[existingIdx] = customEvent.detail;
        } else {
          announcedProvidersRef.current.push(customEvent.detail);
        }
      }
    };

    window.addEventListener('eip6963:announceProvider', handleAnnouncement);
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    return () => {
      window.removeEventListener('eip6963:announceProvider', handleAnnouncement);
    };
  }, []);

  /**
   * Discovers the best matching available EVM wallet provider
   */
  const discoverProvider = useCallback(
    (preferredType?: 'BINANCE' | 'INJECTED'): { provider: Eip1193Provider; type: WalletProviderType } | null => {
      if (typeof window === 'undefined') return null;

      const win = window as any;

      // 1. Check EIP-6963 announced providers first
      if (announcedProvidersRef.current.length > 0) {
        if (preferredType === 'BINANCE') {
          const binanceAnnounced = announcedProvidersRef.current.find(
            p =>
              p.info.name.toLowerCase().includes('binance') ||
              p.info.rdns.toLowerCase().includes('binance') ||
              p.provider.isBinance
          );
          if (binanceAnnounced) {
            return { provider: binanceAnnounced.provider, type: 'BINANCE_WEB3' };
          }
        } else {
          const first = announcedProvidersRef.current[0];
          const isBinance =
            first.info.name.toLowerCase().includes('binance') ||
            first.info.rdns.toLowerCase().includes('binance') ||
            first.provider.isBinance;
          const isMetaMask = first.info.name.toLowerCase().includes('metamask') || first.provider.isMetaMask;
          return {
            provider: first.provider,
            type: isBinance ? 'BINANCE_WEB3' : isMetaMask ? 'METAMASK' : 'INJECTED'
          };
        }
      }

      // 2. Check window.binance / window.BinanceChain
      if (win.binance || win.BinanceChain) {
        const binanceProvider = win.binance || win.BinanceChain;
        if (typeof binanceProvider.request === 'function') {
          return { provider: binanceProvider, type: 'BINANCE_WEB3' };
        }
      }

      // 3. Check window.ethereum
      if (win.ethereum) {
        // If multiple injected providers exist:
        if (Array.isArray(win.ethereum.providers)) {
          if (preferredType === 'BINANCE') {
            const bp = win.ethereum.providers.find((p: any) => p.isBinance);
            if (bp && typeof bp.request === 'function') {
              return { provider: bp, type: 'BINANCE_WEB3' };
            }
          }
          const chosen = win.ethereum.providers[0];
          if (chosen && typeof chosen.request === 'function') {
            const isBinance = Boolean(chosen.isBinance);
            const isMetaMask = Boolean(chosen.isMetaMask);
            return {
              provider: chosen,
              type: isBinance ? 'BINANCE_WEB3' : isMetaMask ? 'METAMASK' : 'INJECTED'
            };
          }
        }

        if (typeof win.ethereum.request === 'function') {
          const isBinance = Boolean(win.ethereum.isBinance);
          const isMetaMask = Boolean(win.ethereum.isMetaMask);
          return {
            provider: win.ethereum,
            type: isBinance ? 'BINANCE_WEB3' : isMetaMask ? 'METAMASK' : 'INJECTED'
          };
        }
      }

      return null;
    },
    []
  );

  /**
   * Fetches real on-chain BSC balances from the backend
   */
  const loadPortfolioBalances = useCallback(async (targetAddress: string) => {
    if (!targetAddress) return;
    setPortfolioStatus('LOADING');
    try {
      const res = await fetch(`/api/wallet/balances?address=${encodeURIComponent(targetAddress)}`);
      const data: WalletPortfolioResponse = await res.json();
      if (res.ok && data.success) {
        setPortfolio(data);
        if (data.isZeroPortfolio) {
          setPortfolioStatus('INSUFFICIENT_LIVE_PORTFOLIO');
        } else if (data.portfolioStatus === 'MISMATCH') {
          setPortfolioStatus('MISMATCH');
        } else if (data.portfolioStatus === 'VERIFIED') {
          setPortfolioStatus('VERIFIED');
        } else {
          setPortfolioStatus('UNAVAILABLE');
        }
      } else {
        setPortfolioStatus('UNAVAILABLE');
        setError(data.error || 'Failed to load live BSC balances.');
      }
    } catch (err: unknown) {
      setPortfolioStatus('UNAVAILABLE');
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Network error loading balances: ${msg}`);
    }
  }, []);

  /**
   * Handles provider event listeners
   */
  const attachListeners = useCallback(
    (provider: Eip1193Provider) => {
      if (typeof provider.on !== 'function') return;

      const handleAccountsChanged = (accounts: string[]) => {
        if (!accounts || accounts.length === 0) {
          disconnectWallet();
        } else {
          const newAddress = accounts[0];
          setAddress(newAddress);
          setError(null);
          loadPortfolioBalances(newAddress);
        }
      };

      const handleChainChanged = (newChainIdHex: string) => {
        const parsed = parseInt(newChainIdHex, 16);
        setChainId(parsed);
        if (parsed === BSC_CHAIN_ID_DECIMAL) {
          setStatus('CONNECTED');
          setError(null);
          if (address) loadPortfolioBalances(address);
        } else {
          setStatus('WRONG_NETWORK');
          setError(`Connected to unsupported Chain ID ${parsed}. BSC Mainnet (#56) is required.`);
        }
      };

      const handleDisconnect = () => {
        disconnectWallet();
      };

      provider.on('accountsChanged', handleAccountsChanged);
      provider.on('chainChanged', handleChainChanged);
      provider.on('disconnect', handleDisconnect);
    },
    [address, loadPortfolioBalances]
  );

  /**
   * Disconnects the wallet and clears state
   */
  const disconnectWallet = useCallback(() => {
    try {
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        sessionStorage.removeItem(SESSION_PROVIDER_KEY);
      }
    } catch {
      // Ignore storage errors
    }
    activeProviderRef.current = null;
    setStatus('DISCONNECTED');
    setProviderType('NONE');
    setAddress(null);
    setChainId(null);
    setError(null);
    setPortfolio(null);
    setPortfolioStatus('IDLE');
  }, []);

  /**
   * Initiates the wallet connection flow
   */
  const connectWallet = useCallback(
    async (preferredType?: 'BINANCE' | 'INJECTED') => {
      setError(null);
      const match = discoverProvider(preferredType);

      if (!match) {
        setStatus('NO_WALLET_DETECTED');
        setError('No compatible Web3 wallet detected. Please install Binance Web3 Wallet or MetaMask, or open in Binance Web3 Wallet browser.');
        return;
      }

      const { provider, type } = match;
      activeProviderRef.current = provider;
      setProviderType(type);
      setStatus('CONNECTING');

      try {
        // Request accounts from wallet
        const accounts: string[] = await provider.request({
          method: 'eth_requestAccounts'
        });

        if (!accounts || accounts.length === 0) {
          setStatus('DISCONNECTED');
          setError('No EVM account returned from wallet provider.');
          return;
        }

        const currentAddress = accounts[0];
        setAddress(currentAddress);

        // Request chain ID
        const chainIdHex = await provider.request({ method: 'eth_chainId' });
        const currentChainId = parseInt(chainIdHex, 16);
        setChainId(currentChainId);

        // Attach event listeners for real-time changes
        attachListeners(provider);

        if (currentChainId === BSC_CHAIN_ID_DECIMAL) {
          setStatus('CONNECTED');
          try {
            sessionStorage.setItem(SESSION_STORAGE_KEY, 'true');
            sessionStorage.setItem(SESSION_PROVIDER_KEY, type);
          } catch {
            // Ignore storage errors
          }
          await loadPortfolioBalances(currentAddress);
        } else {
          setStatus('WRONG_NETWORK');
          setError(`Wallet is connected to Chain ID ${currentChainId}. StockPilot requires BSC Mainnet (Chain ID 56).`);
        }
      } catch (err: any) {
        // Check for user rejection (EIP-1193 code 4001)
        if (err?.code === 4001 || err?.message?.toLowerCase().includes('reject') || err?.message?.toLowerCase().includes('user denied')) {
          setStatus('CONNECTION_REJECTED');
          setError('Connection request was rejected in your wallet. Please retry to connect.');
        } else {
          setStatus('DISCONNECTED');
          setError(err?.message || 'Failed to connect wallet provider.');
        }
      }
    },
    [discoverProvider, attachListeners, loadPortfolioBalances]
  );

  /**
   * Requests wallet to switch or add BSC Mainnet (Chain 56)
   */
  const switchToBsc = useCallback(async () => {
    const provider = activeProviderRef.current || discoverProvider()?.provider;
    if (!provider) {
      setError('Cannot switch network: no active wallet provider found.');
      return;
    }

    setError(null);
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BSC_CHAIN_ID_HEX }]
      });
      setChainId(BSC_CHAIN_ID_DECIMAL);
      setStatus('CONNECTED');
      if (address) {
        await loadPortfolioBalances(address);
      }
    } catch (switchError: any) {
      // Error code 4902 indicates that the chain has not been added to the wallet
      if (switchError?.code === 4902 || switchError?.data?.originalError?.code === 4902) {
        try {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [BSC_CHAIN_PARAMS]
          });
          setChainId(BSC_CHAIN_ID_DECIMAL);
          setStatus('CONNECTED');
          if (address) {
            await loadPortfolioBalances(address);
          }
        } catch (addError: any) {
          setError(addError?.message || 'Failed to add BSC Mainnet to your wallet.');
        }
      } else if (switchError?.code === 4001) {
        setError('Network switch request was rejected in your wallet.');
      } else {
        setError(switchError?.message || 'Failed to switch network to BSC Mainnet.');
      }
    }
  }, [discoverProvider, address, loadPortfolioBalances]);

  /**
   * Silent session restore on mount if user had connected in this session
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let isConnectedSession = false;
    let savedType: WalletProviderType = 'NONE';
    try {
      isConnectedSession = sessionStorage.getItem(SESSION_STORAGE_KEY) === 'true';
      savedType = (sessionStorage.getItem(SESSION_PROVIDER_KEY) as WalletProviderType) || 'NONE';
    } catch {
      // Ignore
    }

    if (!isConnectedSession) return;

    const match = discoverProvider(savedType === 'BINANCE_WEB3' ? 'BINANCE' : undefined);
    if (!match) return;

    const { provider, type } = match;
    activeProviderRef.current = provider;
    setProviderType(type);

    // Call eth_accounts (silent check, zero popup)
    provider
      .request({ method: 'eth_accounts' })
      .then(async (accounts: string[]) => {
        if (accounts && accounts.length > 0) {
          const curAddr = accounts[0];
          setAddress(curAddr);
          const chainHex = await provider.request({ method: 'eth_chainId' });
          const curChain = parseInt(chainHex, 16);
          setChainId(curChain);
          attachListeners(provider);

          if (curChain === BSC_CHAIN_ID_DECIMAL) {
            setStatus('CONNECTED');
            loadPortfolioBalances(curAddr);
          } else {
            setStatus('WRONG_NETWORK');
          }
        } else {
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
        }
      })
      .catch(() => {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      });
  }, [discoverProvider, attachListeners, loadPortfolioBalances]);

  return {
    status,
    providerType,
    address,
    abbreviatedAddress: abbreviateAddress(address),
    chainId,
    isBscMainnet: chainId === BSC_CHAIN_ID_DECIMAL,
    error,
    portfolio,
    portfolioStatus,
    connectWallet,
    disconnectWallet,
    switchToBsc,
    reloadBalances: () => address && loadPortfolioBalances(address)
  };
}
