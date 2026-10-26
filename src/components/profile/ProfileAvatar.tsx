"use client";

import { resolveAvatar } from "@/lib/avatars";
import { cn } from "@/lib/cn";

interface ProfileAvatarProps {
  avatar?: string;
  name?: string;
  /** Rendered size in px (square). */
  size?: number;
  className?: string;
  /** Decorative when the name is shown next to it (screen readers skip it). */
  decorative?: boolean;
}

/** A profile's avatar: built-in artwork, an uploaded photo, or a legacy emoji on a tinted tile. */
export function ProfileAvatar({ avatar, name = "Profile", size = 40, className, decorative }: ProfileAvatarProps) {
  const resolved = resolveAvatar(avatar, name);
  const style = { width: size, height: size };
  if (resolved.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- small same-origin SVG/WebP; next/image adds nothing here
      <img
        src={resolved.src}
        alt={decorative ? "" : resolved.label}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        draggable={false}
        className={cn("shrink-0 rounded-md object-cover", className)}
        style={style}
      />
    );
  }
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : resolved.label}
      aria-hidden={decorative || undefined}
      className={cn("flex shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-netflix-red to-[#7a0c12]", className)}
      style={{ ...style, fontSize: size * 0.55 }}
    >
      {resolved.emoji}
    </span>
  );
}
