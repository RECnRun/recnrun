// Architecture boundaries. Keep docs/ARCHITECTURE.md in sync with these rules.
const TEST = "(^|/)tests/|\\.(test|spec)\\.tsx?$|\\.checks\\.mjs$";
const CONFIG = "(^|/)[^/]+\\.config\\.(ts|mjs|cjs)$|(^|/)\\.dependency-cruiser\\.cjs$";

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Cycles hide layering mistakes; split the shared part into its own module.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "error",
      comment: "Unreachable module. Delete it or import it from where it belongs.",
      from: {
        orphan: true,
        pathNot: [TEST, CONFIG, "\\.d\\.ts$", "(^|/)src/main\\.tsx$", "(^|/)scripts/"],
      },
      to: {},
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "not-to-dev-dep",
      severity: "error",
      comment: "Production code ships only runtime dependencies.",
      from: { path: "^(apps|packages)/[^/]+/src/" },
      to: {
        dependencyTypes: ["npm-dev"],
        pathNot: ["/node_modules/@types/"],
      },
    },
    {
      name: "src-not-to-tests",
      severity: "error",
      from: { path: "^(apps|packages)/[^/]+/src/" },
      to: { path: TEST },
    },
    {
      name: "packages-not-to-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "brand-is-leaf",
      severity: "error",
      comment: "Brand holds assets shared by the apps; it depends on nothing.",
      from: { path: "^packages/brand/" },
      to: { pathNot: "^packages/brand/" },
    },
    {
      name: "protocol-pure",
      severity: "error",
      comment:
        "Protocol is the shared contract: Valibot schemas only, no runtime or workspace code.",
      from: { path: "^packages/protocol/src/" },
      to: { pathNot: ["^packages/protocol/src/", "/node_modules/valibot/"] },
    },
    {
      name: "engine-not-to-adapter-impl",
      severity: "error",
      comment:
        "The engine defines the adapter interface; Playwright, CDP, and Node APIs stay in adapters.",
      from: { path: "^packages/engine/src/" },
      to: { pathNot: ["^packages/engine/src/", "^packages/protocol/src/"] },
    },
    {
      name: "adapter-boundaries",
      severity: "error",
      comment:
        "The adapter implements the engine's interface over playwright-core and CDP; discovery reads DevToolsActivePort and probes its loopback port; Valibot validates CDP replies.",
      from: { path: "^packages/adapter/src/" },
      to: {
        pathNot: [
          "^packages/(adapter|engine|protocol)/src/",
          "/node_modules/playwright-core/",
          "/node_modules/valibot/",
          "^(fs/promises|net|os|path)$",
        ],
      },
    },
    {
      name: "persistence-boundaries",
      severity: "error",
      comment:
        "Persistence owns the file system and SQLite; it knows only the protocol's shapes, and yaml reads and writes flow.yaml.",
      from: { path: "^packages/persistence/src/" },
      to: {
        pathNot: ["^packages/(persistence|protocol)/src/", "/node_modules/yaml/"],
        dependencyTypesNot: ["core"],
      },
    },
    {
      name: "service-boundaries",
      severity: "error",
      comment:
        "The service composes the engine, the adapter, and persistence behind its loopback HTTP and WebSocket API; Valibot validates every request at that boundary.",
      from: { path: "^apps/service/src/" },
      to: {
        pathNot: [
          "^apps/service/src/",
          "^packages/(engine|adapter|persistence|protocol)/src/",
          "/node_modules/valibot/",
          "^(crypto|http|net|os|stream)$",
        ],
      },
    },
    {
      name: "cli-only-service",
      severity: "error",
      comment: "The CLI is a client of the service; it carries no engine of its own.",
      from: { path: "^apps/cli/src/" },
      to: { pathNot: ["^apps/(cli|service)/src/"] },
    },
    {
      name: "ui-only-protocol",
      severity: "error",
      comment:
        "The UI talks to the service over its API; it shares only protocol shapes and the brand.",
      from: { path: "^apps/ui/src/" },
      to: {
        pathNot: ["^apps/ui/src/", "^packages/(protocol|brand)/src/", "/node_modules/preact/"],
      },
    },
    {
      name: "fixture-isolated",
      severity: "error",
      comment: "The fixture stands in for any web app under test; it shares no workspace code.",
      from: { path: "^apps/fixture/src/" },
      to: { path: "^(apps|packages)/", pathNot: "^apps/fixture/" },
    },
    {
      name: "website-only-brand",
      severity: "error",
      comment: "The website is the public landing; it ships no engine, protocol, or UI code.",
      from: { path: "^apps/website/" },
      to: { path: "^packages/", pathNot: "^packages/brand/" },
    },
    {
      name: "website-ui-presentational",
      severity: "error",
      comment: "src/ui renders props only; it knows nothing about features or the app.",
      from: { path: "^apps/website/src/ui/" },
      to: { path: "^apps/website/src/(features|app)/" },
    },
    {
      name: "website-features-isolated",
      severity: "error",
      comment: "Features do not import each other; compose them in src/app.",
      from: { path: "^apps/website/src/features/([^/]+)/" },
      to: {
        path: "^apps/website/src/features/([^/]+)/",
        pathNot: "^apps/website/src/features/$1/",
      },
    },
    {
      name: "website-app-is-top",
      severity: "error",
      from: { path: "^apps/website/src/(ui|features)/" },
      to: { path: "^apps/website/src/(app/|main\\.tsx$)" },
    },
    {
      name: "not-to-entrypoints",
      severity: "error",
      comment: "Entrypoints are thin wiring; nothing imports them.",
      from: {},
      to: { path: "^apps/[^/]+/src/(main\\.tsx|bin\\.ts)$" },
    },
  ],
  options: {
    parser: "swc",
    // npm packages stay in the graph as leaves, so rules can name them; only the workspaces' build
    // output is left out (a package's own dist/ must stay in).
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(apps|packages)/[^/]+/dist/" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
