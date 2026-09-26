/**
 * StockPilot — Cinematic Video Scrubbing Hook
 *
 * Implements high-performance scroll-tied video playback:
 * - Frame-bank extraction via WebCodecs & MP4Box
 * - LRU-cached ImageBitmap decoding
 * - Exponential lerp scroll interpolation
 * - Robust fallback to <video currentTime> on watchdog, error, or reduced motion
 *
 * Exact Constants:
 * LERP_TAU = 8
 * SNAP = 0.002
 * LRU_MAX = 24
 * LEAD = 24
 * WATCHDOG = 60000
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { FrameBankEntry, VideoScrubState } from '../types/video.js';

export const LERP_TAU = 8;
export const SNAP = 0.002;
export const LRU_MAX = 24;
export const LEAD = 24;
export const WATCHDOG = 60000;

export interface UseVideoScrubOptions {
  videoSrc: string;
}

export function useVideoScrub({ videoSrc }: UseVideoScrubOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // High-frequency playback state in refs
  const bankRef = useRef<FrameBankEntry[]>([]);
  const lruRef = useRef<Map<number, ImageBitmap | null>>(new Map());
  const lruLoadingRef = useRef<Set<number>>(new Set());
  const currentTimeRef = useRef<number>(0);
  const targetTimeRef = useRef<number>(0);
  const durationRef = useRef<number>(0);
  const lastRafTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Exposed React state
  const [scrollProgress, setScrollProgress] = useState<number>(0);
  const [canvasLive, setCanvasLive] = useState<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);
  const [reverted, setReverted] = useState<boolean>(false);
  const [building, setBuilding] = useState<boolean>(false);

  // Binary search for nearest frame index in microseconds
  const findNearestFrameIndex = useCallback((targetMicros: number): number => {
    const bank = bankRef.current;
    if (bank.length === 0) return -1;
    if (bank.length === 1) return 0;

    let low = 0;
    let high = bank.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const diff = bank[mid].ts - targetMicros;

      if (diff === 0) return mid;
      if (diff < 0) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (low >= bank.length) return bank.length - 1;
    if (high < 0) return 0;

    const diffLow = Math.abs(bank[low].ts - targetMicros);
    const diffHigh = Math.abs(bank[high].ts - targetMicros);
    return diffLow < diffHigh ? low : high;
  }, []);

  // Evict oldest LRU entries
  const pruneLru = useCallback(() => {
    const lru = lruRef.current;
    while (lru.size > LRU_MAX) {
      const oldestKey = lru.keys().next().value;
      if (oldestKey !== undefined) {
        const bitmap = lru.get(oldestKey);
        if (bitmap) {
          try {
            bitmap.close();
          } catch {
            // Bitmap already closed
          }
        }
        lru.delete(oldestKey);
      } else {
        break;
      }
    }
  }, []);

  // Warm / load an index into LRU
  const warmLruIndex = useCallback((index: number) => {
    const bank = bankRef.current;
    if (index < 0 || index >= bank.length) return;
    const lru = lruRef.current;

    if (lru.has(index)) {
      // Re-insert to mark as MRU
      const val = lru.get(index)!;
      lru.delete(index);
      lru.set(index, val);
      return;
    }

    if (lruLoadingRef.current.has(index)) return;

    lruLoadingRef.current.add(index);
    const entry = bank[index];

    createImageBitmap(entry.blob)
      .then((bitmap) => {
        lru.set(index, bitmap);
        pruneLru();
      })
      .catch(() => {
        // Bitmap creation failed
      })
      .finally(() => {
        lruLoadingRef.current.delete(index);
      });
  }, [pruneLru]);

  // Frame bank builder using MP4Box & WebCodecs
  useEffect(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion || typeof VideoDecoder === 'undefined') {
      setReverted(true);
      return;
    }

    let isAborted = false;
    abortControllerRef.current = new AbortController();

    // 60-second watchdog: revert to normal video seeking fallback
    watchdogTimerRef.current = setTimeout(() => {
      if (!ready && !isAborted) {
        setReverted(true);
        setCanvasLive(false);
      }
    }, WATCHDOG);

    async function buildFrameBank() {
      setBuilding(true);

      try {
        const MP4BoxModule = await import('mp4box');
        const mp4box = (MP4BoxModule as any).default || MP4BoxModule;

        const response = await fetch(videoSrc, {
          signal: abortControllerRef.current?.signal
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch video: ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        if (isAborted) return;

        const mp4boxFile = mp4box.createFile();
        let videoTrack: any = null;
        let decoder: VideoDecoder | null = null;
        let inFlight = 0;
        let attempts = 0;

        function createDecoder(acceleration: HardwareAcceleration = 'no-preference'): VideoDecoder {
          return new VideoDecoder({
            output: async (frame: VideoFrame) => {
              inFlight--;
              if (isAborted) {
                frame.close();
                return;
              }

              try {
                const offscreen = new OffscreenCanvas(frame.displayWidth || 1920, frame.displayHeight || 1080);
                const ctx = offscreen.getContext('2d');
                if (ctx) {
                  ctx.drawImage(frame, 0, 0, offscreen.width, offscreen.height);
                  const blob = await offscreen.convertToBlob({ type: 'image/webp', quality: 0.82 });
                  bankRef.current.push({
                    ts: frame.timestamp,
                    blob
                  });
                }
              } catch {
                // Ignore frame render error
              } finally {
                frame.close();
              }
            },
            error: () => {
              if (attempts === 0 && !isAborted) {
                attempts++;
                // Retry once with prefer-software
                try {
                  decoder?.close();
                } catch {}
                decoder = createDecoder('prefer-software');
                configureDecoder();
              } else {
                setReverted(true);
              }
            }
          });
        }

        function configureDecoder() {
          if (!decoder || !videoTrack) return;
          const description = getTrackDescription(videoTrack);
          decoder.configure({
            codec: videoTrack.codec,
            description,
            hardwareAcceleration: attempts === 0 ? 'no-preference' : 'prefer-software'
          });
        }

        function getTrackDescription(track: any): Uint8Array | undefined {
          for (const entry of track.mdia?.minf?.stbl?.stsd?.entries || []) {
            const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            if (box) {
              const stream = new (mp4box as any).DataStream(undefined, 0, (mp4box as any).DataStream.BIG_ENDIAN);
              box.write(stream);
              return new Uint8Array(stream.buffer, 8); // Skip box header
            }
          }
          return undefined;
        }

        decoder = createDecoder('no-preference');

        mp4boxFile.onReady = (info: any) => {
          if (isAborted) return;
          videoTrack = info.videoTracks[0];
          if (!videoTrack) {
            setReverted(true);
            return;
          }

          if (durationRef.current <= 0 && videoTrack.duration && videoTrack.timescale) {
            durationRef.current = videoTrack.duration / videoTrack.timescale;
          }

          configureDecoder();
          mp4boxFile.setExtractionOptions(videoTrack.id, null, { nbSamples: 1000 });
          mp4boxFile.start();
        };

        mp4boxFile.onSamples = async (_id: number, _user: any, samples: any[]) => {
          if (isAborted || !decoder) return;

          for (const sample of samples) {
            while (inFlight >= LEAD && !isAborted) {
              await new Promise((res) => setTimeout(res, 10));
            }
            if (isAborted) return;

            const chunk = new EncodedVideoChunk({
              type: sample.is_sync ? 'key' : 'delta',
              timestamp: (sample.cts * 1e6) / sample.timescale,
              duration: (sample.duration * 1e6) / sample.timescale,
              data: sample.data
            });

            inFlight++;
            decoder.decode(chunk);
          }

          try {
            await decoder.flush();
          } catch {}

          if (!isAborted) {
            // Sort frame bank by timestamp
            bankRef.current.sort((a, b) => a.ts - b.ts);
            if (bankRef.current.length > 0) {
              setReady(true);
              setBuilding(false);
              if (watchdogTimerRef.current) {
                clearTimeout(watchdogTimerRef.current);
              }
            }
          }
        };

        const fileBuffer = buffer as any;
        fileBuffer.fileStart = 0;
        mp4boxFile.appendBuffer(fileBuffer);
        mp4boxFile.flush();
      } catch {
        if (!isAborted) {
          setReverted(true);
          setBuilding(false);
        }
      }
    }

    // Delay start until after window load for peak rendering priority
    if (document.readyState === 'complete') {
      buildFrameBank();
    } else {
      window.addEventListener('load', buildFrameBank, { once: true });
    }

    return () => {
      isAborted = true;
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
      }
      abortControllerRef.current?.abort();
      lruRef.current.forEach((bitmap) => {
        try {
          bitmap?.close();
        } catch {}
      });
      lruRef.current.clear();
      bankRef.current = [];
    };
  }, [videoSrc]);

  // Main scroll progress & rAF loop
  useEffect(() => {
    let animFrameId: number;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Direct video element duration listener
    const video = videoRef.current;
    if (video) {
      const handleLoadedMetadata = () => {
        if (video.duration > 0) {
          durationRef.current = video.duration;
        }
      };
      video.addEventListener('loadedmetadata', handleLoadedMetadata);
      if (video.duration > 0) {
        durationRef.current = video.duration;
      }
    }

    function getProgress(): number {
      const container = containerRef.current;
      if (!container) return 0;
      const totalScrollable = container.offsetHeight - window.innerHeight;
      if (totalScrollable <= 0) return 0;
      const raw = window.scrollY / totalScrollable;
      return Math.min(1, Math.max(0, raw));
    }

    let lastLoggedP = -1;

    function renderLoop(time: number) {
      const lastTime = lastRafTimeRef.current || time;
      lastRafTimeRef.current = time;
      const dt = Math.min(0.1, Math.max(0.001, (time - lastTime) / 1000));

      const p = getProgress();

      // Only update React state when progress has moved by meaningful delta
      if (Math.abs(p - lastLoggedP) > 0.0005) {
        lastLoggedP = p;
        setScrollProgress(p);
      }

      const duration = durationRef.current;
      if (duration > 0) {
        const target = p * duration;
        targetTimeRef.current = target;

        let current = currentTimeRef.current;
        if (prefersReducedMotion) {
          current = target;
        } else {
          current += (target - current) * (1 - Math.exp(-dt * LERP_TAU));
          if (Math.abs(target - current) < SNAP) {
            current = target;
          }
        }
        currentTimeRef.current = current;

        // Mode 1: Decoded Frame Bank Rendering (if ready and not reverted)
        if (ready && !reverted && bankRef.current.length > 0) {
          const targetMicros = current * 1e6;
          const nearestIndex = findNearestFrameIndex(targetMicros);

          if (nearestIndex >= 0) {
            // Warm surrounding window: i-1, i, i+1, i+2
            warmLruIndex(nearestIndex);
            warmLruIndex(nearestIndex - 1);
            warmLruIndex(nearestIndex + 1);
            warmLruIndex(nearestIndex + 2);

            const bitmap = lruRef.current.get(nearestIndex);
            if (bitmap && canvasRef.current) {
              const canvas = canvasRef.current;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                setCanvasLive(true);
              }
            }
          }
        } else {
          // Mode 2: HTML5 Video Seeking Fallback
          if (videoRef.current && Number.isFinite(current)) {
            const v = videoRef.current;
            if (Math.abs(v.currentTime - current) > 0.04) {
              v.currentTime = current;
            }
          }
        }
      }

      animFrameId = requestAnimationFrame(renderLoop);
    }

    animFrameId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animFrameId);
    };
  }, [ready, reverted, findNearestFrameIndex, warmLruIndex]);

  return {
    containerRef,
    videoRef,
    canvasRef,
    scrollProgress,
    canvasLive,
    ready,
    reverted,
    building
  };
}
