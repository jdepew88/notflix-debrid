import Image from "next/image";
import { providerLogoUrl } from "@/lib/tmdb";
import type { MediaItem } from "@/lib/types";
import { cn } from "@/lib/cn";

interface WatchProviderLogosProps {
  item: MediaItem;
  className?: string;
  logoClassName?: string;
}

export function WatchProviderLogos({
  item,
  className,
  logoClassName,
}: WatchProviderLogosProps) {
  const flatrate = item.watchProviders?.flatrate?.slice(0, 3) ?? [];

  if (flatrate.length > 0) {
    return (
      <div
        className={cn("flex items-center gap-1", className)}
        aria-label={`Stream on ${flatrate.map((p) => p.name).join(", ")}`}
      >
        {flatrate.map((provider) => {
          const logo = providerLogoUrl(provider.logoPath);
          return logo ? (
            <Image
              key={provider.id}
              src={logo}
              alt={provider.name}
              title={provider.name}
              width={20}
              height={20}
              className={cn(
                "h-5 w-5 rounded-sm bg-black/40 object-contain ring-1 ring-white/10",
                logoClassName
              )}
            />
          ) : (
            <span
              key={provider.id}
              title={provider.name}
              className="rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white/90"
            >
              {provider.name}
            </span>
          );
        })}
      </div>
    );
  }

  // No provider data (or none in this region): show nothing rather than a label on every card.
  return null;
}
