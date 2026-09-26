/**
 * StockPilot — System Status Modal
 * Real telemetry inspection from /api/health
 */

import React, { useEffect, useState } from 'react';
import { X, Activity, ShieldCheck, Cpu, RefreshCw, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import type { SystemHealthStatus } from '../types/index.js';

export interface StatusModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const StatusModal: React.FC<StatusModalProps> = ({ isOpen, onClose }) => {
  const [health, setHealth] = useState<SystemHealthStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const fetchHealth = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      setHealth(data);
    } catch {
      // Offline fallback: fail-closed status
      setHealth({
        status: 'HALTED',
        network: 'BSC Mainnet',
        chainId: 56,
        marketState: 'REFERENCE_STALE',
        quoteFreshness: {
          lastTimestamp: Date.now(),
          ageSeconds: 9999,
          maxAllowedAgeSeconds: 900,
          isFresh: false
        },
        components: {
          binanceApiClient: 'UNCONFIGURED',
          genLayerVerifier: 'UNCONFIGURED',
          executionWallet: 'UNCONFIGURED'
        }
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchHealth();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-md transition-opacity duration-300"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-2xl border border-slate-700/80 bg-[#0B121E] shadow-2xl flex flex-col text-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800 bg-[#0F1827]">
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <h2 className="text-sm font-semibold tracking-[0.25em] uppercase text-white">
              SYSTEM TELEMETRY & GATE STATUS
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={fetchHealth}
              disabled={loading}
              className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600 transition-colors"
              title="Refresh Telemetry"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-emerald-400' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Overall Status Banner */}
          <div className="flex items-center justify-between p-4 rounded-xl border border-slate-800 bg-[#0E1726]">
            <div className="flex items-center gap-3">
              {health?.status === 'HEALTHY' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              )}
              <div>
                <div className="text-xs text-slate-400 uppercase tracking-wider">Operational Mode</div>
                <div className="text-base font-semibold text-white tracking-wide">
                  {health?.status === 'HEALTHY' ? 'SYSTEM HEALTHY • ACTIVE' : 'FAIL-CLOSED HALT ACTIVE'}
                </div>
              </div>
            </div>
            <div className="text-right">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium border border-slate-700 bg-slate-800/60 text-slate-200">
                Chain: BSC #56
              </span>
            </div>
          </div>

          {/* Grid of Key Subsystems */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Market State */}
            <div className="p-4 rounded-xl border border-slate-800 bg-[#0E1726]">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400 mb-2">
                <Activity className="w-4 h-4 text-cyan-400" />
                Market Session
              </div>
              <div className="text-lg font-mono font-medium text-white">
                {health?.marketState || 'CHECKING...'}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                {health?.marketState === 'MARKET_OPEN'
                  ? '50 bps normal execution slippage policy'
                  : health?.marketState === 'MARKET_CLOSED'
                  ? '25 bps closed session safety bounds applied'
                  : 'Reference stale: trade execution unconditionally blocked'}
              </div>
            </div>

            {/* Quote Freshness */}
            <div className="p-4 rounded-xl border border-slate-800 bg-[#0E1726]">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400 mb-2">
                <Clock className="w-4 h-4 text-purple-400" />
                Quote Freshness
              </div>
              <div className="text-lg font-mono font-medium text-white">
                {health?.quoteFreshness?.ageSeconds !== undefined
                  ? `${health.quoteFreshness.ageSeconds}s / ${health.quoteFreshness.maxAllowedAgeSeconds}s`
                  : 'UNAVAILABLE'}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                {health?.quoteFreshness?.isFresh
                  ? 'Quote within safe freshness threshold'
                  : 'FAIL-CLOSED: Quote age exceeds maximum staleness'}
              </div>
            </div>

            {/* GenLayer Intelligent Contract */}
            <div className="p-4 rounded-xl border border-slate-800 bg-[#0E1726]">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400 mb-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                GenLayer Independent Verifier
              </div>
              <div className="text-lg font-mono font-medium text-white">
                {health?.components?.genLayerVerifier || 'UNCONFIGURED'}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Off-chain consensus validator with custom LLM output comparator
              </div>
            </div>

            {/* Agentic Wallet */}
            <div className="p-4 rounded-xl border border-slate-800 bg-[#0E1726]">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400 mb-2">
                <Cpu className="w-4 h-4 text-blue-400" />
                Binance Agentic Wallet
              </div>
              <div className="text-lg font-mono font-medium text-white">
                {health?.components?.executionWallet || 'UNCONFIGURED'}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Strict spot rebalancing boundary with $25.00 live safety cap
              </div>
            </div>
          </div>

          {/* Zero-Mock Policy Guarantee */}
          <div className="p-4 rounded-xl border border-blue-900/40 bg-blue-950/20 text-xs text-blue-200/90 leading-relaxed">
            <span className="font-semibold text-blue-300 uppercase tracking-wider block mb-1">
              Zero-Mock Fail-Closed Invariant:
            </span>
            StockPilot never fabricates synthetic assets, simulated balances, or mock signatures. When real on-chain telemetry or API credentials are unconfigured, all execution gates fail closed.
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 bg-[#0F1827] flex items-center justify-between text-xs text-slate-400">
          <span>Target Chain: BSC Mainnet (56)</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-white hover:bg-slate-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
