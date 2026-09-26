/**
 * StockPilot — Editorial Sticky Navigation Bar
 *
 * Implements premium editorial navigation:
 * - Left: STOCKPILOT
 * - Center: STRATEGY | MARKETS | VERIFICATION | EXECUTION
 * - Right: STATUS | MENU
 * - Uppercase typography, generous letter spacing, thin active underline
 * - Smooth color transition based on cinematic scroll position (p > 0.55 switches to white)
 * - Sleek frosted glass backdrop when scrolled into command center
 */

import React, { useState, useEffect } from 'react';
import { Info, Activity } from 'lucide-react';

export interface NavbarProps {
  scrollProgress: number;
  onOpenMobileMenu: () => void;
  activeItem?: string;
  onSelectItem?: (item: string) => void;
  onOpenStatus?: () => void;
  systemStatus?: string;
}

const NAV_ITEMS = [
  'STRATEGY',
  'MARKETS',
  'VERIFICATION',
  'EXECUTION'
];

export const Navbar: React.FC<NavbarProps> = ({
  scrollProgress,
  onOpenMobileMenu,
  activeItem = 'STOCKPILOT',
  onSelectItem,
  onOpenStatus,
  systemStatus = 'HEALTHY'
}) => {
  const [mounted, setMounted] = useState<boolean>(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setMounted(true);
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  // Adaptive palette: strictly switches when p > 0.55 (darker video portion)
  const isDarkPortion = scrollProgress > 0.55;
  const isPastHero = scrollProgress >= 0.98;

  const textColor = isPastHero || isDarkPortion ? 'text-white' : 'text-[#1D3045]';
  const borderColor = isPastHero || isDarkPortion ? 'border-white' : 'border-[#1D3045]';
  const iconColor = isPastHero || isDarkPortion ? 'text-white/80' : 'text-[#1D3045]/80';
  const hamburgerBg = isPastHero || isDarkPortion ? 'bg-white' : 'bg-[#1D3045]';

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 w-full px-6 sm:px-10 md:px-16 lg:px-20 transition-all duration-500 pointer-events-auto ${
        isPastHero
          ? 'py-4 bg-[#080D16]/90 backdrop-blur-md border-b border-slate-800/80 shadow-lg'
          : 'py-6 md:py-8 bg-transparent'
      }`}
    >
      <div className="flex items-center justify-between w-full max-w-7xl mx-auto">
        {/* ========================================================================= */}
        {/* LEFT: STOCKPILOT Brandmark                                                */}
        {/* ========================================================================= */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onSelectItem?.('STOCKPILOT')}
            className={`group text-xs sm:text-sm font-semibold tracking-[0.28em] uppercase transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${textColor} ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3'
            } focus:outline-none flex items-center gap-2`}
          >
            <span>STOCKPILOT</span>
            {isPastHero && (
              <span className="hidden sm:inline-block text-[9px] font-mono font-normal tracking-widest text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/40">
                LIVE
              </span>
            )}
          </button>
        </div>

        {/* ========================================================================= */}
        {/* CENTER: Editorial Navigation Items (STRATEGY, MARKETS, etc.)              */}
        {/* ========================================================================= */}
        <nav className="hidden lg:flex items-center gap-8 xl:gap-12">
          {NAV_ITEMS.map((item, index) => {
            const isActive = item === activeItem;
            return (
              <button
                key={item}
                onClick={() => onSelectItem?.(item)}
                style={{
                  transitionDelay: `${index * 70 + 80}ms`
                }}
                className={`relative text-xs tracking-[0.22em] uppercase font-medium transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${textColor} ${
                  mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3'
                } hover:opacity-100 py-1.5 focus:outline-none`}
              >
                {item}
                {isActive && (
                  <span
                    className={`absolute bottom-0 left-0 w-full h-[1.5px] ${
                      isPastHero || isDarkPortion ? 'bg-white' : 'bg-[#1D3045]'
                    } transition-colors duration-500`}
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* ========================================================================= */}
        {/* RIGHT: STATUS + MENU Controls                                             */}
        {/* ========================================================================= */}
        <div className="flex items-center gap-5 sm:gap-8">
          {/* STATUS trigger */}
          <button
            onClick={onOpenStatus}
            style={{ transitionDelay: '400ms' }}
            className={`flex items-center gap-2 text-xs tracking-[0.2em] uppercase font-medium transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${textColor} ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3'
            } hover:opacity-75 focus:outline-none`}
          >
            <span>STATUS</span>
            <div
              className={`w-5 h-5 rounded-full border ${borderColor} flex items-center justify-center transition-colors duration-500`}
            >
              <Info className={`w-3 h-3 ${iconColor} transition-colors duration-500`} />
            </div>
          </button>

          {/* Desktop MENU button */}
          <button
            onClick={onOpenMobileMenu}
            style={{ transitionDelay: '480ms' }}
            className={`hidden sm:inline-block text-xs tracking-[0.2em] uppercase font-medium transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${textColor} ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3'
            } hover:opacity-75 focus:outline-none`}
          >
            MENU
          </button>

          {/* Hamburger button (visible on mobile / below lg) */}
          <button
            onClick={onOpenMobileMenu}
            aria-label="Open menu"
            className="flex flex-col justify-center items-end gap-[5px] w-6 h-6 p-0.5 cursor-pointer lg:hidden focus:outline-none"
          >
            <span
              className={`w-6 h-[2px] ${hamburgerBg} rounded-full transition-colors duration-500`}
            />
            <span
              className={`w-6 h-[2px] ${hamburgerBg} rounded-full transition-colors duration-500`}
            />
            <span
              className={`w-4 h-[2px] ${hamburgerBg} rounded-full transition-colors duration-500`}
            />
          </button>
        </div>
      </div>
    </header>
  );
};
