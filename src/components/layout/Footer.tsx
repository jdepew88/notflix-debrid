import Link from "next/link";
import { NotflixWordmark } from "@/components/brand/Logo";

const LINKS = [
  { label: "Home", href: "/browse" },
  { label: "My List", href: "/browse/my-list" },
  { label: "Settings", href: "/settings" },
];

/** Minimal footer: brand, real destinations, version, and the attributions TMDB requires. */
export function Footer() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  const commit = process.env.NEXT_PUBLIC_BUILD_COMMIT;
  return (
    <footer className="mt-16 border-t border-line px-4 py-10 md:px-12 lg:px-16" data-testid="site-footer">
      <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-5">
          <NotflixWordmark title="Notflix" className="h-5 w-auto opacity-90" />
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-3">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="focus-ring rounded-sm transition-colors hover:text-ink">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        {version && (
          <p className="text-xs text-ink-4">
            Version {version}
            {commit ? ` · ${commit}` : ""}
          </p>
        )}
      </div>
      <p className="mt-6 max-w-3xl text-xs leading-relaxed text-ink-4">
        Film and series information and images from{" "}
        <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer" className="focus-ring rounded-sm underline decoration-ink-4/50 underline-offset-2 hover:text-ink-3">
          TMDB
        </a>
        . This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability by{" "}
        <a href="https://www.justwatch.com/" target="_blank" rel="noreferrer" className="focus-ring rounded-sm underline decoration-ink-4/50 underline-offset-2 hover:text-ink-3">
          JustWatch
        </a>
        . Notflix is a personal media player and is not affiliated with any streaming service.
      </p>
    </footer>
  );
}
