import { CommandStep } from "@/ui/CommandStep";

export const SETUP_COMMAND = "npx @recnrun/cli setup";
export const OPEN_COMMAND = "npx @recnrun/cli open";

export function InstallGuide() {
  return (
    <section class="install" aria-labelledby="install-title">
      <h2 id="install-title">Install</h2>
      <p>You need Node.js 22.18 or later (24 LTS recommended) and Google Chrome 144 or later.</p>
      <ol class="command-steps">
        <CommandStep command={SETUP_COMMAND}>
          Set up RECnRun once. Chrome shows its own permission dialog, and a banner while RECnRun is
          connected.
        </CommandStep>
        <CommandStep command={OPEN_COMMAND}>
          Open RECnRun in your browser to record, edit, and replay flows.
        </CommandStep>
      </ol>
      <p class="muted">
        The <code>@recnrun/cli</code> package is not published yet, so these commands do not work
        today.
      </p>
    </section>
  );
}
