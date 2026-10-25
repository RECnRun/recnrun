// Phase C, bootstraps: how often B1, B2, and B4 are in place by the page's first inline script,
// over repeated loads in four containers, and what B2's synchronous request costs.
// Run: node scripts/containers-lab/bootstrap.mjs
import { startFixture } from "./fixture-server.mjs";
import { launchLab, openTab, writeEvidence } from "./lab-browser.mjs";

const NAMES = ["Admin", "Requester", "Approver", "Supervisor"];
const LOADS = 20;

async function measure(tab, name) {
  const result = { loads: LOADS, b1: 0, b2: 0, b4: 0, b2Ms: [] };
  for (let load = 0; load < LOADS; load += 1) {
    await (load === 0 ? Promise.resolve() : tab.page.reload());
    const first = await tab.page.evaluate(() => window.firstScript);
    if (first.patched) result.b1 += 1;
    if (first.b2?.container === name.toLowerCase()) result.b2 += 1;
    if (first.b4 === name.toLowerCase()) result.b4 += 1;
    if (first.b2?.ms !== undefined) result.b2Ms.push(Math.round(first.b2.ms * 10) / 10);
  }
  result.b2Ms = {
    median: result.b2Ms.toSorted((a, b) => a - b)[Math.floor(result.b2Ms.length / 2)],
    max: Math.max(...result.b2Ms),
  };
  return result;
}

const fixture = await startFixture();
const lab = await launchLab();
try {
  await lab.lab.setVariant("N2B1");
  await lab.lab.setProbes(true);
  const result = { chromium: lab.version, containers: {} };
  for (const name of NAMES)
    result.containers[name] = await measure(await openTab(lab, name, "/apis"), name);
  const control = await openTab(lab, undefined, "/apis");
  result.control = await control.page.evaluate(() => window.firstScript);
  console.log("evidence:", writeEvidence("bootstrap", result));
} finally {
  await lab.close();
  await fixture.close();
}
