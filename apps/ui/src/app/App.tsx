import { PROTOCOL_SCHEMA_VERSION } from "@recnrun/protocol";

export function App() {
  return (
    <main>
      <h1>RECnRun</h1>
      <p>Protocol version {PROTOCOL_SCHEMA_VERSION}</p>
    </main>
  );
}
