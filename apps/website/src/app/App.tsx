import { InstallGuide } from "@/features/install-guide/InstallGuide";

export function App() {
  return (
    <>
      <header class="site-header">
        <h1>RECnRun</h1>
      </header>
      <main>
        <p class="lead">
          RECnRun is a local tool that drives the Google Chrome already installed on your machine
          through the Chrome DevTools Protocol (CDP). It records what you do as a declarative flow
          and replays that flow whenever you need it, with no AI involved. Flows and their evidence
          stay on your machine.
        </p>
        <InstallGuide />
      </main>
    </>
  );
}
