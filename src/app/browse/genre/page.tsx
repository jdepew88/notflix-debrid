import { Suspense } from "react";
import { GenreContent } from "./GenreContent";

export default function GenrePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
        </div>
      }
    >
      <GenreContent />
    </Suspense>
  );
}
