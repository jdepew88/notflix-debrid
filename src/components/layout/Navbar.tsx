"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Search, ChevronDown, Settings, Users, UserCog, LogOut, Pencil } from "lucide-react";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ProfileAvatar } from "@/components/profile/ProfileAvatar";
import { NotflixWordmark } from "@/components/brand/Logo";
import { leaveProfile } from "@/lib/profile-client";
import { disableBrowserNotifications } from "@/lib/notifications/browser";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import { GENRES, NAV_GENRE_SLUGS, genreHref } from "@/lib/genres";

const GENRE_LINKS = NAV_GENRE_SLUGS.map((slug) => GENRES.find((g) => g.slug === slug)!).filter(Boolean);

export function Navbar() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [genreOpen, setGenreOpen] = useState(false);
  const activeProfileId = useAppStore((s) => s.activeProfileId);
  const profiles = useAppStore((s) => s.profiles);
  const logoutLocal = useAppStore((s) => s.logoutLocal);
  const isOwner = useAppStore((s) => s.user?.role === "owner");
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);

  const navLinks = [
    { href: "/browse", label: "Home" },
    { href: "/browse/search", label: "Search" },
    { href: "/browse/my-list", label: "My List" },
    // The Debrid page manages the server's Real-Debrid account: the owner only.
    ...(isOwner ? [{ href: "/browse/debrid", label: "Debrid" }] : []),
  ];

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const switchProfile = async () => {
    setMenuOpen(false);
    await leaveProfile();
    router.push("/profiles");
  };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleSignOut = async () => {
    // This browser stops receiving the account's pop-ups once signed out.
    await disableBrowserNotifications();
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    logoutLocal();
    window.location.href = "/";
  };

  return (
    <nav
      className={cn(
        "fixed top-0 z-50 w-full transition-colors duration-300",
        scrolled ? "bg-netflix-black" : "bg-gradient-to-b from-black/80 to-transparent"
      )}
    >
      <div className="mx-auto flex h-16 items-center justify-between px-4 md:h-[68px] md:px-12 lg:px-16">
        <div className="flex items-center gap-6 md:gap-8">
          <Link
            href="/browse"
            aria-label="Notflix home"
            className="focus-ring rounded-sm"
          >
            <NotflixWordmark title="" className="h-[22px] w-auto md:h-[26px]" />
          </Link>
          <ul className="hidden items-center gap-4 md:flex lg:gap-5">
            {navLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={cn(
                    "text-sm transition hover:text-netflix-light-gray",
                    pathname === link.href ? "font-semibold text-white" : "text-netflix-light-gray"
                  )}
                >
                  {link.label}
                </Link>
              </li>
            ))}
            <li className="relative">
              <button
                type="button"
                onMouseEnter={() => setGenreOpen(true)}
                onMouseLeave={() => setGenreOpen(false)}
                className="flex items-center gap-1 text-sm text-netflix-light-gray transition hover:text-white"
              >
                Browse
                <ChevronDown className="h-3 w-3" />
              </button>
              {genreOpen && (
                <div
                  onMouseEnter={() => setGenreOpen(true)}
                  onMouseLeave={() => setGenreOpen(false)}
                  className="absolute left-0 top-full mt-0 w-48 border border-white/10 bg-black/95 py-2 shadow-xl"
                >
                  {GENRE_LINKS.map((genre) => (
                    <Link
                      key={genre.slug}
                      href={genreHref(genre)}
                      className="block px-4 py-2 text-sm hover:underline"
                    >
                      {genre.name}
                    </Link>
                  ))}
                </div>
              )}
            </li>
          </ul>
        </div>

        <div className="flex items-center gap-4 md:gap-5">
          <Link href="/browse/search" className="text-white hover:text-netflix-light-gray">
            <Search className="h-5 w-5" />
          </Link>
          <NotificationBell />
          <Link href="/settings" className="hidden text-white hover:text-netflix-light-gray md:block">
            <Settings className="h-5 w-5" />
          </Link>

          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={activeProfile ? `Profile menu for ${activeProfile.name}` : "Profile menu"}
              data-testid="profile-menu-button"
              className="flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <ProfileAvatar avatar={activeProfile?.avatar} name={activeProfile?.name} size={32} className="rounded" decorative />
              <ChevronDown className={cn("h-4 w-4 transition", menuOpen && "rotate-180")} />
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 top-full mt-3 w-60 overflow-hidden rounded-md border border-white/10 bg-black/95 py-2 shadow-2xl backdrop-blur">
                {activeProfile && (
                  <div className="flex items-center gap-3 border-b border-white/10 px-4 pb-3 pt-1">
                    <ProfileAvatar avatar={activeProfile.avatar} name={activeProfile.name} size={36} className="rounded" decorative />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{activeProfile.name}</p>
                      <p className="text-xs text-netflix-gray">Watching now</p>
                    </div>
                  </div>
                )}
                <button type="button" role="menuitem" onClick={() => void switchProfile()} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-white/10" data-testid="menu-switch-profile">
                  <Users className="h-4 w-4 text-netflix-light-gray" /> Switch profile
                </button>
                <Link href="/profiles?manage=1" role="menuitem" onClick={() => setMenuOpen(false)} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/10">
                  <Pencil className="h-4 w-4 text-netflix-light-gray" /> Manage profiles
                </Link>
                <Link href="/settings#account" role="menuitem" onClick={() => setMenuOpen(false)} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/10">
                  <UserCog className="h-4 w-4 text-netflix-light-gray" /> Account &amp; settings
                </Link>
                <div className="my-1 border-t border-white/10" />
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-white/10"
                  data-testid="menu-sign-out"
                  onClick={() => {
                    setMenuOpen(false);
                    void handleSignOut();
                  }}
                >
                  <LogOut className="h-4 w-4 text-netflix-light-gray" /> Sign out of Notflix
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-4 overflow-x-auto px-4 pb-2 md:hidden row-scroll">
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "whitespace-nowrap text-sm",
              pathname === link.href ? "font-semibold text-white" : "text-netflix-light-gray"
            )}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
