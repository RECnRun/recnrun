import { askPeer, linkStatus, pair, receivedFrames, test } from "./fixtures/profiles.ts";
import { expect } from "./fixtures/extension.ts";

test("pairs two Chrome profiles over a DataChannel with no ICE server, and pings both ways", async ({
  home,
  work,
}) => {
  const { offer, answer, offererDigits, answererDigits } = await pair(home, work);
  expect(offererDigits).toBe(answererDigits);
  for (const code of [offer, answer]) expect(code).toMatch(/^RECNRUN-PAIR-1\./);

  for (const profile of [home, work]) {
    await profile.pairing.getByRole("button", { name: "Send ping" }).click();
    await expect(profile.pairing.getByText(/^Pong in \d+ ms$/)).toBeVisible();
    await profile.pairing.getByRole("button", { name: "Show diagnostics" }).click();
    const diagnostics = profile.pairing.getByLabel("Diagnostics");
    await expect(diagnostics).toContainText("candidate host");
    await expect(diagnostics).not.toContainText(/srflx|relay/);
  }
});

test("reconnects after a disconnect only through a new pairing, and forgets on request", async ({
  home,
  work,
}) => {
  await pair(home, work);
  await home.pairing.getByRole("button", { name: "Disconnect" }).click();
  await expect(linkStatus(home)).toHaveText("Disconnected — Work");
  await expect(linkStatus(work)).toHaveText(/^(Disconnected|Error) — Home$/);
  expect(await askPeer(work, { type: "peer-ping" })).toMatchObject({ ok: false });

  await pair(work, home);
  await work.pairing.getByRole("button", { name: "Forget the other profile" }).click();
  await expect(linkStatus(work)).toHaveText(/^(Disconnected|Not connected)$/);
});

test("refuses a replayed answer and its own offer", async ({ home, work }) => {
  const { answer } = await pair(home, work);
  const pasted = home.pairing.getByRole("textbox", { name: "Code from the other profile" });
  await pasted.fill(answer);
  await home.pairing.getByRole("button", { name: "Import code" }).click();
  await expect(home.pairing.getByRole("alert")).toHaveText(
    "This answer is not for the offer this profile made.",
  );
  await work.pairing.getByRole("button", { name: "Create offer" }).click();
  const own = await work.pairing.getByRole("textbox", { name: "Offer", exact: true }).inputValue();
  await work.pairing.getByRole("textbox", { name: "Code from the other profile" }).fill(own);
  await work.pairing.getByRole("button", { name: "Import code" }).click();
  await expect(work.pairing.getByRole("alert")).toHaveText("This code comes from this profile.");
  expect((await receivedFrames(work)).length).toBeGreaterThan(0);
});
