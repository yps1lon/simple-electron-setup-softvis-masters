import { ts } from "ts-morph";
import type { ImportKind } from "./types.js";

/**
 * Which files count, and the imports of one file with their kind.
 *
 * Ported from the replay scripts of the ten-codebase study, so the tool and
 * the study see the same graph. Only the TypeScript compiler's parser is
 * used (no type checker, no program): one file at a time, fast enough to
 * replay a year of history.
 */

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", "out", ".next", "lib-cov"]);

function inSourceDir(rel: string): boolean {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (SKIP_DIRS.has(parts[i]) || parts[i].startsWith(".")) return false;
  }
  return true;
}

/** TypeScript source (not declaration files), outside build and hidden folders. */
export function isTsSource(rel: string): boolean {
  return /\.(ts|tsx|mts|cts)$/.test(rel) && !/\.d\.ts$/.test(rel) && inSourceDir(rel);
}

export function isTsconfig(rel: string): boolean {
  return /(^|\/)tsconfig[^/]*\.json$/.test(rel) && inSourceDir(rel);
}

export function isPackageJson(rel: string): boolean {
  return (
    /(^|\/)package\.json$/.test(rel) &&
    !/(^|\/)(node_modules|dist|build|out|coverage|fixtures|test|tests|__tests__|e2e)\//.test(rel) &&
    !/(^|\/)\./.test(rel)
  );
}

const TEST_FILE = /\.(test|spec|stories|story|bench)\.(tsx?|mts|cts)$/;
const TEST_DIR =
  /(^|\/)(test|tests|__tests__|__mocks__|__fixtures__|fixtures|e2e|cypress|mocks|testing|test-utils|testUtils|__snapshots__|storybook|stories|benchmarks?|playwright-report)\//;
const GENERATED_DIR = /(^|\/)(vendor|third_party|generated|__generated__)\//;

/**
 * Architecture files: TypeScript sources that are not tests, stories,
 * fixtures or generated code. Tests import many folders and would make
 * every folder they touch look more stable than the product code makes it.
 */
export function isArchitectureFile(rel: string): boolean {
  return isTsSource(rel) && !TEST_FILE.test(rel) && !TEST_DIR.test(rel) && !GENERATED_DIR.test(rel);
}

export interface RawImport {
  /** The module specifier as written, e.g. "../core/money" or "@app/ui". */
  spec: string;
  kind: ImportKind;
  /** 1-based line of the statement. */
  line: number;
}

/** When one file imports another in several ways, the strongest kind wins. */
export const KIND_RANK: Record<ImportKind, number> = {
  "type-only": 0,
  deferred: 1,
  "re-export": 2,
  "load-time": 3,
};

/**
 * The imports of one file. Returns null when the file cannot be parsed.
 *
 * Kinds: `import type` is type-only; a value import is type-only when its
 * names are only used as types, deferred when they are only used inside
 * functions, and load-time when used at the top level. Side-effect imports
 * and `require` at the top level are load-time; `import()` is deferred.
 */
export function analyzeFile(text: string, rel: string): RawImport[] | null {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(
      rel,
      text,
      ts.ScriptTarget.Latest,
      true,
      /x$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  } catch {
    return null;
  }
  const out: RawImport[] = [];
  // Value imports whose kind depends on how their names are used.
  const pending: { rec: RawImport; locals: string[] }[] = [];
  const bindings = new Map<string, number>();
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (clause === undefined) {
        out.push({ spec, kind: "load-time", line: lineOf(st) });
        continue;
      }
      if (clause.isTypeOnly) {
        out.push({ spec, kind: "type-only", line: lineOf(st) });
        continue;
      }
      const locals: string[] = [];
      if (clause.name) locals.push(clause.name.text);
      const named = clause.namedBindings;
      if (named) {
        if (ts.isNamespaceImport(named)) locals.push(named.name.text);
        else for (const el of named.elements) if (!el.isTypeOnly) locals.push(el.name.text);
      }
      const rec: RawImport = { spec, kind: "type-only", line: lineOf(st) };
      out.push(rec);
      pending.push({ rec, locals });
      for (const name of locals) bindings.set(name, pending.length - 1);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      out.push({ spec: st.moduleSpecifier.text, kind: st.isTypeOnly ? "type-only" : "re-export", line: lineOf(st) });
    } else if (
      ts.isImportEqualsDeclaration(st) &&
      ts.isExternalModuleReference(st.moduleReference) &&
      ts.isStringLiteral(st.moduleReference.expression)
    ) {
      out.push({ spec: st.moduleReference.expression.text, kind: st.isTypeOnly ? "type-only" : "load-time", line: lineOf(st) });
    }
  }

  // How each imported name is used: the strongest use wins.
  const usage = new Map<string, "deferred" | "load-time">();
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n) && bindings.has(n.text) && !isPropertyName(n) && !inTypePosition(n)) {
      const use = isDeferred(n) ? "deferred" : "load-time";
      if (usage.get(n.text) !== "load-time") usage.set(n.text, use);
    }
    if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0])) {
      const spec = n.arguments[0].text;
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        out.push({ spec, kind: "deferred", line: lineOf(n) });
      } else if (ts.isIdentifier(n.expression) && n.expression.text === "require") {
        out.push({ spec, kind: isDeferred(n) ? "deferred" : "load-time", line: lineOf(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  for (const { rec, locals } of pending) {
    let kind: ImportKind = "type-only";
    for (const name of locals) {
      const use = usage.get(name);
      if (use === "load-time") {
        kind = "load-time";
        break;
      }
      if (use === "deferred") kind = "deferred";
    }
    rec.kind = kind;
  }
  return out;
}

function isPropertyName(n: ts.Identifier): boolean {
  const p = n.parent;
  return (
    p !== undefined &&
    ((ts.isPropertyAccessExpression(p) && p.name === n) ||
      (ts.isPropertyAssignment(p) && p.name === n) ||
      (ts.isMethodDeclaration(p) && p.name === n) ||
      (ts.isPropertyDeclaration(p) && p.name === n) ||
      (ts.isJsxAttribute(p) && p.name === n))
  );
}

function inTypePosition(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
    if (ts.isHeritageClause(p)) {
      return p.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(p.parent);
    }
    if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
    if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

/** Used only when a function runs (or in a non-static class field). */
function isDeferred(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (isFunctionLike(p)) return true;
    if (ts.isPropertyDeclaration(p) && !(p.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
      return true;
    }
    if (ts.isSourceFile(p)) return false;
  }
  return false;
}
