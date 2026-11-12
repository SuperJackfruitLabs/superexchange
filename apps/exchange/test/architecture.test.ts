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
