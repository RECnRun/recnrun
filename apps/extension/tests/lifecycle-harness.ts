import type { Identity } from "@recnrun/domain";
import { vi } from "vite-plus/test";
import { createLifecycle } from "@/background/workspace/lifecycle";
import { memoryRecordingStore } from "./fake-extension";
import { memoryOperationJournal } from "./fake-journal";
import { fakeEffects, identity, memoryIdentities } from "./fake-lifecycle";

export const NOW = 1_700_000_000_000;
const RECORDING = { tabId: 1, status: "recording" as const, banked: 0, since: 0 };

/** A lifecycle over identities a, b (captured) and c (not), in memory. */
export function setUp(options: { open?: string; saved?: Identity[]; recording?: boolean } = {}) {
  const { memory, repository } = memoryIdentities(
    options.saved ?? [identity("a"), identity("b"), identity("c", false)],
  );
  const chrome = fakeEffects(options.open === undefined ? undefined : { identityId: options.open });
  const journal = memoryOperationJournal();
  const access = vi.fn(async () => {});
  const lifecycle = createLifecycle({
    recordings: memoryRecordingStore(options.recording ? RECORDING : null),
    identities: repository,
    journal,
    effects: chrome.effects,
    guard: { exclusive: (run) => run(), access },
    now: () => NOW,
  });
  const saved = (id: string) => memory.saved.find((each) => each.id === id);
  return { lifecycle, chrome, journal, memory, saved, access };
}
