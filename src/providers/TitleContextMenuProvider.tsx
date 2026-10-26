"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Play, Info, ListPlus, ListMinus, ListOrdered, Copy } from "lucide-react";
import { useDetailModal } from "@/providers/DetailModalProvider";
import {
  useAppStore,
  isInMyList,
  isInQueue,
  getMediaProgress,
} from "@/lib/store";
import { canPlayItem, playLabelForItem, watchHref } from "@/lib/playback";
import type { MediaItem } from "@/lib/types";
import { cn } from "@/lib/cn";

interface MenuState {
  item: MediaItem;
  x: number;
  y: number;
}

interface TitleContextMenuContextValue {
  openContextMenu: (event: React.MouseEvent, item: MediaItem) => void;
}

const TitleContextMenuContext = createContext<TitleContextMenuContextValue | null>(null);

function clampPosition(x: number, y: number, width: number, height: number) {
  const margin = 8;
  const maxX = typeof window !== "undefined" ? window.innerWidth - width - margin : x;
  const maxY = typeof window !== "undefined" ? window.innerHeight - height - margin : y;
  return {
    x: Math.max(margin, Math.min(x, maxX)),
    y: Math.max(margin, Math.min(y, maxY)),
  };
}

export function TitleContextMenuProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { openDetail } = useDetailModal();
  const addToMyList = useAppStore((s) => s.addToMyList);
  const removeFromMyList = useAppStore((s) => s.removeFromMyList);
  const addToQueue = useAppStore((s) => s.addToQueue);
  const removeFromQueue = useAppStore((s) => s.removeFromQueue);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  const openContextMenu = useCallback((event: React.MouseEvent, item: MediaItem) => {
    event.preventDefault();
    event.stopPropagation();
    const { clientX, clientY } = event;
    setMenu({ item, x: clientX, y: clientY });
  }, []);

  useEffect(() => {
    if (!menu) return;

    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const onScroll = () => closeMenu();

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu, closeMenu]);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 3500);
    return () => clearTimeout(timer);
  }, [status]);

  const menuItem = menu?.item;
  const inList = menuItem ? isInMyList(menuItem.id) : false;
  const inQueue = menuItem ? isInQueue(menuItem.id) : false;
  const playable = menuItem ? canPlayItem(menuItem) : false;
  const progress = menuItem ? getMediaProgress(menuItem.id) : 0;

  const items: Array<{
    id: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
  }> = [];

  if (menuItem) {
    if (playable) {
      items.push({
        id: "play",
        label: progress > 0 && progress < 95 ? "Resume" : playLabelForItem(menuItem),
        icon: <Play className="h-4 w-4" />,
        onClick: () => {
          closeMenu();
          router.push(watchHref(menuItem));
        },
      });
    }

    items.push({
      id: "info",
      label: "More info",
      icon: <Info className="h-4 w-4" />,
      onClick: () => {
        closeMenu();
        openDetail(menuItem);
      },
    });

    items.push({
      id: "mylist",
      label: inList ? "Remove from My List" : "Add to My List",
      icon: inList ? <ListMinus className="h-4 w-4" /> : <ListPlus className="h-4 w-4" />,
      onClick: () => {
        closeMenu();
        if (inList) removeFromMyList(menuItem.id);
        else addToMyList(menuItem.id);
        setStatus(inList ? "Removed from My List" : "Added to My List");
      },
    });

    items.push({
      id: "queue",
      label: inQueue ? "Remove from Queue" : "Add to Queue",
      icon: <ListOrdered className="h-4 w-4" />,
      onClick: () => {
        closeMenu();
        if (inQueue) removeFromQueue(menuItem.id);
        else addToQueue(menuItem.id);
        setStatus(inQueue ? "Removed from queue" : "Added to queue");
      },
    });

    items.push({
      id: "copy",
      label: "Copy title",
      icon: <Copy className="h-4 w-4" />,
      onClick: () => {
        closeMenu();
        void navigator.clipboard.writeText(menuItem.title);
        setStatus("Title copied");
      },
    });
  }

  const position = menu
    ? clampPosition(menu.x, menu.y, 240, Math.min(items.length * 40 + 16, 420))
    : null;

  return (
    <TitleContextMenuContext.Provider value={{ openContextMenu }}>
      {children}

      {menu && position && (
        <div
          ref={menuRef}
          className="fixed z-[90] min-w-[220px] overflow-hidden rounded-md border border-white/15 bg-zinc-900/95 py-1 shadow-2xl backdrop-blur-md"
          style={{ left: position.x, top: position.y }}
          role="menu"
        >
          <p className="border-b border-white/10 px-3 py-2 text-xs font-medium text-netflix-light-gray line-clamp-2">
            {menu.item.title}
          </p>
          {items.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              onClick={entry.onClick}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40",
                entry.danger && "text-red-300 hover:bg-red-950/40"
              )}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </div>
      )}

      {status && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[95] -translate-x-1/2 rounded-full border border-white/15 bg-black/90 px-4 py-2 text-sm text-white shadow-lg">
          {status}
        </div>
      )}
    </TitleContextMenuContext.Provider>
  );
}

export function useTitleContextMenu(): TitleContextMenuContextValue {
  const ctx = useContext(TitleContextMenuContext);
  if (!ctx) {
    throw new Error("useTitleContextMenu must be used within TitleContextMenuProvider");
  }
  return ctx;
}
