import type { AssertionStep, Target } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";
import { AssertionForm } from "@/features/editor/AssertionForm";
import { type AssertionKind, buildAssertion } from "@/features/editor/edit";
import type { PickerSession } from "@/features/editor/usePicker";
import { Card } from "@/ui/Card";
import { ErrorState } from "@/ui/States";
import { TargetText } from "@/ui/Target";

/** Assertions added to a recording's draft; finalizing the session appends them after its steps. */
export function DraftAssertions({ session }: { session: PickerSession }) {
  const api = useApi();
  const { error, run } = useAction();
  const [added, setAdded] = useState<AssertionStep[]>([]);
  const add = (target: Target, kind: AssertionKind, expected: string) =>
    run(async () => {
      const step = buildAssertion(`assert-${added.length + 1}`, kind, target, expected);
      const fence = { lease: session.lease };
      await api.call("flow.addAssertion", { sessionId: session.sessionId, step }, fence);
      setAdded((list) => [...list, step]);
    });
  return (
    <Card title="Add an assertion">
      <AssertionForm onAdd={add} session={session} />
      {error ? <ErrorState error={error} /> : null}
      {added.length === 0 ? null : (
        <ol class="list" aria-label="Draft assertions">
          {added.map((step) => (
            <li key={step.id}>
              <strong>{step.assertion}</strong>{" "}
              {"target" in step ? <TargetText target={step.target} /> : null}
              {"expected" in step ? <code> {String(step.expected)}</code> : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
