"use client";

import {
  STREAMING_SERVICE_FILTERS,
  type StreamingServiceFilterId,
} from "@/lib/streaming-services";
import { cn } from "@/lib/cn";

interface StreamingServiceFilterBarProps {
  active: StreamingServiceFilterId;
  onChange: (serviceId: StreamingServiceFilterId) => void;
  className?: string;
}

export function StreamingServiceFilterBar({
  active,
  onChange,
  className,
}: StreamingServiceFilterBarProps) {
  return (
    <nav
      aria-label="Filter by streaming service"
      className={cn("mb-6 md:mb-8", className)}
    >
      <div className="row-scroll flex gap-2 overflow-x-auto px-4 pb-1 md:gap-2.5 md:px-12 lg:px-16">
        {STREAMING_SERVICE_FILTERS.map((service) => {
          const isActive = active === service.id;
          return (
            <button
              key={service.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(service.id)}
              className={cn(
                "shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition md:px-5 md:py-2 md:text-base",
                isActive
                  ? "border-white bg-white text-black shadow-md"
                  : "border-white/30 bg-white/10 text-white hover:border-white/60 hover:bg-white/20"
              )}
            >
              {service.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
