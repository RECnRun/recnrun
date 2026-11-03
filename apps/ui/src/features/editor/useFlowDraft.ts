import type { Flow } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";
import type { RevisionEntry } from "@/features/editor/Revisions";

type Options = { initial: Flow; revision: string; revisions: RevisionEntry[] };

/** The flow as edited, the revision it was last saved as, and the history each save extends. */
export function useFlowDraft({ initial, revision, revisions }: Options) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [flow, setFlow] = useState(initial);
  const [saved, setSaved] = useState(revision);
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState(revisions);
  const edit = (next: Flow) => {
    setFlow(next);
    setDirty(true);
  };
  const save = () =>
    run(async () => {
      const next = (await api.call("flow.save", { flow })).revision;
      setSaved(next);
      setDirty(false);
      // Unchanged content saves as the same revision; the time shown is the store's on reload.
      const entry = { revision: next, savedAt: new Date().toISOString() };
      setHistory((entries) =>
        entries.some((known) => known.revision === next) ? entries : [...entries, entry],
      );
    });
  return { flow, edit, saved, dirty, history, save, error, busy };
}
