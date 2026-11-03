import type { Flow } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import type { Result } from "@/api/commands";
import { useAction, useApi, useLoad } from "@/api/context";
import { type Draft, datasetInputs } from "@/features/run/inputs";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { ErrorState, Loadable } from "@/ui/States";

type Entry = Result<"dataset.list">["datasets"][number];

type PickerProps = { datasets: Entry[]; picked: string; onPick: (name: string) => void };

/** One option per stored dataset; one the flow no longer accepts is disabled with its problem shown. */
function DatasetPicker({ datasets, picked, onPick }: PickerProps) {
  return (
    <>
      <Field label="Dataset">
        <select value={picked} onChange={(event) => onPick(event.currentTarget.value)}>
          <option value="">No dataset</option>
          {datasets.map(({ name, problem }) => (
            <option key={name} value={name} disabled={problem !== undefined}>
              {problem === undefined ? name : `${name} (cannot be used)`}
            </option>
          ))}
        </select>
      </Field>
      {datasets
        .filter((entry) => entry.problem !== undefined)
        .map(({ name, problem }) => (
          <p key={name} class="muted">
            {name}: {problem}
          </p>
        ))}
    </>
  );
}

type DatasetsProps = {
  flowId: string;
  inputs: Flow["inputs"];
  draft: Draft;
  /** The picked dataset's values, for the form to fill its non-secret fields. */
  onPick: (values: Record<string, unknown>) => void;
};

/** The flow's stored datasets: one fills the form, and the typed non-secret inputs can be saved as a new one. */
export function Datasets({ flowId, inputs, draft, onPick }: DatasetsProps) {
  const api = useApi();
  const key = `${flowId}/datasets`;
  const { loaded, reload } = useLoad((api) => api.call("dataset.list", { flowId }), key);
  const action = useAction();
  const [picked, setPicked] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();
  const pick = (datasets: Entry[], value: string) => {
    setPicked(value);
    const entry = datasets.find((candidate) => candidate.name === value);
    if (entry && entry.problem === undefined) onPick(entry.inputs);
  };
  const save = () => {
    const parsed = datasetInputs(inputs, draft);
    if (!parsed.ok) return setProblem(parsed.message);
    setProblem(undefined);
    action.run(async () => {
      await api.call("dataset.save", { flowId, name, inputs: parsed.inputs });
      setPicked(name);
      setName("");
      reload();
    });
  };
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {({ datasets }) => (
        <>
          <DatasetPicker datasets={datasets} picked={picked} onPick={(v) => pick(datasets, v)} />
          <div class="row">
            <Field label="Save as dataset">
              <input
                type="text"
                value={name}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </Field>
            <Button disabled={name === "" || action.busy} onClick={save}>
              Save dataset
            </Button>
          </div>
          {problem ? <ErrorState error={{ code: "invalid-input", message: problem }} /> : null}
          {action.error ? <ErrorState error={action.error} /> : null}
        </>
      )}
    </Loadable>
  );
}
