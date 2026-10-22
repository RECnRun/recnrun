import { emptySnapshot } from "@recnrun/domain";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { render } from "preact";
import { expect, test } from "vite-plus/test";
import { Popup } from "@/popup/Popup";

function mount(loadSnapshot: () => Promise<ReturnType<typeof emptySnapshot>>) {
  const root = document.createElement("div");
  document.body.append(root);
  render(<Popup loadSnapshot={loadSnapshot} />, root);
  return root.querySelector('[role="status"]');
}

test("shows the recording count once the snapshot loads", async () => {
  const status = mount(async () => sampleSnapshot());
  await expect.poll(() => status?.textContent).toBe("2 recordings");
});

test("uses the singular for one recording", async () => {
  const [first] = sampleSnapshot().recordings;
  const status = mount(async () => ({ ...emptySnapshot(), recordings: first ? [first] : [] }));
  await expect.poll(() => status?.textContent).toBe("1 recording");
});

test("explains a storage failure", async () => {
  const status = mount(() => Promise.reject(new Error("Quota exceeded")));
  await expect.poll(() => status?.textContent).toBe("Could not read your data: Quota exceeded");
});
