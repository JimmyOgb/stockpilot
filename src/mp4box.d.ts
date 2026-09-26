declare module 'mp4box' {
  export interface MP4MediaTrack {
    id: number;
    created: Date;
    modified: Date;
    volume: number;
    track_width: number;
    track_height: number;
    timescale: number;
    duration: number;
    bitrate: number;
    codec: string;
    video?: {
      width: number;
      height: number;
    };
  }

  export interface MP4Info {
    duration: number;
    timescale: number;
    isFragmented: boolean;
    isProgressive: boolean;
    hasIOD: boolean;
    brands: string[];
    created: Date;
    modified: Date;
    tracks: MP4MediaTrack[];
    videoTracks: MP4MediaTrack[];
    audioTracks: MP4MediaTrack[];
  }

  export interface MP4Sample {
    track_id: number;
    description: any;
    is_rap: boolean;
    is_sync: boolean;
    data: ArrayBuffer;
    dts: number;
    cts: number;
    duration: number;
    timescale: number;
    size: number;
  }

  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (e: string) => void;
    onSamples?: (id: number, user: any, samples: MP4Sample[]) => void;
    appendBuffer(data: ArrayBuffer & { fileStart?: number }): number;
    flush(): void;
    setExtractionOptions(id: number, user?: any, options?: { nbSamples?: number }): void;
    start(): void;
    stop(): void;
  }

  export function createFile(): MP4File;
}
