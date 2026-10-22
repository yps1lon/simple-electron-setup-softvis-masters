import * as path from "node:path";
import { ts } from "ts-morph";

/**
 * Import resolution on repo-relative paths, without touching the disk:
 * relative imports, tsconfig `paths` and `baseUrl` (following local
 * "extends", scoped to the tsconfig's folder), and workspace packages
 * (package.json "name" pointing at its source). Ported from the study's
 * replay scripts.
 *
 * The resolver also reports every candidate path it tried ("bases"), so the
 * replay can re-resolve only the files a new file could satisfy.
 */

const P = path.posix;

interface Alias {
  scope: string;
  key: string;
  targets: string[];
}

interface BaseUrl {
  scope: string;
  base: string;
}

export interface Aliases {
  aliases: Alias[];
  baseUrls: BaseUrl[];
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  /** Candidate source entries, most likely first. */
  entries: string[];
}

export type Resolver = (spec: string, fromFile: string) => { target: string | null; bases: string[] };

interface Tsconfig {
  dir: string;
  extendsFiles: string[];
  options: { baseUrl?: unknown; paths?: unknown };
}

interface Effective {
  baseUrl: string | null;
  paths: Record<string, unknown> | null;
  pathsBase: string | null;
}

/** tsconfig paths and baseUrl as each tsconfig sees them, deepest scope first. */
export function parseAliases(configTexts: Map<string, string>): Aliases {
  const configs = new Map<string, Tsconfig>();
  for (const [rel, text] of configTexts) {
    const json = ts.parseConfigFileTextToJson(rel, text).config as Record<string, unknown> | undefined;
    if (json === undefined || json === null || typeof json !== "object") continue;
    const dir = P.dirname(rel) === "." ? "" : P.dirname(rel);
    const ext = json.extends;
    const list = Array.isArray(ext) ? ext : ext ? [ext] : [];
    const extendsFiles = list
      .filter((e): e is string => typeof e === "string" && e.startsWith("."))
      .map((e) => {
        let q = P.normalize(P.join(dir || ".", e));
        if (!q.endsWith(".json")) q += ".json";
        return q;
      });
    const options = (json.compilerOptions ?? {}) as Tsconfig["options"];
    configs.set(rel, { dir, extendsFiles, options });
  }

  const memo = new Map<string, Effective>();
  const effective = (rel: string, seen: Set<string>): Effective => {
    const known = memo.get(rel);
    if (known) return known;
    const none: Effective = { baseUrl: null, paths: null, pathsBase: null };
    const c = configs.get(rel);
    if (c === undefined || seen.has(rel)) return none;
    seen.add(rel);
    let baseUrl = typeof c.options.baseUrl === "string" ? P.normalize(P.join(c.dir || ".", c.options.baseUrl)) : null;
    let paths = c.options.paths && typeof c.options.paths === "object" ? (c.options.paths as Record<string, unknown>) : null;
    let pathsBase = paths ? (baseUrl ?? (c.dir || ".")) : null;
    for (const parent of [...c.extendsFiles].reverse()) {
      const p = effective(parent, seen);
      if (baseUrl === null && p.baseUrl !== null) baseUrl = p.baseUrl;
      if (paths === null && p.paths !== null) {
        paths = p.paths;
        pathsBase = p.pathsBase;
      }
    }
    if (paths !== null && baseUrl !== null) pathsBase = baseUrl;
    const result = { baseUrl, paths, pathsBase };
    memo.set(rel, result);
    return result;
  };

  const aliases: Alias[] = [];
  const baseUrls: BaseUrl[] = [];
  const seen = new Set<string>();
  for (const [rel, c] of configs) {
    const e = effective(rel, new Set());
    const scope = c.dir;
    if (e.baseUrl !== null) {
      const key = scope + "|" + e.baseUrl;
      if (!seen.has(key)) {
        seen.add(key);
        baseUrls.push({ scope, base: e.baseUrl });
      }
    }
    if (e.paths !== null && e.pathsBase !== null) {
      for (const [key, value] of Object.entries(e.paths)) {
        if (!Array.isArray(value)) continue;
        const targets = value.filter((v): v is string => typeof v === "string").map((v) => P.normalize(P.join(e.pathsBase!, v)));
        const id = scope + "|" + key + "|" + targets.join(",");
        if (seen.has(id)) continue;
        seen.add(id);
        aliases.push({ scope, key, targets });
      }
    }
  }
  const depth = (s: string) => (s ? s.split("/").length : 0);
  aliases.sort((a, b) => depth(b.scope) - depth(a.scope));
  baseUrls.sort((a, b) => depth(b.scope) - depth(a.scope));
  return { aliases, baseUrls };
}

/** Workspace packages, longest name first so "@x/a-b" wins over "@x/a". */
export function parsePackages(packageTexts: Map<string, string>): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const [rel, text] of packageTexts) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (json === null || typeof json.name !== "string" || json.name === "") continue;
    const dir = P.dirname(rel) === "." ? "" : P.dirname(rel);
    const join = (x: string) => P.normalize(dir ? P.join(dir, x) : x);
    const entries: string[] = [];
    const fromField = (v: unknown) => {
      if (typeof v !== "string") return;
      const x = v
        .replace(/^\.\//, "")
        .replace(/\.d\.ts$/, "")
        .replace(/\.(m|c)?js$/, "")
        .replace(/\.tsx?$/, "");
      // Built output usually mirrors src/: point back at the source.
      const alt = x.replace(/^(dist|lib|build|out|esm|cjs|types)(\/(esm|cjs|types))?\//, "src/");
      entries.push(join(alt));
      if (alt !== x) entries.push(join(x));
    };
    for (const k of ["source", "types", "typings", "module", "main"]) fromField(json[k]);
    const exp = json.exports;
    const dot = typeof exp === "string" ? exp : exp && typeof exp === "object" ? (exp as Record<string, unknown>)["."] : null;
    if (typeof dot === "string") fromField(dot);
    else if (dot && typeof dot === "object") {
      for (const k of ["types", "import", "default", "require"]) {
        const v = (dot as Record<string, unknown>)[k];
        if (typeof v === "string") fromField(v);
        else if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          fromField(o.default ?? o.types);
        }
      }
    }
    entries.push(join("src/index"), join("index"), join("src/main"), join("src"));
    out.push({ name: json.name, dir, entries: [...new Set(entries)] });
  }
  out.sort((a, b) => b.name.length - a.name.length);
  return out;
}

const inScope = (scope: string, file: string) => scope === "" || file === scope || file.startsWith(scope + "/");
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"];

export function makeResolver(files: Set<string>, config: Aliases, packages: WorkspacePackage[]): Resolver {
  const tryFile = (p0: string, bases: string[]): string | null => {
    const p = P.normalize(p0).replace(/\/+$/, "") || ".";
    if (p === ".." || p.startsWith("../")) return null;
    const candidates = [p];
    if (/\.(js|jsx|mjs|cjs)$/.test(p)) candidates.push(p.replace(/\.(js|jsx|mjs|cjs)$/, ""));
    for (const c of candidates) {
      bases.push(c);
      for (const x of EXTENSIONS) {
        const f = c === "." ? (x.startsWith("/") ? x.slice(1) : null) : c + x;
        if (f !== null && files.has(f)) return f;
      }
    }
    return null;
  };

  return (spec, fromFile) => {
    const bases: string[] = [];
    if (spec.startsWith(".")) return { target: tryFile(P.join(P.dirname(fromFile), spec), bases), bases };
    for (const a of config.aliases) {
      if (!inScope(a.scope, fromFile)) continue;
      if (a.key.endsWith("*")) {
        const prefix = a.key.slice(0, -1);
        if (!spec.startsWith(prefix)) continue;
        const rest = spec.slice(prefix.length);
        for (const t of a.targets) {
          const r = tryFile(t.replace("*", rest), bases);
          if (r) return { target: r, bases };
        }
      } else if (spec === a.key) {
        for (const t of a.targets) {
          const r = tryFile(t, bases);
          if (r) return { target: r, bases };
        }
      }
    }
    for (const pk of packages) {
      if (spec === pk.name) {
        for (const e of pk.entries) {
          const r = tryFile(e, bases);
          if (r) return { target: r, bases };
        }
        break;
      }
      if (spec.startsWith(pk.name + "/")) {
        const sub = spec.slice(pk.name.length + 1).replace(/^(dist|lib|build|esm|cjs)\//, "");
        for (const root of [pk.dir ? P.join(pk.dir, "src") : "src", pk.dir || "."]) {
          const r = tryFile(root === "." ? sub : P.join(root, sub), bases);
          if (r) return { target: r, bases };
        }
        break;
      }
    }
    for (const b of config.baseUrls) {
      if (!inScope(b.scope, fromFile)) continue;
      const r = tryFile(P.join(b.base, spec), bases);
      if (r) return { target: r, bases };
    }
    return { target: null, bases };
  };
}

/** Paths under which a newly added file could satisfy an import that failed before. */
export function keysFor(file: string): string[] {
  const keys = new Set([file]);
  const bare = file.replace(/\.(ts|tsx|mts|cts)$/, "");
  keys.add(bare);
  for (const ext of [".js", ".jsx", ".mjs"]) keys.add(bare + ext);
  if (/\/index\.(ts|tsx)$/.test(file)) keys.add(P.dirname(file));
  if (/^index\.(ts|tsx)$/.test(file)) keys.add(".");
  return [...keys];
}
