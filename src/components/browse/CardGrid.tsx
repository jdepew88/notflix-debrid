"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { CARD_GRID_CLASS } from "./TitleCardWithHover";
import { cn } from "@/lib/cn";

/**
 * Responsive landscape-card grid with directional focus movement (keyboards, TV remotes and
 * gamepads mapped to arrow keys): ←/→ move by one card, ↑/↓ by one row, Home/End jump to the ends.
 */
export function CardGrid({ children, className, testId, ...rest }: { children: ReactNode; className?: string; testId?: string } & React.HTMLAttributes<HTMLDivElement>) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cards = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-testid=title-card]"));
    const index = cards.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    const top = cards[0].offsetTop;
    const columns = Math.max(1, cards.filter((c) => c.offsetTop === top).length);
    const target =
      e.key === "ArrowRight" ? index + 1
      : e.key === "ArrowLeft" ? index - 1
      : e.key === "ArrowDown" ? index + columns
      : e.key === "ArrowUp" ? index - columns
      : e.key === "Home" ? 0
      : e.key === "End" ? cards.length - 1
      : null;
    if (target === null || target < 0 || target >= cards.length) return;
    e.preventDefault();
    cards[target].focus();
    cards[target].scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  return (
    <div {...rest} className={cn(CARD_GRID_CLASS, className)} data-testid={testId} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
