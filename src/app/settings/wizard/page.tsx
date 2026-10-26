import { SetupWizard } from "@/components/setup/SetupWizard";

/** Settings -> "Run the setup wizard again" (owner only; the config APIs enforce it too). */
export default function ReconfigurePage() {
  return <SetupWizard mode="reconfigure" />;
}
