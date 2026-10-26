import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { OwnerConfigAlert } from "@/components/settings/OwnerConfigAlert";

export default function BrowseLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas pt-16 md:pt-[68px]">
      <Navbar />
      <OwnerConfigAlert />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
