"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TitleCardWithHover } from "./TitleCardWithHover";
import type { MediaItem } from "@/lib/types";
import { cn } from "@/lib/cn";

interface ContentRowProps {
  title: string;
  items: MediaItem[];
  large?: boolean;
  featured?: boolean;
}

export function ContentRow({ title, items, large, featured }: ContentRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (direction: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.75;
    el.scrollBy({ left: direction === "left" ? -amount : amount, behavior: "smooth" });
  };

  if (items.length === 0) return null;

  const isLarge = large || featured;

  // Arrow keys move focus between cards (TV remotes and keyboards); Home/End jump to the ends.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const cards = Array.from(el.querySelectorAll<HTMLElement>('[role="button"]'));
    const current = cards.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = Math.min(cards.length - 1, current + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = cards.length - 1;
    if (next < 0) return;
    e.preventDefault();
    cards[next].focus();
    cards[next].scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  };

  return (
    <section
      className={cn(
        "group/row relative mb-6 md:mb-8",
        featured && "mb-8 md:mb-10 rounded-lg bg-white/[0.03] py-4 md:py-6"
      )}
    >
      <h2
        className={cn(
          "mb-2 px-4 font-semibold md:px-12 lg:px-16",
          featured ? "text-xl md:text-2xl lg:text-3xl" : "text-lg md:text-xl"
        )}
      >
        {title}
        {featured && (
          <span className="ml-3 text-sm font-normal text-netflix-light-gray">
            {items.length} titles
          </span>
        )}
      </h2>
      <div className="relative">
        <button
          type="button"
          onClick={() => scroll("left")}
          className="absolute left-0 top-0 z-10 hidden h-full w-12 items-center justify-center bg-black/50 opacity-0 transition group-hover/row:opacity-100 md:flex"
          aria-label="Scroll left"
        >
          <ChevronLeft className="h-8 w-8" />
        </button>

        <div
          ref={scrollRef}
          onKeyDown={onKeyDown}
          className="row-scroll flex gap-2 overflow-x-auto px-4 md:gap-3 md:px-12 lg:px-16"
          role="list"
          aria-label={title}
        >
          {items.map((item, i) => (
            <TitleCardWithHover
              key={item.id}
              item={item}
              priority={i < 4}
              large={isLarge}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={() => scroll("right")}
          className="absolute right-0 top-0 z-10 hidden h-full w-12 items-center justify-center bg-black/50 opacity-0 transition group-hover/row:opacity-100 md:flex"
          aria-label="Scroll right"
        >
          <ChevronRight className="h-8 w-8" />
        </button>
      </div>
    </section>
  );
}
