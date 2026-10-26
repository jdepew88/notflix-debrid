import { SetupWizard } from "@/components/setup/SetupWizard";

/** First-run setup. Redirected away by proxy.ts once setup is complete. */
export default function SetupPage() {
  return <SetupWizard mode="first-run" />;
}
