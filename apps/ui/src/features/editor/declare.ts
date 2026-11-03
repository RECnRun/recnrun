import {
  type Flow,
  ID_PATTERN,
  type INPUT_TYPES,
  NAME_PATTERN,
  type Step,
} from "@recnrun/protocol";

export type InputType = (typeof INPUT_TYPES)[number];

export type Input = Flow["inputs"][string];

type Requirement = Flow["requirements"][number];

export const isName = (text: string) => NAME_PATTERN.test(text);

export const isId = (text: string) => ID_PATTERN.test(text);

/** The default an input's text field describes, in the input's type; an empty field means none. */
export function parseDefault(type: InputType, text: string): unknown {
  if (text === "") return undefined;
  if (type === "string") return text;
  if (type === "boolean") return text === "true";
  if (type === "number") {
    const value = Number(text);
    if (Number.isNaN(value)) throw new Error("The default must be a number.");
    return value;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The default must be JSON (${type}).`);
  }
}

/** Declares or replaces an input; one without a default must be given at run time. */
export function addInput(
  flow: Flow,
  name: string,
  input: { type: InputType; default?: unknown },
): Flow {
  const declared: Input =
    input.default === undefined
      ? { type: input.type, required: true }
      : { type: input.type, required: false, default: input.default };
  return { ...flow, inputs: { ...flow.inputs, [name]: declared } };
}

export function removeInput(flow: Flow, name: string): Flow {
  const { [name]: _removed, ...inputs } = flow.inputs;
  return { ...flow, inputs };
}

export function addActor(flow: Flow, name: string, description: string): Flow {
  return { ...flow, actors: { ...flow.actors, [name]: description ? { description } : {} } };
}

/** Removes the actor and every step's reference to it. */
export function removeActor(flow: Flow, name: string): Flow {
  const { [name]: _removed, ...actors } = flow.actors;
  const steps = flow.steps.map((step): Step => {
    if (step.actor !== name) return step;
    const { actor: _actor, ...rest } = step;
    return rest as Step;
  });
  return { ...flow, actors, steps };
}

export function addRequirement(flow: Flow, requirement: Requirement): Flow {
  return { ...flow, requirements: [...flow.requirements, requirement] };
}

/** The step with these requirement links; none removes the key. */
function linked(step: Step, requirements: string[]): Step {
  const { requirements: _previous, ...rest } = step;
  return (requirements.length === 0 ? rest : { ...rest, requirements }) as Step;
}

/** Removes the requirement and unlinks it from every step. */
export function removeRequirement(flow: Flow, id: string): Flow {
  const requirements = flow.requirements.filter((requirement) => requirement.id !== id);
  const steps = flow.steps.map((step) =>
    step.requirements?.includes(id)
      ? linked(
          step,
          step.requirements.filter((other) => other !== id),
        )
      : step,
  );
  return { ...flow, requirements, steps };
}

/** Links the requirement to the step, or unlinks it when it is linked already. */
export function toggleRequirement(flow: Flow, stepId: string, id: string): Flow {
  const steps = flow.steps.map((step) => {
    if (step.id !== stepId) return step;
    const current = step.requirements ?? [];
    const next = current.includes(id) ? current.filter((other) => other !== id) : [...current, id];
    return linked(step, next);
  });
  return { ...flow, steps };
}

/** The step's value when it is a literal; a reference such as `${inputs.email}` is not one. */
export function literalValue(step: Step): string | undefined {
  const value = "value" in step ? step.value : undefined;
  return typeof value === "string" && !value.includes("${") ? value : undefined;
}

/** Replaces the step's literal with `${inputs.<name>}`; a new input takes the literal as default. */
export function parameterize(flow: Flow, stepId: string, name: string): Flow {
  const step = flow.steps.find((other) => other.id === stepId);
  const literal = step === undefined ? undefined : literalValue(step);
  if (literal === undefined) return flow;
  const declared = Object.hasOwn(flow.inputs, name)
    ? flow
    : addInput(flow, name, { type: "string", default: literal });
  const steps = declared.steps.map((other): Step =>
    other.id === stepId ? ({ ...other, value: `\${inputs.${name}}` } as Step) : other,
  );
  return { ...declared, steps };
}
