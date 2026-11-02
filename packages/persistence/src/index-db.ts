import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parseStored,
  type FlowCatalogEntry,
  type RunCatalogEntry,
  type StoredShape,
  type StoreProblem,
} from "@recnrun/protocol";

/** The flows the index lists, and the files the last rebuild skipped. */
export interface FlowCatalog {
  flows: FlowCatalogEntry[];
  problems: StoreProblem[];
}

/** Everything the index lists, as a rebuild finds it in the flow folders. */
export interface CatalogRows extends FlowCatalog {
  runs: RunCatalogEntry[];
}

// Bumped when the tables change; an index of another version is dropped and rebuilt.
const INDEX_VERSION = 1;

const TABLES = `
  CREATE TABLE flows (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
    revision TEXT NOT NULL, updatedAt TEXT NOT NULL);
  CREATE TABLE runs (id TEXT NOT NULL, flowId TEXT NOT NULL, revision TEXT NOT NULL,
    status TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT, PRIMARY KEY (flowId, id));
  CREATE TABLE problems (path TEXT PRIMARY KEY, code TEXT NOT NULL, message TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

/** The SQLite catalog at ~/.recnrun/index.sqlite; the flow folders stay the source of truth. */
export class CatalogIndex {
  readonly #db: DatabaseSync;
  readonly #path: string;
  /** True when the file was missing or of another version, so the caller must rebuild it. */
  readonly needsRebuild: boolean;

  constructor(path: string) {
    const existed = existsSync(path);
    mkdirSync(dirname(path), { recursive: true });
    this.#path = path;
    this.#db = new DatabaseSync(path);
    const row = this.#db.prepare("PRAGMA user_version").get() as Row | undefined;
    this.needsRebuild = !existed || row?.["user_version"] !== INDEX_VERSION;
    if (this.needsRebuild) this.replace({ flows: [], runs: [], problems: [] });
  }

  /** Replaces every row in one transaction. */
  replace({ flows, runs, problems }: CatalogRows): void {
    this.#transaction(() => {
      this.#db.exec("DROP TABLE IF EXISTS flows; DROP TABLE IF EXISTS runs;");
      this.#db.exec(`DROP TABLE IF EXISTS problems; ${TABLES}`);
      this.#db.exec(`PRAGMA user_version = ${INDEX_VERSION}`);
      for (const flow of flows) this.putFlow(flow);
      for (const run of runs) this.putRun(run);
      for (const problem of problems) this.#putProblem(problem);
    });
  }

  putFlow(flow: FlowCatalogEntry): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO flows (id, name, status, revision, updatedAt) VALUES (?, ?, ?, ?, ?)",
      )
      .run(flow.id, flow.name, flow.status, flow.revision, flow.updatedAt);
  }

  putRun(run: RunCatalogEntry): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO runs (id, flowId, revision, status, startedAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(run.id, run.flowId, run.revision, run.status, run.startedAt, run.finishedAt);
  }

  /** Forgets a problem a later write fixed. */
  clearProblem(path: string): void {
    this.#db.prepare("DELETE FROM problems WHERE path = ?").run(path);
  }

  flows(): FlowCatalog {
    const problems: StoreProblem[] = this.#rows("store-problem", "problems", "path", []);
    const flows = this.#rows("flow-catalog-entry", "flows", "id", problems);
    return { flows, problems };
  }

  runs(flowId?: string): RunCatalogEntry[] {
    const where = flowId === undefined ? "" : "WHERE flowId = ?";
    const sql = `SELECT * FROM runs ${where} ORDER BY startedAt, flowId, id`;
    const rows = this.#db.prepare(sql).all(...(flowId === undefined ? [] : [flowId])) as Row[];
    return this.#check("run-catalog-entry", rows, []);
  }

  close(): void {
    this.#db.close();
  }

  #putProblem(problem: StoreProblem): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO problems (path, code, message) VALUES (?, ?, ?)")
      .run(problem.path, problem.code, problem.message);
  }

  #rows<K extends StoredShape>(shape: K, table: string, order: string, problems: StoreProblem[]) {
    const rows = this.#db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Row[];
    return this.#check(shape, rows, problems);
  }

  // A row that no longer validates is skipped and reported, like a corrupt file.
  #check<K extends StoredShape>(shape: K, rows: Row[], problems: StoreProblem[]) {
    return rows.flatMap((row) => {
      const parsed = parseStored(shape, { ...row });
      if (parsed.ok) return [parsed.value];
      problems.push({ path: this.#path, code: "invalid", message: parsed.message });
      return [];
    });
  }

  #transaction(work: () => void): void {
    this.#db.exec("BEGIN");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
