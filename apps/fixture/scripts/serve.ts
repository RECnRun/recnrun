import { startFixture } from "../src/server.ts";

const fixture = await startFixture();
for (const [role, origin] of Object.entries(fixture.origins))
  console.log(`${role.padEnd(8)} ${origin}`);
console.log(`ledger   ${fixture.origins.api}/__ledger`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void fixture.close().then(() => process.exit(0));
  });
}
