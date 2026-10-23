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
        pathNot: [
          TEST,
          CONFIG,
          "\\.d\\.ts$",
          "(^|/)src/entrypoints/",
          "(^|/)src/main\\.tsx$",
          "(^|/)scripts/",
        ],
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
        // WXT is the extension runtime framework; its helpers are bundled into the build.
        pathNot: ["/node_modules/wxt/", "/node_modules/@types/"],
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
      name: "website-not-to-extension",
      severity: "error",
      comment: "The website and the extension talk only through @recnrun/bridge messages.",
      from: { path: "^apps/website/" },
      to: { path: "^apps/extension/" },
    },
    {
      name: "extension-not-to-website",
      severity: "error",
      comment: "The website and the extension talk only through @recnrun/bridge messages.",
      from: { path: "^apps/extension/" },
      to: { path: "^apps/website/" },
    },
    {
      name: "domain-pure",
      severity: "error",
      comment: "The domain is plain data and schemas: no UI, browser, or protocol code.",
      from: { path: "^packages/domain/src/" },
      to: {
        pathNot: ["^packages/domain/src/", "/node_modules/valibot/"],
      },
    },
    {
      name: "bridge-only-valibot",
      severity: "error",
      comment: "The bridge carries no domain data; the dashboard reads storage itself.",
      from: { path: "^packages/bridge/src/" },
      to: {
        pathNot: ["^packages/bridge/src/", "/node_modules/valibot/"],
      },
    },
    {
      name: "brand-is-leaf",
      severity: "error",
      comment: "Brand holds assets shared by both apps; it depends on nothing.",
      from: { path: "^packages/brand/" },
      to: { pathNot: "^packages/brand/" },
    },
    {
      name: "website-bridge-only-in-services",
      severity: "error",
      comment: "Only src/services talks to the extension; the rest of the site uses its gateway.",
      from: { path: "^apps/website/src/", pathNot: "^apps/website/src/services/" },
      to: { path: "^packages/bridge/" },
    },
    {
      name: "website-ui-presentational",
      severity: "error",
      comment: "src/ui renders props only; it knows nothing about features, services, or the app.",
      from: { path: "^apps/website/src/ui/" },
      to: { path: "^apps/website/src/(features|services|app)/" },
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
      from: { path: "^apps/website/src/(ui|features|services)/" },
      to: { path: "^apps/website/src/(app/|main\\.tsx$)" },
    },
    {
      name: "website-services-not-to-ui",
      severity: "error",
      from: { path: "^apps/website/src/services/" },
      to: { path: "^apps/website/src/(ui|features)/" },
    },
    {
      name: "extension-content-not-to-storage",
      severity: "error",
      comment:
        "Content scripts run inside web pages; they reach data only by messaging the background.",
      from: { path: "^apps/extension/src/content/" },
      to: { path: "^apps/extension/src/storage/" },
    },
    {
      name: "extension-dashboard-isolated",
      severity: "error",
      from: { path: "^apps/extension/src/dashboard/" },
      to: { path: "^apps/extension/src/(content|background)/" },
    },
    {
      name: "not-to-entrypoints",
      severity: "error",
      comment: "Entrypoints are thin wiring; nothing imports them.",
      from: {},
      to: { path: "^apps/extension/src/entrypoints/|^apps/website/src/main\\.tsx$" },
    },
  ],
  options: {
    parser: "swc",
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|\\.output|\\.wxt|dist)/" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
