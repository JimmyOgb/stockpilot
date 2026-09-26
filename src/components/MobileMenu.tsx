/**
 * StockPilot — Fullscreen Editorial Mobile Navigation Menu
 */

import React, { useEffect } from 'react';
import { X, ArrowRight, Activity, ShieldCheck } from 'lucide-react';

export interface MobileMenuProps {
  isOpen: boolean;
  onClose: () => void;
  activeItem?: string;
  onSelectItem?: (item: string) => void;
  onOpenStatus?: () => void;
}

const NAV_ITEMS = [
  'STOCKPILOT',
  'STRATEGY',
  'MARKETS',
  'VERIFICATION',
  'EXECUTION'
];

export const MobileMenu: React.FC<MobileMenuProps> = ({
  isOpen,
  onClose,
  activeItem = 'STOCKPILOT',
  onSelectItem,
  onOpenStatus
}) => {
  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen]);

  return (
    <div
      className={`fixed inset-0 z-[110] bg-[#080D16] transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] flex flex-col justify-between p-8 sm:p-12 ${
        isOpen ? 'opacity-100 visible pointer-events-auto' : 'opacity-0 invisible pointer-events-none'
      }`}
      aria-hidden={!isOpen}
      role="dialog"
      aria-modal="true"
    >
      {/* Top Bar with Brand and Close Button */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-white text-xs tracking-[0.25em] uppercase font-semibold">
            StockPilot
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close menu"
          className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center text-white/80 hover:text-white hover:border-white transition-colors duration-200"
        >
          <X className="w-[18px] h-[18px]" />
        </button>
      </div>

      {/* Centered Navigation Links with Staggered Entrance */}
      <div
        className={`flex flex-col items-center justify-center gap-6 sm:gap-8 my-auto transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          isOpen ? 'translate-y-0' : '-translate-y-8'
        }`}
      >
        {NAV_ITEMS.map((item, index) => {
          const isActive = item === activeItem;
          return (
            <button
              key={item}
              onClick={() => {
                onSelectItem?.(item);
                onClose();
              }}
              style={{
                transitionDelay: isOpen ? `${index * 50 + 80}ms` : '0ms'
              }}
              className={`text-2xl sm:text-4xl font-extralight tracking-widest uppercase transition-all duration-300 ${
                isActive ? 'text-white font-light' : 'text-white/50 hover:text-white'
              } ${isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}`}
            >
              {item}
            </button>
          );
        })}
      </div>

      {/* Footer Info & Actions */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-xs tracking-[0.2em] uppercase text-white/60 pt-6 border-t border-white/10">
        <button
          onClick={() => {
            onClose();
            onOpenStatus?.();
          }}
          className="hover:text-white transition-colors flex items-center gap-2"
        >
          <Activity className="w-3.5 h-3.5 text-cyan-400" />
          <span>System Status</span>
        </button>
        <span className="text-[11px] font-mono text-slate-500">BSC MAINNET CHAIN #56</span>
      </div>
    </div>
  );
};
