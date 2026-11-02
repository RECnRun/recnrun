import { createFixtureServer, portsFromEnvironment } from "./index.ts";

const server = createFixtureServer(portsFromEnvironment(process.env));
const urls = await server.start();
console.log(`RECnRun fixture on ${urls.first} and ${urls.second}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.stop());
}
