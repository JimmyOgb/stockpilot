/**
 * StockPilot — Video Scrubbing & Frame Bank Types
 */

export interface FrameBankEntry {
  ts: number; // Timestamp in microseconds
  blob: Blob;
}

export interface VideoScrubState {
  bank: FrameBankEntry[];
  lru: Map<number, ImageBitmap | null>;
  currentTime: number;
  targetTime: number;
  ready: boolean;
  reverted: boolean;
  painted: boolean;
  building: boolean;
  duration: number;
}
