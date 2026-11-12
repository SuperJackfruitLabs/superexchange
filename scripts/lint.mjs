#!/usr/bin/env bun
// Type-aware lint with a ratchet (docs/code-quality.md).
//
// oxlint runs with oxlint-tsgolint over apps/, deploy/ and scripts/. Findings are counted per
// rule in scripts/lint-baseline.json, in two parts: `src` (shipped source: under a src/ folder
// and not a test file) and `rest` (tests, deploy and scripts). A count may fall but never rise,
// and a rule missing from a part must be clean there, so a rule at zero in shipped source stays
// at zero whatever the tests allow. An improvement must be locked in:
// `bun run lint --update` lowers the baseline after a cleanup and refuses to raise it; a rule
// that reaches zero leaves the baseline and must then stay clean.
//
// Run it after `bun install --frozen-lockfile`; without the dependencies the typed rules cannot
// load the project and report typescript(tsconfig-error), which the baseline does not allow.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts/lint-baseline.json");
const update = process.argv.includes("--update");
const PATHS = ["apps", "deploy", "scripts"];

const run = spawnSync(
  join(root, "node_modules/.bin/oxlint"),
  ["--type-aware", "--format", "json", ...PATHS],
  { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);
if (run.error) throw run.error;
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  process.stderr.write(run.stderr || run.stdout);
  process.exit(2);
}

/** Shipped source: under a src/ folder and not a test file. */
const isSource = (file) =>
  /(^|\/)src\//.test(file) && !/(\.test\.|\.spec\.)/.test(file);
const partOf = (file) =>
  isSource(relative(root, join(root, file))) ? "src" : "rest";

const findings = report.diagnostics;
const counts = { src: {}, rest: {} };
for (const finding of findings) {
  const part = counts[partOf(finding.filename)];
  part[finding.code] = (part[finding.code] ?? 0) + 1;
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const where = (f) => {
  const at = f.labels?.[0]?.span;
  return `${f.filename}${at ? ":" + at.line : ""}`;
};

let failed = false;
for (const part of ["src", "rest"]) {
  const allowed = baseline[part] ?? {};
  for (const [rule, n] of Object.entries(counts[part])) {
    if (n <= (allowed[rule] ?? 0)) continue;
    failed = true;
    console.error(
      `${rule} (${part}): ${n} findings, the baseline allows ${allowed[rule] ?? 0}`,
    );
    for (const f of findings
      .filter((x) => x.code === rule && partOf(x.filename) === part)
      .slice(0, 20))
      console.error(`  ${where(f)}  ${f.message}`);
  }
}
if (failed) process.exit(1);

const lowered = ["src", "rest"].flatMap((part) =>
  Object.keys(baseline[part] ?? {})
    .filter((rule) => (counts[part][rule] ?? 0) < baseline[part][rule])
    .map((rule) => `${rule} (${part})`),
);
const sorted = (o) =>
  Object.fromEntries(
    Object.entries(o).toSorted(([a], [b]) => a.localeCompare(b)),
  );
if (update) {
  const next = { src: sorted(counts.src), rest: sorted(counts.rest) };
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
  console.log(`lint baseline: ${findings.length} findings held`);
} else if (lowered.length) {
  // A stale baseline would let the count creep back up unnoticed.
  console.error(
    `lint: ${lowered.join(", ")} improved; run bun run lint --update to lock it in`,
  );
  process.exit(1);
} else {
  console.log(`lint: ok (${findings.length} findings held by the baseline)`);
}
