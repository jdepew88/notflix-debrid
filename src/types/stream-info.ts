import type { StreamTrack } from "./media-tracks";

export interface StreamPlaybackInfo {
  streamUrl: string;
  sourceUrl?: string | null;
  sourcePath?: string | null;
  isDirectPlay?: boolean;
  qualityHint?: string | null;
  format?: string;
  videoCodec?: string;
  needsTranscode?: boolean;
  audioTracks?: StreamTrack[];
  subtitleTracks?: StreamTrack[];
  audioIndex?: number;
  subtitleIndex?: number | null;
}
