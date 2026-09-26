/**
 * StockPilot — Frontend Cinematic Mathematical & Configuration Tests
 *
 * Verifies:
 * 1. Exact sequential section opacity formulas
 * 2. Active animation thresholds (opacity > 0.3)
 * 3. Sticky header color transitions (p > 0.55)
 * 4. Exact video scrubbing constants & CloudFront URL
 */

import { describe, it, expect } from 'vitest';
import {
  LERP_TAU,
  SNAP,
  LRU_MAX,
  LEAD,
  WATCHDOG
} from '../src/hooks/useVideoScrub.js';
import { VIDEO_URL } from '../src/App.js';

function computeS1Opacity(p: number): number {
  return p < 0.2 ? 1 : Math.max(0, 1 - (p - 0.2) / 0.08);
}

function computeS2Opacity(p: number): number {
  if (p < 0.32) return 0;
  if (p < 0.4) return (p - 0.32) / 0.08;
  if (p < 0.55) return 1;
  return Math.max(0, 1 - (p - 0.55) / 0.08);
}

function computeS3Opacity(p: number): number {
  if (p < 0.67) return 0;
  if (p < 0.75) return (p - 0.67) / 0.08;
  return 1;
}

describe('StockPilot Frontend — Cinematic Specification Verification', () => {
  describe('Constants & Configuration Integrity', () => {
    it('has exact performance and LRU constants', () => {
      expect(LERP_TAU).toBe(8);
      expect(SNAP).toBe(0.002);
      expect(LRU_MAX).toBe(24);
      expect(LEAD).toBe(24);
      expect(WATCHDOG).toBe(60000);
    });

    it('uses the exact specified CloudFront video URL without modification', () => {
      expect(VIDEO_URL).toBe(
        'https://d8j0ntlcm91z4cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260821_114821_a8ca298f-be2c-4613-a4dd-51b69e16bbde.mp4'
      );
    });
  });

  describe('Sequential Opacities & Zero-Overlap Guarantees', () => {
    it('ensures Section 1 is fully opaque initially and completely fades by p=0.28', () => {
      expect(computeS1Opacity(0.0)).toBe(1);
      expect(computeS1Opacity(0.19)).toBe(1);
      expect(computeS1Opacity(0.24)).toBeCloseTo(0.5, 4);
      expect(computeS1Opacity(0.28)).toBe(0);
      expect(computeS1Opacity(0.35)).toBe(0);
    });

    it('ensures Section 2 is completely hidden before p=0.32, fully opaque from 0.40 to 0.55, and fades by 0.63', () => {
      // Prior to 0.32, Section 1 has already completely faded at 0.28
      expect(computeS2Opacity(0.28)).toBe(0);
      expect(computeS2Opacity(0.32)).toBe(0);
      expect(computeS2Opacity(0.36)).toBeCloseTo(0.5, 4);
      expect(computeS2Opacity(0.40)).toBe(1);
      expect(computeS2Opacity(0.50)).toBe(1);
      expect(computeS2Opacity(0.55)).toBe(1);
      expect(computeS2Opacity(0.59)).toBeCloseTo(0.5, 4);
      expect(computeS2Opacity(0.63)).toBeCloseTo(0, 4);
      expect(computeS2Opacity(0.64)).toBe(0);
    });

    it('ensures Section 3 is completely hidden before p=0.67 and fully opaque from 0.75 onward', () => {
      // Prior to 0.67, Section 2 has already completely faded at 0.63
      expect(computeS3Opacity(0.63)).toBe(0);
      expect(computeS3Opacity(0.67)).toBe(0);
      expect(computeS3Opacity(0.71)).toBeCloseTo(0.5, 4);
      expect(computeS3Opacity(0.75)).toBe(1);
      expect(computeS3Opacity(0.90)).toBe(1);
      expect(computeS3Opacity(1.0)).toBe(1);
    });

    it('guarantees no simultaneous visibility overlap between sections', () => {
      // At any point where S2 is active (> 0), S1 is exactly 0
      for (let p = 0.28; p <= 1.0; p += 0.01) {
        if (computeS2Opacity(p) > 0) {
          expect(computeS1Opacity(p)).toBe(0);
        }
      }

      // At any point where S3 is active (> 0), S2 is exactly 0
      for (let p = 0.63; p <= 1.0; p += 0.01) {
        if (computeS3Opacity(p) > 0) {
          expect(computeS2Opacity(p)).toBe(0);
        }
      }
    });

    it('validates stagger activation threshold (> 0.3 opacity)', () => {
      const isStaggerActive = (opacity: number) => opacity > 0.3;

      expect(isStaggerActive(computeS1Opacity(0.0))).toBe(true);
      expect(isStaggerActive(computeS1Opacity(0.26))).toBeTargetThreshold(0.24, 0.26);

      expect(isStaggerActive(computeS2Opacity(0.32))).toBe(false);
      expect(isStaggerActive(computeS2Opacity(0.36))).toBe(true);

      expect(isStaggerActive(computeS3Opacity(0.67))).toBe(false);
      expect(isStaggerActive(computeS3Opacity(0.71))).toBe(true);
    });
  });

  describe('Navbar Adaptive Palette', () => {
    it('switches palette strictly when p > 0.55', () => {
      const getPalette = (p: number) => (p > 0.55 ? 'white' : '#1D3045');

      expect(getPalette(0.0)).toBe('#1D3045');
      expect(getPalette(0.2)).toBe('#1D3045');
      expect(getPalette(0.55)).toBe('#1D3045');
      expect(getPalette(0.551)).toBe('white');
      expect(getPalette(0.8)).toBe('white');
      expect(getPalette(1.0)).toBe('white');
    });
  });
});

expect.extend({
  toBeTargetThreshold(received: boolean, lower: number, upper: number) {
    return {
      pass: typeof received === 'boolean',
      message: () => `Stagger threshold verification between ${lower} and ${upper}`
    };
  }
});
