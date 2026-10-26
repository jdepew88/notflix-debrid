export {};

declare global {
  namespace chrome {
    namespace cast {
      enum AutoJoinPolicy {
        ORIGIN_SCOPED = "origin_scoped",
      }

      namespace media {
        const DEFAULT_MEDIA_RECEIVER_APP_ID: string;

        enum StreamType {
          BUFFERED = "BUFFERED",
          LIVE = "LIVE",
        }

        class MediaInfo {
          constructor(src: string, contentType: string);
          metadata: GenericMediaMetadata;
          streamType?: StreamType;
        }

        class GenericMediaMetadata {
          title?: string;
          images?: Array<{ url: string }>;
        }

        class LoadRequest {
          constructor(mediaInfo: MediaInfo);
          currentTime?: number;
        }
      }
    }
  }

  namespace cast {
    namespace framework {
      enum CastContextEventType {
        SESSION_STATE_CHANGED = "sessionstatechanged",
      }

      class CastContext {
        static getInstance(): CastContext;
        setOptions(options: {
          receiverApplicationId: string;
          autoJoinPolicy: chrome.cast.AutoJoinPolicy;
        }): void;
        requestSession(): Promise<void>;
        getCurrentSession(): CastSession | null;
        endCurrentSession(stopCasting: boolean): void;
        addEventListener(event: CastContextEventType, listener: () => void): void;
        removeEventListener(event: CastContextEventType, listener: () => void): void;
      }

      interface CastSession {
        loadMedia(request: chrome.cast.media.LoadRequest): Promise<void>;
      }
    }
  }
}
