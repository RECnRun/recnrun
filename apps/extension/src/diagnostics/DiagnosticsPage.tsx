interface Row {
  path: string;
  label: string;
  text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPlain = (value: unknown) => !isRecord(value) && !Array.isArray(value);

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map(textOf).join(", ");
  return typeof value === "object"
    ? JSON.stringify(value)
    : String(value as string | number | boolean);
}

/** One row per leaf: a list of plain values is one row, and a null or empty section is one too. */
function rowsOf(value: unknown, path: string, label: string): Row[] {
  if (Array.isArray(value) && !value.every(isPlain)) {
    return value.flatMap((each, index) => rowsOf(each, `${path}.${index}`, `${label}.${index}`));
  }
  if (!isRecord(value)) return [{ path, label, text: textOf(value) }];
  return Object.entries(value).flatMap(([key, each]) =>
    rowsOf(each, `${path}.${key}`, label ? `${label}.${key}` : key),
  );
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      <dl>
        {rows.map(({ path, label, text }) => (
          <div key={path}>
            <dt>{label}</dt>
            <dd data-field={path}>{text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The report as labelled sections; every value carries its path in `data-field`. */
export function DiagnosticsPage({ report }: { report: object }) {
  const { profile, ...build } = report as Record<string, unknown>;
  const sections = isRecord(profile) ? Object.entries(profile) : [];
  return (
    <main>
      <h1>RECnRun diagnostics</h1>
      <Section
        title="Build"
        rows={Object.entries(build).flatMap(([key, each]) => rowsOf(each, key, key))}
      />
      {sections.map(([key, each]) => (
        <Section key={key} title={key} rows={rowsOf(each, `profile.${key}`, key)} />
      ))}
    </main>
  );
}
