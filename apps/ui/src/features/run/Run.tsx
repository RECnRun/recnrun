import type { Flow } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import { useLoad } from "@/api/context";
import {
  type Draft,
  type Input,
  type RunValues,
  datasetDraft,
  initialDraft,
  parseDraft,
  referenceKey,
  secretReferences,
  withoutSecrets,
} from "@/features/run/inputs";
import { Datasets } from "@/features/run/Datasets";
import { Gaps } from "@/features/run/Gaps";
import { StepResults, Summary } from "@/features/run/Results";
import { Snapshots } from "@/features/run/Snapshots";
import { useRun } from "@/features/run/useRun";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Field } from "@/ui/Field";
import { EmptyState, ErrorState, Loadable } from "@/ui/States";

type InputProps = {
  name: string;
  input: Input;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
};

function InputField({ name, input, value, onChange }: InputProps) {
  const label = input.required ? `${name} (required)` : name;
  if (typeof value === "boolean") {
    return (
      <Field label={label}>
        <input
          type="checkbox"
          checked={value}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </Field>
    );
  }
  const onInput = (event: { currentTarget: HTMLInputElement }) =>
    onChange(event.currentTarget.value);
  if (input.secret) {
    return (
      <Field label={label}>
        <input type="password" autocomplete="off" value={value} onInput={onInput} />
      </Field>
    );
  }
  const json = input.type === "array" || input.type === "object";
  return (
    <Field label={label}>
      <input
        type="text"
        inputMode={input.type === "number" ? "decimal" : "text"}
        placeholder={json ? "JSON" : ""}
        value={value}
        onInput={onInput}
      />
    </Field>
  );
}

type FormProps = {
  flowId: string;
  inputs: Flow["inputs"];
  references: string[];
  disabled: boolean;
  onStart: (values: RunValues) => void;
};

// A recorded `${secrets.<name>}` reference must be typed for every run.
const REFERENCE: Input = { type: "string", required: true, secret: true };

function InputsForm({ flowId, inputs, references, disabled, onStart }: FormProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(inputs, references));
  const [problem, setProblem] = useState<string>();
  const submit = (event: Event) => {
    event.preventDefault();
    const parsed = parseDraft(inputs, draft, references);
    if (!parsed.ok) return setProblem(parsed.message);
    setProblem(undefined);
    setDraft(withoutSecrets(inputs, draft, references));
    onStart({ inputs: parsed.inputs, secrets: parsed.secrets });
  };
  const fields: [string, Input][] = [
    ...Object.entries(inputs),
    ...references.map((name): [string, Input] => [referenceKey(name), REFERENCE]),
  ];
  return (
    <form class="stack" aria-label="Inputs" onSubmit={submit}>
      {fields.length === 0 ? <p class="muted">This flow declares no inputs.</p> : null}
      {Object.keys(inputs).length > 0 ? (
        <Datasets
          flowId={flowId}
          inputs={inputs}
          draft={draft}
          onPick={(values) => setDraft(datasetDraft(inputs, values, draft))}
        />
      ) : null}
      {fields.map(([name, input]) => (
        <InputField
          key={name}
          name={name}
          input={input}
          value={draft[name] ?? ""}
          onChange={(value) => setDraft({ ...draft, [name]: value })}
        />
      ))}
      {problem ? <ErrorState error={{ code: "invalid-input", message: problem }} /> : null}
      <div class="row">
        <Button type="submit" variant="primary" disabled={disabled}>
          Start run
        </Button>
        <Button disabled>Stop</Button>
        <p class="muted">Stopping a run is not available yet: the service does not expose it.</p>
      </div>
    </form>
  );
}

type Navigation = { onDiagnostics?: ((runId: string) => void) | undefined };

function RunFlow({ flowId, flow, onDiagnostics }: { flowId: string; flow: Flow } & Navigation) {
  const replay = useRun(flowId);
  return (
    <>
      <Card title={`Run ${flow.name}`}>
        <InputsForm
          flowId={flowId}
          inputs={flow.inputs}
          references={secretReferences(flow)}
          disabled={replay.busy || replay.running}
          onStart={replay.start}
        />
        {replay.error ? <ErrorState error={replay.error} /> : null}
      </Card>
      <Card title="Steps">
        {replay.runId ? (
          <StepResults steps={replay.steps} />
        ) : (
          <EmptyState>Start a run to see each step's result.</EmptyState>
        )}
      </Card>
      {replay.summary ? (
        <Card
          title="Summary"
          actions={
            onDiagnostics && (
              <Button onClick={() => onDiagnostics(replay.summary?.runId ?? "")}>
                Diagnostics
              </Button>
            )
          }
        >
          <Summary summary={replay.summary} />
        </Card>
      ) : null}
      {replay.summary ? (
        <Card title="Collector gaps">
          <Gaps runId={replay.summary.runId} />
        </Card>
      ) : null}
      {replay.summary ? (
        <Card title="Snapshots">
          <Snapshots runId={replay.summary.runId} />
        </Card>
      ) : null}
    </>
  );
}

/** Replays a flow with the inputs the user gives and follows each step until the run ends. */
export function Run({ flowId, onDiagnostics }: { flowId: string } & Navigation) {
  const { loaded, reload } = useLoad((api) => api.call("flow.get", { flowId }), flowId);
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {({ flow }) => <RunFlow flowId={flowId} flow={flow} onDiagnostics={onDiagnostics} />}
    </Loadable>
  );
}
