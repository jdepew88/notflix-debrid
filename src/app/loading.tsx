import { BrandLoader } from "@/components/brand/Logo";

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <BrandLoader />
    </div>
  );
}
