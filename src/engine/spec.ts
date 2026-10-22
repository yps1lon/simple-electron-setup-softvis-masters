import * as fs from "node:fs";
import { minimatch } from "minimatch";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ArchitectureSpec, RawGraph } from "./types.js";

/**
 * Read a human-written architecture spec (YAML) and validate it. Every
 * module named in `allowed`, on either side of the relation, must exist in
 * `modules` — a typo there would silently turn real drift into "absent"
 * edges or hide it entirely, so it is a hard error naming the file and the
 * offending module.
 */
export function loadSpec(specPath: string): ArchitectureSpec {
  const text = fs.readFileSync(specPath, "utf8");
  const raw: unknown = parseYaml(text);

  if (raw === null || typeof raw !== "object") {
    throw new Error(`${specPath}: expected a YAML mapping at the top level`);
  }

  const modules = readStringListMap(raw, "modules", specPath);
  const allowed =
    "allowed" in raw && raw.allowed !== null && raw.allowed !== undefined
      ? readStringListMap(raw, "allowed", specPath)
      : {};

  const known = new Set(Object.keys(modules));
  for (const [from, targets] of Object.entries(allowed)) {
    if (!known.has(from)) {
      throw new Error(
        `${specPath}: allowed lists module "${from}", which is not defined in modules`,
      );
    }
    for (const to of targets) {
      if (!known.has(to)) {
        throw new Error(
          `${specPath}: allowed lets "${from}" depend on "${to}", which is not defined in modules`,
        );
      }
    }
  }

  return { modules, allowed };
}

function readStringListMap(
  raw: object,
  key: string,
  specPath: string,
): Record<string, string[]> {
  const value = (raw as Record<string, unknown>)[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${specPath}: "${key}" must be a mapping of name to list`);
  }
  const result: Record<string, string[]> = {};
  for (const [name, patterns] of Object.entries(value)) {
    if (
      !Array.isArray(patterns) ||
      patterns.some((p) => typeof p !== "string")
    ) {
      throw new Error(
        `${specPath}: "${key}.${name}" must be a list of strings`,
      );
    }
    result[name] = patterns;
  }
  return result;
}

/**
 * Assign each file to a module by testing the spec's globs.
 *
 * Two deliberate decisions:
 * - First match wins, in the order modules appear in the YAML. The human's
 *   ordering is the priority rule for overlapping globs; there is no magic.
 * - A file that matches nothing gets null. That is not an error: unmapped
 *   files are findings, reported in the result, never silently dropped.
 */
export function assignModules(
  graph: RawGraph,
  spec: ArchitectureSpec,
): RawGraph {
  const entries = Object.entries(spec.modules);
  const files = graph.files.map((file) => ({
    ...file,
    module: findModule(file.id, entries),
  }));
  return { ...graph, files };
}

function findModule(
  fileId: string,
  entries: [string, string[]][],
): string | null {
  for (const [name, patterns] of entries) {
    for (const pattern of patterns) {
      if (minimatch(fileId, pattern)) return name;
    }
  }
  return null;
}

/** Folder names that are containers, not architecture modules. */
const CONTAINER_SEGMENTS = new Set(["src", "lib", "app", "packages"]);

/**
 * Propose a spec skeleton from the folder layout.
 *
 * `allowed` is emitted EMPTY on purpose, and this is the single most
 * important rule of the project: an intended architecture derived from the
 * actual code could never disagree with it. Drift would be undetectable by
 * construction, which would invalidate the method the whole thesis rests
 * on. The tool proposes module names only; the human declares the intent.
 */
export function proposeSpec(graph: RawGraph): string {
  const globsByModule = new Map<string, string>();

  for (const file of graph.files) {
    const { name, glob } = proposeModule(file.id);
    globsByModule.set(name, glob);
  }

  // Sorted for determinism. The proposed globs are disjoint by construction
  // (each file lands in exactly one module), so order changes no assignment.
  const names = [...globsByModule.keys()].sort();
  const modules: Record<string, string[]> = {};
  const allowed: Record<string, string[]> = {};
  for (const name of names) {
    modules[name] = [globsByModule.get(name)!];
    allowed[name] = [];
  }

  const header = [
    "# Proposed architecture, generated from the folder layout.",
    "#",
    "# This is a starting point, not a result:",
    "#   1. Rename modules and adjust globs to match your INTENT.",
    "#   2. Fill in `allowed`: for each module, list the modules it may",
    "#      depend on.",
    "# `allowed` is deliberately empty — the intended architecture must come",
    "# from you, not from the code as it exists today.",
    "",
  ].join("\n");

  return header + stringifyYaml({ modules, allowed });
}

/**
 * Group by the first path segment, or the second when the first is a
 * container folder (src, lib, app, packages). A file sitting directly in a
 * container or at the repo root would otherwise become a one-file module
 * named after itself, so those collapse into a module for that level.
 */
function proposeModule(fileId: string): { name: string; glob: string } {
  const segments = fileId.split("/");

  if (segments.length === 1) {
    return { name: "root", glob: "*.{ts,tsx,mts,cts}" };
  }
  const [first, second] = segments;
  if (CONTAINER_SEGMENTS.has(first)) {
    if (segments.length === 2) {
      return { name: first, glob: `${first}/*.{ts,tsx,mts,cts}` };
    }
    return { name: second, glob: `${first}/${second}/**` };
  }
  return { name: first, glob: `${first}/**` };
}
