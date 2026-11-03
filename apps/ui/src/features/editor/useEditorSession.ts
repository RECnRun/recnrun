import { useLoad } from "@/api/context";
import type { PickerSession } from "@/features/editor/usePicker";

/** The recording this tab runs, with its lease, so the editor's picker can use its page. */
export function useEditorSession(sessionId: string | undefined): PickerSession | undefined {
  const { loaded } = useLoad(
    async (api) => (sessionId ? api.call("session.status", { sessionId }) : undefined),
    sessionId ?? "",
  );
  if (loaded.state !== "ready" || loaded.value === undefined) return undefined;
  const { state, lease } = loaded.value;
  // A session that ended has no page to pick on; a missing one answers `not-found` above.
  if (state === "completed") return undefined;
  return { sessionId: loaded.value.sessionId, ...(lease && { lease }) };
}
