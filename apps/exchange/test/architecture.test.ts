import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

/**
 * The service's layers, lowest first. A file belongs to the layer named by its first path
 * segment under `src/` (a folder, or a file without its extension). An import may stay inside
 * its own layer or point down this list, never up: the transport knows no board, board chat
 * knows no route, and only `main` wires them together.
 *
 * `store` sits beside config at the bottom: it knows tables, and nothing above it may be reached
 * from it. The AgentPod hub's `services/board-chat` moves into `board-chat` in a later step; this keeps it
 * from reaching back into the routes that will call it. A new top-level folder must be placed in
 * this list before anything can live in it.
 */
export const LAYERS = [
  "config",
  "store",
  "appservice",
  "board-chat",
  "routes",
  "main",
] as const;

const SRC = join(import.meta.dir, "..", "src");

/**
 * Neighbours in LAYERS with no import between them, as 'upper>lower'. Every other layer imports
 * the one just below it, so the order is read from the code rather than chosen: swapping two
 * layers would turn a real import into an upward one. `store` knows no settings, so nothing
 * orders it above `config`.
 */
export const UNJOINED_NEIGHBOURS = ["store>config"];

/** Lines a source file under src/ may have. */
export const SIZE_LIMIT = 1000;
/** Files over SIZE_LIMIT and the most lines each may have. Lower these; never raise them. */
export const OVERSIZE: Record<string, number> = {
  "store/index.ts": 2317,
};
/** Files in the largest runtime import cycle under src/. Lower it; never raise it. */
export const LARGEST_CYCLE = 3;

/** Relative import specifiers in a TypeScript source (static, dynamic and re-exports). */
export function relativeImports(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']*)["']/g;
  for (const m of source.matchAll(pattern)) {
    if (m[1] !== undefined) found.push(m[1]);
  }
  return found;
}

/** The layer of a path relative to `src/` (posix separators), or null when it is in none. */
export function layerOf(path: string): string | null {
  const [first] = path.split("/");
  if (first === undefined) return null;
  const name = first.replace(/\.ts$/, "");
  return (LAYERS as readonly string[]).includes(name) ? name : null;
}

/** Every rule a set of files breaks, as one line each. `files` maps a path under src/ to its source. */
export function violations(files: Record<string, string>): string[] {
  const out: string[] = [];
  const rank = (layer: string) => (LAYERS as readonly string[]).indexOf(layer);
  for (const [path, source] of Object.entries(files)) {
    const from = layerOf(path);
    if (from === null) {
      out.push(`${path} is in no layer`);
      continue;
    }
    for (const spec of relativeImports(source)) {
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      if (target.startsWith("..")) {
        out.push(`${path} imports ${spec}, outside src/`);
        continue;
      }
      const to = layerOf(target);
      if (to === null)
        out.push(`${path} imports ${spec}, which is in no layer`);
      else if (rank(to) > rank(from))
        out.push(`${path} (${from}) imports ${spec} (${to}), a higher layer`);
    }
  }
  return out;
}

/**
 * The files each file under src/ loads at run time: its relative static imports and re-exports
 * that bring in a value, and its dynamic imports. `import type`, `export type` and an import
 * whose every name is `type X` are erased by the compiler and load nothing, so they cannot form
 * a cycle. `files` maps a path under src/ to its source.
 */
export function runtimeGraph(
  files: Record<string, string>,
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const statement =
    /^[ \t]*(import|export)\b(\s+type\b)?([^;"']*?)\bfrom\s*["'](\.{1,2}\/[^"']*)["']/gm;
  const bare = /^[ \t]*import\s*["'](\.{1,2}\/[^"']*)["']/gm;
  const dynamic = /\bimport\s*\(\s*["'](\.{1,2}\/[^"']*)["']\s*\)/g;
  for (const [path, source] of Object.entries(files)) {
    const targets = new Set<string>();
    const add = (spec: string) => {
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      if (!target.startsWith("..")) targets.add(target);
    };
    for (const m of source.matchAll(statement)) {
      if (m[2] !== undefined) continue;
      const names = (m[3] ?? "")
        .replace(/[{}]/g, "")
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n !== "");
      // A default, namespace or `*` import carries a value; so does any name not marked `type`.
      const value = names.some((n) => !n.startsWith("type "));
      if (value) add(m[4] ?? "");
    }
    for (const m of source.matchAll(bare)) add(m[1] ?? "");
    for (const m of source.matchAll(dynamic)) add(m[1] ?? "");
    graph.set(path, [...targets].toSorted());
  }
  return graph;
}

/** Strongly connected components with more than one file (Tarjan), each sorted. */
export function cycles(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w))
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    let w: string | undefined;
    do {
      w = stack.pop();
      if (w === undefined) break;
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1) found.push(component.toSorted());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}

/** Lines in a source text, as `wc -l` counts them. */
export const lineCount = (source: string): number =>
  source.split("\n").length - 1;

/**
 * What the size rule says about a set of files: those over their limit (OVERSIZE's entry, or
 * SIZE_LIMIT), and OVERSIZE entries that are stale because their file shrank or is gone.
 */
export function sizeFindings(
  files: Record<string, string>,
  oversize: Record<string, number>,
  limit = SIZE_LIMIT,
): { over: string[]; stale: string[] } {
  const over: string[] = [];
  for (const [path, source] of Object.entries(files)) {
    const n = lineCount(source);
    const allowed = Math.max(limit, oversize[path] ?? 0);
    if (n > allowed)
      over.push(`${path} has ${n} lines; the limit is ${allowed}`);
  }
  const stale = Object.entries(oversize)
    .filter(([path, n]) => {
      const source = files[path];
      return source === undefined || lineCount(source) < n;
    })
    .map(([path]) => path);
  return { over: over.toSorted(), stale: stale.toSorted() };
}

/** Neighbouring layers ('upper>lower') with no import from the upper one to the lower one. */
export function unjoined(files: Record<string, string>): string[] {
  const edges = new Set<string>();
  for (const [path, source] of Object.entries(files))
    for (const spec of relativeImports(source)) {
      const from = layerOf(path);
      const to = layerOf(
        posix.normalize(posix.join(posix.dirname(path), spec)),
      );
      if (from !== null && to !== null) edges.add(`${from}>${to}`);
    }
  return LAYERS.slice(1)
    .map((layer, i) => `${layer}>${LAYERS[i] ?? ""}`)
    .filter((pair) => !edges.has(pair));
}

/** A source text of `n` lines. */
const lines = (n: number): string => "x\n".repeat(n);

function sources(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(files, sources(full));
    else if (name.endsWith(".ts"))
      files[relative(SRC, full).split(sep).join("/")] = readFileSync(
        full,
        "utf8",
      );
  }
  return files;
}

describe("architecture", () => {
  test("every source file is in a layer, and imports only down", () => {
    const files = sources(SRC);
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(violations(files)).toEqual([]);
  });

  test("no runtime import cycle grows past the recorded size", () => {
    const largest = Math.max(
      0,
      ...cycles(runtimeGraph(sources(SRC))).map((c) => c.length),
    );
    expect(largest, "the largest import cycle grew").toBeLessThanOrEqual(
      LARGEST_CYCLE,
    );
    expect(largest, "the cycle shrank; lower LARGEST_CYCLE to lock it in").toBe(
      LARGEST_CYCLE,
    );
  });

  test("no source file grows past the size limit, and OVERSIZE is not stale", () => {
    const { over, stale } = sizeFindings(sources(SRC), OVERSIZE);
    expect(over).toEqual([]);
    expect(
      stale,
      "these files shrank; lower or remove their OVERSIZE entry",
    ).toEqual([]);
  });

  // The cycle and size rules against inputs they must refuse, so the tests above cannot pass by
  // checking nothing.
  test("the cycle finder sees a runtime cycle and nothing else", () => {
    const graph = runtimeGraph({
      "a.ts": 'import { b } from "./b.ts";',
      "b.ts": 'export { c } from "./c.ts";',
      "c.ts": 'const a = await import("./a.ts");',
      "d.ts": 'import { a } from "./a.ts";',
      // Type-only imports load nothing: neither of these closes a cycle.
      "e.ts": 'import type { F } from "./f.ts";',
      "f.ts": 'import { type E } from "./e.ts";\nimport "./g.ts";',
      "g.ts": 'import { h, type H } from "./h.ts";',
      "h.ts": 'import x, { type G } from "./g.ts";',
    });
    expect(graph.get("e.ts")).toEqual([]);
    expect(graph.get("f.ts")).toEqual(["g.ts"]);
    expect(cycles(graph)).toEqual([
      ["a.ts", "b.ts", "c.ts"],
      ["g.ts", "h.ts"],
    ]);
  });

  test("the size rule refuses a file over its limit and a stale entry", () => {
    expect(
      sizeFindings(
        {
          "a.ts": lines(11),
          "b.ts": lines(10),
          "c.ts": lines(30),
          "d.ts": lines(19),
        },
        { "c.ts": 25, "d.ts": 20, "gone.ts": 40 },
        10,
      ),
    ).toEqual({
      over: [
        "a.ts has 11 lines; the limit is 10",
        "c.ts has 30 lines; the limit is 25",
      ],
      stale: ["d.ts", "gone.ts"],
    });
  });

  test("the layer order is the one the imports give", () => {
    expect(unjoined(sources(SRC))).toEqual(UNJOINED_NEIGHBOURS);
  });

  test("every layer is a folder or file that exists", () => {
    const present = new Set(Object.keys(sources(SRC)).map(layerOf));
    for (const layer of LAYERS) expect(present.has(layer)).toBe(true);
  });

  // The rule itself, against files it must refuse: so the test above cannot pass by checking nothing.
  test("an import up the layers is refused", () => {
    expect(
      violations({
        "appservice/index.ts": 'import { handle } from "../routes/index.ts";',
        "board-chat/gates.ts": 'export { x } from "../routes/index.ts";',
        "routes/index.ts": 'const m = await import("../main.ts");',
        "store/index.ts": 'import { x } from "../appservice/index.ts";',
      }),
    ).toEqual([
      "appservice/index.ts (appservice) imports ../routes/index.ts (routes), a higher layer",
      "board-chat/gates.ts (board-chat) imports ../routes/index.ts (routes), a higher layer",
      "routes/index.ts (routes) imports ../main.ts (main), a higher layer",
      "store/index.ts (store) imports ../appservice/index.ts (appservice), a higher layer",
    ]);
  });

  test("a file outside the layers, or an import out of src/, is refused", () => {
    expect(
      violations({
        "rooms/index.ts": "",
        "routes/index.ts": 'import x from "../../test/helpers.ts";',
      }),
    ).toEqual([
      "rooms/index.ts is in no layer",
      "routes/index.ts imports ../../test/helpers.ts, outside src/",
    ]);
  });

  test("an import down, or within a layer, is allowed", () => {
    expect(
      violations({
        "main.ts":
          'import { handle } from "./routes/index.ts";\nimport { loadConfig } from "./config.ts";',
        "routes/index.ts":
          'import "../board-chat/index.ts";\nimport { a } from "./a.ts";',
        "board-chat/gates.ts":
          'import { client } from "../appservice/client.ts";',
      }),
    ).toEqual([]);
  });
});
