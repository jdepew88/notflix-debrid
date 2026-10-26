import Image, { type ImageProps } from "next/image";

function isProxiedSrc(src: ImageProps["src"]): boolean {
  return typeof src === "string" && src.startsWith("/api/");
}

/** Poster/backdrop image — uses unoptimized for proxied Plex/TVDB URLs so auth cookies work. */
export function MediaImage({ src, unoptimized, ...props }: ImageProps) {
  const proxied = isProxiedSrc(src);
  return (
    <Image
      src={src}
      unoptimized={unoptimized ?? proxied}
      {...props}
    />
  );
}
