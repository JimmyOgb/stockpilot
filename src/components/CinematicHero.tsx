/**
 * StockPilot — Cinematic Hero Viewport
 *
 * Implements the full-screen 500vh scroll-tied video and frame-bank experience:
 * - Full-bleed video & 1920x1080 decoded canvas
 * - Precise sequential content opacities (previous section fully fades before next appears)
 * - Staggered entrance animations
 * - Elegant typography and navigation controls
 *
 * Exact sequential formulas:
 * s1Opacity: p < 0.20 -> 1; else -> max(0, 1 - (p - 0.20) / 0.08)
 * s2Opacity: p < 0.32 -> 0; p < 0.40 -> (p - 0.32) / 0.08; p < 0.55 -> 1; else -> max(0, 1 - (p - 0.55) / 0.08)
 * s3Opacity: p < 0.67 -> 0; p < 0.75 -> (p - 0.67) / 0.08; else -> 1
 */

import React from 'react';
import { ArrowRight, ArrowDown, ChevronUp } from 'lucide-react';

export interface CinematicHeroProps {
  containerRef: React.RefObject<HTMLDivElement>;
  videoRef: React.RefObject<HTMLVideoElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  scrollProgress: number;
  canvasLive: boolean;
  videoSrc: string;
  onLaunch?: () => void;
}

export const CinematicHero: React.FC<CinematicHeroProps> = ({
  containerRef,
  videoRef,
  canvasRef,
  scrollProgress,
  canvasLive,
  videoSrc,
  onLaunch
}) => {
  const p = scrollProgress;

  // Exact sequential opacity formulas from specification:
  const s1Opacity = p < 0.2 ? 1 : Math.max(0, 1 - (p - 0.2) / 0.08);

  const s2Opacity =
    p < 0.32
      ? 0
      : p < 0.4
      ? (p - 0.32) / 0.08
      : p < 0.55
      ? 1
      : Math.max(0, 1 - (p - 0.55) / 0.08);

  const s3Opacity = p < 0.67 ? 0 : p < 0.75 ? (p - 0.67) / 0.08 : 1;

  // Stagger visibility: children become active when section opacity > 0.3
  const s1Active = s1Opacity > 0.3;
  const s2Active = s2Opacity > 0.3;
  const s3Active = s3Opacity > 0.3;

  // Scene 2 Progressive Line Reveals tied directly to scroll progress
  const line1Opacity = p < 0.32 ? 0 : Math.min(1, Math.max(0, (p - 0.32) / 0.04));
  const line2Opacity = p < 0.36 ? 0 : Math.min(1, Math.max(0, (p - 0.36) / 0.04));
  const line3Opacity = p < 0.40 ? 0 : Math.min(1, Math.max(0, (p - 0.40) / 0.04));
  const line4Opacity = p < 0.44 ? 0 : Math.min(1, Math.max(0, (p - 0.44) / 0.04));

  // Scroll helper
  const scrollToProgress = (targetP: number) => {
    if (containerRef.current) {
      const totalScrollable = containerRef.current.offsetHeight - window.innerHeight;
      window.scrollTo({
        top: targetP * totalScrollable,
        behavior: 'smooth'
      });
    }
  };

  return (
    <div ref={containerRef} className="relative h-[500vh]">
      {/* Sticky Fullscreen Scene Viewport */}
      <div className="sticky top-0 w-full h-screen overflow-hidden">
        {/* Layer 1: Fallback HTML5 Video Element */}
        <video
          ref={videoRef}
          src={videoSrc}
          className="absolute inset-0 w-full h-full object-cover"
          muted
          playsInline
          preload="auto"
        />

        {/* Layer 2: Decoded-Frame WebCodecs Canvas (1920x1080) */}
        <canvas
          ref={canvasRef}
          width={1920}
          height={1080}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 pointer-events-none ${
            canvasLive ? 'opacity-100' : 'opacity-0'
          }`}
        />

        {/* Layer 3: Pointer-Events-None Content Overlay */}
        <div className="absolute inset-0 pointer-events-none">
          {/* ========================================================================= */}
          {/* 1. CINEMATIC HERO (SECTION 1: Opening Viewport)                           */}
          {/* ========================================================================= */}
          <section
            style={{
              opacity: s1Opacity,
              transition: 'opacity 0.1s ease-out'
            }}
            className="absolute inset-0 flex flex-col justify-center px-6 sm:px-12 md:px-20 lg:px-28 select-none"
          >
            <div className="max-w-5xl">
              {/* Brand Eyebrow */}
              <div
                style={{
                  transitionDelay: '0ms',
                  transitionDuration: '0.8s',
                  transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
                }}
                className={`text-xs sm:text-sm font-semibold tracking-[0.4em] uppercase text-[#1D3045]/80 mb-6 sm:mb-8 transition-all ${
                  s1Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                STOCKPILOT
              </div>

              {/* Extremely Large Editorial Headline */}
              <h1
                style={{
                  transitionDelay: '100ms',
                  transitionDuration: '0.9s',
                  transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
                }}
                className={`text-[#1D3045] font-light uppercase leading-[0.92] tracking-[-0.03em] text-[clamp(2.75rem,8vw,7.5rem)] transition-all ${
                  s1Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
                }`}
              >
                <span className="block">AUTONOMOUS</span>
                <span className="block">INTELLIGENCE</span>
                <span className="block">FOR TOKENIZED</span>
                <span className="block">MARKETS</span>
              </h1>

              {/* Subtitle */}
              <p
                style={{
                  transitionDelay: '250ms',
                  transitionDuration: '0.8s',
                  transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
                }}
                className={`mt-8 sm:mt-12 text-xs sm:text-sm tracking-[0.3em] uppercase text-[#1D3045]/90 font-medium transition-all ${
                  s1Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                REAL DATA. INDEPENDENT VERIFICATION. CONTROLLED EXECUTION.
              </p>

              {/* Instant Enter StockPilot Call-to-Action */}
              <div
                style={{
                  transitionDelay: '320ms',
                  transitionDuration: '0.8s',
                  transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
                }}
                className={`mt-6 sm:mt-8 flex flex-wrap items-center gap-4 pointer-events-auto transition-all ${
                  s1Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                <button
                  onClick={onLaunch}
                  className="group relative flex items-center gap-4 px-6 py-3 rounded-full border border-[#1D3045] bg-[#1D3045] hover:bg-[#1D3045]/90 text-white transition-all duration-300 shadow-lg focus:outline-none"
                >
                  <span className="text-xs sm:text-sm tracking-[0.25em] uppercase font-semibold text-white">
                    ENTER STOCKPILOT
                  </span>
                  <div className="w-6 h-6 rounded-full bg-white text-[#1D3045] flex items-center justify-center group-hover:translate-x-0.5 transition-transform duration-300">
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </button>
                <button
                  onClick={() => scrollToProgress(0.42)}
                  className="px-4 py-3 text-xs tracking-[0.2em] uppercase font-mono text-[#1D3045]/80 hover:text-[#1D3045] transition-colors"
                >
                  EXPLORE ARCHITECTURE ↓
                </button>
              </div>
            </div>

            {/* Minimal Circular Scroll Indicator near lower-right corner */}
            <div
              style={{
                transitionDelay: '400ms',
                transitionDuration: '0.8s',
                transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
              }}
              className={`absolute bottom-10 sm:bottom-14 right-6 sm:right-10 md:right-16 lg:right-24 transition-all pointer-events-auto ${
                s1Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
              }`}
            >
              <button
                onClick={() => scrollToProgress(0.42)}
                aria-label="Scroll to Section 2"
                className="group relative flex items-center gap-3 focus:outline-none"
              >
                <span className="hidden md:inline-block text-[11px] tracking-[0.25em] uppercase text-[#1D3045]/60 group-hover:text-[#1D3045] transition-colors">
                  SCROLL
                </span>
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full border border-[#1D3045]/40 group-hover:border-[#1D3045] flex items-center justify-center text-[#1D3045] transition-all duration-300 group-hover:scale-105">
                  <ArrowDown className="w-4 h-4 transition-transform duration-300 group-hover:translate-y-0.5" />
                </div>
              </button>
            </div>
          </section>

          {/* ========================================================================= */}
          {/* 2. SECOND CINEMATIC SCENE (Centered composition, progressive reveal)      */}
          {/* ========================================================================= */}
          <section
            style={{
              opacity: s2Opacity,
              transition: 'opacity 0.1s ease-out'
            }}
            className="absolute inset-0 flex flex-col items-center justify-center px-6 sm:px-12 select-none"
          >
            <div className="max-w-[1000px] text-center">
              {/* Very large lightweight typography with progressive reveal */}
              <h2 className="text-[#1D3045] font-extralight tracking-tight sm:tracking-normal leading-[1.15] text-[clamp(1.75rem,4.8vw,4.5rem)] uppercase">
                <span
                  style={{
                    opacity: s2Active ? line1Opacity : 0,
                    transform: `translateY(${(1 - line1Opacity) * 12}px)`,
                    transition: 'all 0.5s cubic-bezier(0.16,1,0.3,1)'
                  }}
                  className="block"
                >
                  DEFINE THE STRATEGY.
                </span>
                <span
                  style={{
                    opacity: s2Active ? line2Opacity : 0,
                    transform: `translateY(${(1 - line2Opacity) * 12}px)`,
                    transition: 'all 0.5s cubic-bezier(0.16,1,0.3,1)'
                  }}
                  className="block text-[#1D3045]/70"
                >
                  VERIFY THE EVIDENCE.
                </span>
                <span
                  style={{
                    opacity: s2Active ? line3Opacity : 0,
                    transform: `translateY(${(1 - line3Opacity) * 12}px)`,
                    transition: 'all 0.5s cubic-bezier(0.16,1,0.3,1)'
                  }}
                  className="block"
                >
                  EXECUTE ONLY WHEN
                </span>
                <span
                  style={{
                    opacity: s2Active ? line4Opacity : 0,
                    transform: `translateY(${(1 - line4Opacity) * 12}px)`,
                    transition: 'all 0.5s cubic-bezier(0.16,1,0.3,1)'
                  }}
                  className="block font-light"
                >
                  EVERY GATE PASSES.
                </span>
              </h2>

              {/* Minimal Informational Visual Sequence */}
              <div
                style={{
                  transitionDelay: '350ms',
                  transitionDuration: '0.8s',
                  transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
                }}
                className={`mt-10 sm:mt-16 flex flex-wrap items-center justify-center gap-4 sm:gap-8 md:gap-12 transition-all ${
                  s2Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                {[
                  { num: '01', title: 'STRATEGY' },
                  { num: '02', title: 'VERIFICATION' },
                  { num: '03', title: 'SIMULATION' },
                  { num: '04', title: 'EXECUTION' }
                ].map((step, idx) => (
                  <div key={step.num} className="flex items-center gap-2.5 sm:gap-3">
                    <span className="font-mono text-xs tracking-wider text-[#1D3045]/50">
                      {step.num}
                    </span>
                    <span className="text-xs sm:text-sm tracking-[0.25em] uppercase font-medium text-[#1D3045]/90">
                      {step.title}
                    </span>
                    {idx < 3 && (
                      <span className="hidden sm:inline-block ml-4 md:ml-8 w-6 h-[1px] bg-[#1D3045]/20" />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Right-Side Navigation Controls */}
            <div className="absolute bottom-12 right-6 sm:right-10 md:right-16 flex flex-col items-center gap-5 pointer-events-auto">
              <button
                onClick={() => scrollToProgress(0.85)}
                aria-label="Scroll to Section 3"
                className={`w-12 h-12 rounded-full border border-[#1D3045]/50 flex items-center justify-center text-[#1D3045] hover:opacity-75 transition-all ${
                  s2Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                <ArrowDown className="w-4 h-4" />
              </button>
              <div
                className={`flex flex-col items-center gap-2 transition-all ${
                  s2Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-[#1D3045]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#1D3045]/30" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#1D3045]/30" />
              </div>
              <button
                onClick={() => scrollToProgress(0.0)}
                aria-label="Scroll to Section 1"
                className={`w-10 h-10 rounded-full border border-[#1D3045]/30 flex items-center justify-center text-[#1D3045] hover:opacity-75 transition-all ${
                  s2Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                <ChevronUp className="w-4 h-4" />
              </button>
            </div>
          </section>

          {/* ========================================================================= */}
          {/* 3. THIRD CINEMATIC SCENE (Dark portion, right-aligned)                    */}
          {/* ========================================================================= */}
          <section
            style={{
              opacity: s3Opacity,
              transition: 'opacity 0.1s ease-out'
            }}
            className="absolute inset-0 flex flex-col justify-center items-end px-6 sm:px-10 md:px-20 lg:px-28 text-right select-none"
          >
            <div className="max-w-3xl">
              {/* Eyebrow */}
              <p
                style={{
                  transitionDelay: '0ms',
                  transitionDuration: '0.8s',
                  transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
                }}
                className={`text-white/60 text-xs sm:text-sm font-semibold tracking-[0.35em] uppercase mb-4 sm:mb-6 transition-all ${
                  s3Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                STOCKPILOT | BNB CHAIN
              </p>

              {/* Headline */}
              <h2
                style={{
                  transitionDelay: '150ms',
                  transitionDuration: '0.8s',
                  transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
                }}
                className={`text-white font-light uppercase tracking-tight leading-[1.05] text-[clamp(2.5rem,5.5vw,5.5rem)] mb-6 sm:mb-8 transition-all ${
                  s3Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                OBSERVE RISK,<br />
                VERIFY BEFORE<br />
                EXECUTION.
              </h2>

              {/* Supporting text */}
              <p
                style={{
                  transitionDelay: '250ms',
                  transitionDuration: '0.8s',
                  transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
                }}
                className={`text-white/70 font-light text-xs sm:text-sm md:text-base leading-relaxed tracking-wide mb-10 max-w-xl ml-auto transition-all ${
                  s3Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                Every proposed rebalance passes deterministic strategy checks, independent GenLayer verification, Binance simulation, wallet policy controls, and explicit user approval before execution.
              </p>

              {/* Call to Action Button */}
              <div
                style={{
                  transitionDelay: '350ms',
                  transitionDuration: '0.8s',
                  transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)'
                }}
                className={`flex items-center justify-end pointer-events-auto transition-all ${
                  s3Active ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
                }`}
              >
                <button
                  onClick={onLaunch}
                  className="group relative flex items-center gap-5 px-8 py-4 rounded-full border border-white/40 bg-white/10 hover:bg-white hover:text-[#1D3045] backdrop-blur-sm transition-all duration-300 focus:outline-none shadow-xl"
                >
                  <span className="text-xs sm:text-sm tracking-[0.3em] uppercase font-medium text-white group-hover:text-[#1D3045] transition-colors duration-300">
                    LAUNCH STOCKPILOT
                  </span>
                  <div className="w-8 h-8 rounded-full bg-white text-[#1D3045] flex items-center justify-center group-hover:scale-110 transition-transform duration-300 shadow-md">
                    <ArrowRight className="w-4 h-4" />
                  </div>
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
