import { readdir, readFile } from "node:fs/promises";

/* W6.E cost readout: CPU seconds and RSS of one browser's process tree, from /proc only. */

const PAGE_BYTES = 4_096;
const TICKS_PER_SECOND = 100;

interface ProcStat {
  pid: number;
  ppid: number;
  cpuTicks: number;
  rssBytes: number;
}

async function statOf(pid: number): Promise<ProcStat | null> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  // The command name may hold spaces; the fields after its closing parenthesis do not.
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  if (fields.length < 22) return null;
  const at = (index: number) => Number(fields[index - 3]);
  return { pid, ppid: at(4), cpuTicks: at(14) + at(15), rssBytes: at(24) * PAGE_BYTES };
}

export interface Usage {
  processes: number;
  cpuSeconds: number;
  rssMiB: number;
}

/** CPU (user + system) and RSS summed over `root` and every descendant. */
export async function treeUsage(root: number): Promise<Usage> {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  const stats = (await Promise.all(pids.map(statOf))).filter((stat) => stat !== null);
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const stat of stats) {
      if (tree.has(stat.pid) || !tree.has(stat.ppid)) continue;
      tree.add(stat.pid);
      grew = true;
    }
  }
  const members = stats.filter((stat) => tree.has(stat.pid));
  const ticks = members.reduce((sum, stat) => sum + stat.cpuTicks, 0);
  const rss = members.reduce((sum, stat) => sum + stat.rssBytes, 0);
  return {
    processes: members.length,
    cpuSeconds: Number((ticks / TICKS_PER_SECOND).toFixed(2)),
    rssMiB: Math.round(rss / 2 ** 20),
  };
}

/** p50 and p95 with the sample count; p95 is null under 20 samples. */
export function quantiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.floor(q * (sorted.length - 1))] ?? 0);
  return {
    n: sorted.length,
    p50: sorted.length ? at(0.5) : null,
    p95: sorted.length >= 20 ? at(0.95) : null,
  };
}
