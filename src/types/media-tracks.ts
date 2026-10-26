export interface StreamTrack {
  index: number;
  type: "audio" | "subtitle";
  codec: string;
  language?: string;
  title?: string;
  default?: boolean;
  forced?: boolean;
  channels?: number;
  label: string;
}

export interface ProbeResult {
  format: string;
  duration?: number;
  videoCodec?: string;
  audio: StreamTrack[];
  subtitles: StreamTrack[];
  needsVideoTranscode: boolean;
  /** True when video must be transcoded for plain browser playback (stricter than HLS copy). */
  needsDirectVideoTranscode?: boolean;
  needsTranscode: boolean;
  defaultAudioIndex?: number;
  defaultSubtitleIndex?: number | null;
}
