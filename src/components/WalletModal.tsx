/**
 * StockPilot — Institutional Wallet Connection Modal
 *
 * Supports:
 * - Binance Web3 Wallet (recommended for BSC / tokenized stocks)
 * - MetaMask / Injected EVM wallets
 * - Network switching to BSC Mainnet (Chain 56)
 * - Clear guidance when no provider is detected
 * - Clean rejection & retry handling
 */

import React from 'react';
import { X, ExternalLink, AlertTriangle, ShieldCheck, CheckCircle2, RefreshCw } from 'lucide-react';
import type { WalletConnectionStatus, WalletProviderType } from '../types/wallet.js';

export interface WalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: WalletConnectionStatus;
  providerType: WalletProviderType;
  address: string | null;
  abbreviatedAddress: string;
  chainId: number | null;
  error: string | null;
  onConnectBinance: () => void;
  onConnectInjected: () => void;
  onDisconnect: () => void;
  onSwitchToBsc: () => void;
}

export const WalletModal: React.FC<WalletModalProps> = ({
  isOpen,
  onClose,
  status,
  providerType,
  address,
  abbreviatedAddress,
  chainId,
  error,
  onConnectBinance,
  onConnectInjected,
  onDisconnect,
  onSwitchToBsc
}) => {
  if (!isOpen) return null;

  const isConnected = status === 'CONNECTED';
  const isWrongNetwork = status === 'WRONG_NETWORK';
  const isConnecting = status === 'CONNECTING';

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-md bg-[#0D1524] border border-slate-800 rounded-2xl shadow-2xl p-6 sm:p-8 text-slate-100 font-sans">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-6">
          <div>
            <div className="text-[10px] font-mono tracking-[0.25em] uppercase text-cyan-400 font-semibold">
              BSC MAINNET #56
            </div>
            <h3 className="text-lg font-light uppercase tracking-wider text-white">
              Connect Web3 Wallet
            </h3>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full border border-slate-700 hover:border-slate-500 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* State Banner: Wrong Network */}
        {isWrongNetwork && (
          <div className="mb-6 p-4 rounded-xl border border-amber-500/40 bg-amber-950/20 text-xs font-mono space-y-3">
            <div className="flex items-center gap-2 text-amber-400 font-semibold">
              <AlertTriangle className="w-4 h-4" />
              <span>WRONG NETWORK DETECTED</span>
            </div>
            <p className="text-slate-300 font-sans text-xs">
              Wallet is currently on Chain ID <span className="font-mono font-bold text-white">{chainId ?? 'Unknown'}</span>. StockPilot strictly requires <span className="font-mono text-cyan-300">BSC Mainnet (Chain 56)</span> for tokenized equity settlement.
            </p>
            <button
              onClick={onSwitchToBsc}
              className="w-full py-2.5 px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-[#09101C] font-mono text-xs uppercase font-bold tracking-wider transition-colors flex items-center justify-center gap-2"
            >
              <span>SWITCH TO BSC MAINNET</span>
            </button>
          </div>
        )}

        {/* State Banner: Connection Rejected */}
        {status === 'CONNECTION_REJECTED' && (
          <div className="mb-6 p-4 rounded-xl border border-rose-500/40 bg-rose-950/20 text-xs font-mono space-y-2">
            <div className="flex items-center gap-2 text-rose-400 font-semibold">
              <AlertTriangle className="w-4 h-4" />
              <span>CONNECTION REJECTED</span>
            </div>
            <p className="text-slate-300 font-sans text-xs">
              The connection signature or account access was rejected in your wallet.
            </p>
          </div>
        )}

        {/* State Banner: No Wallet Detected */}
        {status === 'NO_WALLET_DETECTED' && (
          <div className="mb-6 p-4 rounded-xl border border-amber-500/40 bg-amber-950/20 text-xs font-mono space-y-2">
            <div className="flex items-center gap-2 text-amber-400 font-semibold">
              <AlertTriangle className="w-4 h-4" />
              <span>NO EVM WALLET FOUND</span>
            </div>
            <p className="text-slate-300 font-sans text-xs leading-relaxed">
              No injected EVM provider was detected. Install the Binance Web3 Wallet extension, MetaMask, or open this application in the Binance Web3 Wallet mobile in-app browser.
            </p>
          </div>
        )}

        {/* Error message */}
        {error && status !== 'CONNECTION_REJECTED' && status !== 'WRONG_NETWORK' && status !== 'NO_WALLET_DETECTED' && (
          <div className="mb-6 p-3 rounded-lg border border-rose-800 bg-rose-950/30 text-rose-300 text-xs font-mono">
            {error}
          </div>
        )}

        {/* If Connected */}
        {isConnected ? (
          <div className="space-y-4">
            <div className="p-4 rounded-xl border border-emerald-900/60 bg-emerald-950/20 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase text-emerald-400 font-semibold">
                  STATUS: CONNECTED
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-900/50 text-emerald-300">
                  {providerType === 'BINANCE_WEB3' ? 'BINANCE WEB3' : 'EVM INJECTED'}
                </span>
              </div>
              <div className="font-mono text-sm text-white font-medium break-all">
                {address}
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 pt-2 border-t border-emerald-900/40">
                <span>Network: BSC Mainnet</span>
                <span>Chain ID: 56</span>
              </div>
            </div>

            <div className="flex gap-3">
              <a
                href={`https://bscscan.com/address/${address}`}
                target="_blank"
                rel="noreferrer"
                className="flex-1 py-2.5 px-3 rounded-lg border border-slate-700 hover:border-slate-500 text-xs font-mono text-center uppercase tracking-wider text-slate-300 hover:text-white flex items-center justify-center gap-1.5 transition-colors"
              >
                <span>View on BscScan</span>
                <ExternalLink className="w-3 h-3" />
              </a>
              <button
                onClick={() => {
                  onDisconnect();
                  onClose();
                }}
                className="py-2.5 px-5 rounded-lg border border-rose-900/60 hover:bg-rose-950/40 text-xs font-mono uppercase tracking-wider text-rose-300 hover:text-rose-200 transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          /* Wallet Connection Options */
          <div className="space-y-3">
            {/* Option 1: Binance Web3 Wallet */}
            <button
              onClick={onConnectBinance}
              disabled={isConnecting}
              className="w-full p-4 rounded-xl border border-slate-800 hover:border-yellow-500/60 bg-[#0B1220] hover:bg-yellow-950/10 transition-all flex items-center justify-between group disabled:opacity-50 text-left"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center font-mono font-bold text-yellow-400 text-sm">
                  BNB
                </div>
                <div>
                  <div className="text-xs font-semibold text-white uppercase tracking-wider group-hover:text-yellow-400 transition-colors">
                    Binance Web3 Wallet
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Official BNB Ecosystem Wallet
                  </div>
                </div>
              </div>
              <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-yellow-950/60 text-yellow-300 border border-yellow-800/40">
                RECOMMENDED
              </span>
            </button>

            {/* Option 2: MetaMask / Injected EVM */}
            <button
              onClick={onConnectInjected}
              disabled={isConnecting}
              className="w-full p-4 rounded-xl border border-slate-800 hover:border-cyan-500/60 bg-[#0B1220] hover:bg-cyan-950/10 transition-all flex items-center justify-between group disabled:opacity-50 text-left"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center font-mono font-bold text-cyan-400 text-sm">
                  EVM
                </div>
                <div>
                  <div className="text-xs font-semibold text-white uppercase tracking-wider group-hover:text-cyan-400 transition-colors">
                    MetaMask / Browser EVM
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Standard EIP-1193 / EIP-6963 provider
                  </div>
                </div>
              </div>
              <span className="text-[10px] font-mono uppercase text-slate-500">
                INJECTED
              </span>
            </button>

            {isConnecting && (
              <div className="p-3 rounded-lg border border-slate-800 bg-[#080D16] flex items-center justify-center gap-2 text-xs font-mono text-cyan-300 animate-pulse">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Awaiting signature in wallet provider...</span>
              </div>
            )}
          </div>
        )}

        {/* Security & Zero Key Policy Notice */}
        <div className="mt-6 pt-4 border-t border-slate-800/80 flex items-start gap-2.5 text-[11px] font-mono text-slate-500">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            Non-custodial connection. StockPilot never requests, stores, or accesses private keys or seed phrases.
          </p>
        </div>
      </div>
    </div>
  );
};
