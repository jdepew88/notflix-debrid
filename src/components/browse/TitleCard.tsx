"use client";

import { TitleCardWithHover } from "./TitleCardWithHover";
import type { MediaItem } from "@/lib/types";

interface TitleCardProps {
  item: MediaItem;
  className?: string;
  priority?: boolean;
}

/** Poster card for grids (search, My List): same behaviour as row cards, sized by its grid cell. */
export function TitleCard({ item, className, priority }: TitleCardProps) {
  return <TitleCardWithHover item={item} className={className} priority={priority} layout="grid" />;
}
