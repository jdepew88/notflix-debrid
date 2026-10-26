"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { CropRect } from "@/lib/profile-client";

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const VIEW = 280;
const MAX_ZOOM = 4;

/** Client-side pre-check (the server validates the actual image content again). */
export function checkAvatarFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Choose a JPEG, PNG or WebP image.";
  if (file.size > MAX_FILE_BYTES) return "Images must be 8 MB or smaller.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

interface AvatarCropperProps {
  file: File;
  onChange: (crop: CropRect | null, previewUrl: string | null) => void;
}

/**
 * Square crop with drag-to-reposition and zoom. Coordinates are reported in the image's displayed
 * pixels; browsers apply EXIF orientation to <img>, and the server applies the same orientation.
 */
export function AvatarCropper({ file, onChange }: AvatarCropperProps) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const baseScale = natural ? VIEW / Math.min(natural.w, natural.h) : 1;
  const scale = baseScale * zoom;

  const clamp = useCallback(
    (x: number, y: number, s = scale) => {
      if (!natural) return { x, y };
      return {
        x: Math.min(0, Math.max(VIEW - natural.w * s, x)),
        y: Math.min(0, Math.max(VIEW - natural.h * s, y)),
      };
    },
    [natural, scale]
  );

  // Report the crop whenever it changes.
  useEffect(() => {
    if (!natural) return;
    const crop = { x: -offset.x / scale, y: -offset.y / scale, size: VIEW / scale };
    onChangeRef.current(crop, url);
  }, [natural, offset, scale, url]);

  const setZoomAroundCenter = (next: number) => {
    const z = Math.min(MAX_ZOOM, Math.max(1, next));
    const s = baseScale * z;
    // Keep the point under the viewport centre fixed.
    const cx = (VIEW / 2 - offset.x) / scale;
    const cy = (VIEW / 2 - offset.y) / scale;
    setZoom(z);
    setOffset(clamp(VIEW / 2 - cx * s, VIEW / 2 - cy * s, s));
  };

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div>
        <div
          className="relative cursor-grab touch-none select-none overflow-hidden rounded-xl bg-black ring-1 ring-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:cursor-grabbing"
          style={{ width: VIEW, height: VIEW }}
          tabIndex={0}
          role="application"
          aria-label="Photo crop area. Drag or use arrow keys to move, plus and minus to zoom."
          data-testid="avatar-crop-area"
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            setOffset(clamp(drag.current.ox + e.clientX - drag.current.x, drag.current.oy + e.clientY - drag.current.y));
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) => setZoomAroundCenter(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 24 : 8;
            const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
            if (moves[e.key]) {
              e.preventDefault();
              setOffset(clamp(offset.x + moves[e.key][0], offset.y + moves[e.key][1]));
            } else if (e.key === "+" || e.key === "=") {
              e.preventDefault();
              setZoomAroundCenter(zoom + 0.1);
            } else if (e.key === "-") {
              e.preventDefault();
              setZoomAroundCenter(zoom - 0.1);
            }
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
          <img
            src={url}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth < 64 || img.naturalHeight < 64) {
                setError("This image is too small. Use one at least 64×64 pixels.");
                onChangeRef.current(null, null);
                return;
              }
              const n = { w: img.naturalWidth, h: img.naturalHeight };
              const s = VIEW / Math.min(n.w, n.h);
              setNatural(n);
              setOffset({ x: (VIEW - n.w * s) / 2, y: (VIEW - n.h * s) / 2 });
            }}
            onError={() => {
              setError("That file could not be opened as an image.");
              onChangeRef.current(null, null);
            }}
            className="pointer-events-none absolute left-0 top-0 max-w-none origin-top-left"
            style={natural ? { width: natural.w * scale, height: natural.h * scale, transform: `translate(${offset.x}px, ${offset.y}px)` } : { opacity: 0 }}
          />
          {/* Circular guide; the saved image is the full square. */}
          <div className="pointer-events-none absolute inset-0 rounded-xl shadow-[inset_0_0_0_9999px_rgba(0,0,0,0.35)] [mask:radial-gradient(circle_at_center,transparent_69%,black_70%)]" />
          {error && <p className="absolute inset-0 flex items-center justify-center bg-black/80 p-6 text-center text-sm text-red-300">{error}</p>}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" aria-label="Zoom out" onClick={() => setZoomAroundCenter(zoom - 0.25)} className="rounded-full p-1.5 hover:bg-white/10">
            <Minus className="h-4 w-4" />
          </button>
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoomAroundCenter(Number(e.target.value))}
            aria-label="Zoom"
            data-testid="avatar-zoom"
            className="h-1 flex-1 accent-white"
          />
          <button type="button" aria-label="Zoom in" onClick={() => setZoomAroundCenter(zoom + 0.25)} className="rounded-full p-1.5 hover:bg-white/10">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex flex-col items-center gap-2 text-xs text-netflix-light-gray">
        <span>Preview</span>
        <div className="relative h-24 w-24 overflow-hidden rounded-lg bg-black ring-1 ring-white/10" aria-hidden>
          {natural && (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL
            <img
              src={url}
              alt=""
              className="absolute left-0 top-0 max-w-none origin-top-left"
              style={{ width: natural.w * scale * (96 / VIEW), height: natural.h * scale * (96 / VIEW), transform: `translate(${offset.x * (96 / VIEW)}px, ${offset.y * (96 / VIEW)}px)` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
