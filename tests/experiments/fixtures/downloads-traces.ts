/** The probe's answer, as the trace judges need it. */
export type ProbeAnswer = { ok: true; filename: string } | { ok: false; error: string };

/** `chrome.downloads.search({})` right after the one write. */
export type HistoryAnswer = { ok: true; filenames: string[] } | { ok: false; error: string };

const probeProblems = (probe: ProbeAnswer) =>
  probe.ok ? [] : [`the probe failed: ${probe.error}`];

/** One write on a fresh profile leaves exactly one history entry, the probe's. */
export function historyProblems(probe: ProbeAnswer, history: HistoryAnswer): string[] {
  if (!probe.ok) return probeProblems(probe);
  if (!history.ok) return [`the history query failed: ${history.error}`];
  const [entry, ...more] = history.filenames;
  if (entry === undefined || more.length > 0) {
    return [
      `${history.filenames.length} history entries after one write on a fresh profile, not 1`,
    ];
  }
  return entry === probe.filename ? [] : [`the history entry is ${entry}, not the probe`];
}

/** What the display showed around the write. */
export interface DisplaySeen {
  before: string[];
  after: string[];
  screenshotBytes: number;
}

const CHROME_WINDOW = / - Google Chrome$/;

/** The display was read: Chrome's own window listed before and after, and a screenshot taken. */
export function uiProblems(probe: ProbeAnswer, seen: DisplaySeen): string[] {
  const problems = probeProblems(probe);
  const listed = (names: string[]) => names.some((name) => CHROME_WINDOW.test(name));
  if (!listed(seen.before) || !listed(seen.after)) {
    problems.push("the display listed no Google Chrome window before and after the write");
  }
  if (seen.screenshotBytes === 0) problems.push("no screenshot of the display");
  return problems;
}
