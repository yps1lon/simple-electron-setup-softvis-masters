// Engine tests, on a fresh demo repository.
// Run with: npm test   (builds the engine first)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readDecisions, recordDecision, removeDecision, reviewChange } from "../src/engine/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uphill-test-"));
const repo = path.join(tmp, "demo-shop");
execFileSync(process.execPath, [path.join(here, "..", "demo", "make-demo-repo.mjs"), repo], { stdio: "ignore" });
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], {
    cwd: repo,
  }).toString();
const decisionsFile = path.join(tmp, "architecture.yaml");
const change = "main..ai/discount-banner";
const review = () => reviewChange({ repo, base: "main", decisionsFile });

test("finds the three uphill imports the pull request adds, with the commits that added them", () => {
  const r = review();
  assert.equal(r.stats.commits, 2);
  assert.equal(r.stats.agentCommits, 2);
  assert.equal(r.head.ref, "ai/discount-banner");
  assert.deepEqual(r.links.map((l) => l.id).sort(), [
    "src/core -> src/features/checkout",
    "src/core -> src/features/notifications",
    "src/ui -> src/ui/badge",
  ]);
  const byId = new Map(r.links.map((l) => [l.id, l]));
  assert.equal(byId.get("src/core -> src/features/checkout").clue.kind, "move");
  assert.equal(byId.get("src/core -> src/features/notifications").clue.kind, "flip");
  assert.equal(byId.get("src/ui -> src/ui/badge").clue.kind, "subfolder");
  for (const link of r.links) {
    const added = link.imports.filter((i) => i.isNew);
    assert.ok(added.length > 0, link.id);
    for (const i of added) {
      assert.equal(i.commit?.cls, "agent");
      assert.deepEqual(i.commit?.tools, ["claude"]);
      assert.ok(i.line > 0);
    }
  }
  assert.equal(byId.get("src/ui -> src/ui/badge").imports[0].kind, "re-export");
  // Gap times exposure, largest first.
  assert.equal(r.links[0].id, "src/core -> src/features/notifications");
  // The piece is small: two files and a folder map.
  assert.ok(byId.get("src/core -> src/features/checkout").piece.tokens < 2000);
});

test("resolves tsconfig path aliases", () => {
  // cart.ts imports "~/core/money"; without the alias this link would be missing.
  const r = review();
  const full = r.matrix.levels.at(-1);
  const index = new Map(full.folders.map((f, i) => [f.name, i]));
  const cell = full.cells.find((c) => c[0] === index.get("src/features/cart") && c[1] === index.get("src/core"));
  assert.ok(cell !== undefined && cell[2] >= 2);
});

test("history: the older uphill links, and how each was born", () => {
  const r = review();
  assert.equal(r.history.months[0], "2025-11");
  assert.equal(r.history.months.at(-1), "2026-09");
  assert.equal(r.history.commits, 12);
  const birth = (from, to) => r.history.births.find((b) => b.from === from && b.to === to);
  assert.equal(birth("src/core", "src/data")?.cause, "new import");
  assert.equal(birth("src/core", "src/data")?.commit.cls, "human");
  assert.equal(birth("src/core", "src/data")?.month, "2026-04");
  assert.equal(birth("src/core", "src/config")?.cause, "drift");
  assert.equal(birth("src/core", "src/config")?.month, "2026-06");
  assert.equal(birth("src/core", "src/features/notifications")?.commit.cls, "agent");
  assert.equal(r.history.instability["src/core"].length, r.history.months.length);
  assert.equal(r.history.links["src/core -> src/data"].at(-1), 1);
});

test("matrix: every uphill link lies above the diagonal; the flagged ones are marked", () => {
  const r = review();
  for (const level of r.matrix.levels) {
    for (const [row, col] of level.cells) {
      const gap = level.folders[col].instability - level.folders[row].instability;
      if (gap > 1e-9) assert.ok(col > row, `uphill cell below the diagonal at depth ${level.depth}`);
    }
  }
  const full = r.matrix.levels.at(-1);
  assert.equal(full.depth, null);
  assert.equal(full.cells.filter((c) => c[3] & 2).length, 3);
  // Merging folders hides uphill links.
  assert.ok(r.matrix.levels[0].uphill < full.uphill);
});

test("reads git only: the demo repository is left as it was", () => {
  const before = git("rev-parse", "HEAD") + git("status", "--porcelain");
  review();
  assert.equal(git("rev-parse", "HEAD") + git("status", "--porcelain"), before);
});

test("decisions are the output: a YAML of decisions, and nothing else", () => {
  recordDecision(repo, decisionsFile, { from: "src/ui", to: "src/ui/badge", decision: "meant", note: "", change, imports: 1 });
  recordDecision(repo, decisionsFile, { from: "src/core", to: "src/features/notifications", decision: "flip", note: "event bus", change, imports: 1 });
  const text = fs.readFileSync(decisionsFile, "utf8");
  assert.match(text, /^# Intended architecture/);
  assert.doesNotMatch(text, /modules|allowed/);
  assert.equal(readDecisions(decisionsFile).length, 2);
  // Comments written by hand survive the next edit.
  fs.writeFileSync(decisionsFile, text.replace("decisions:", "# kept by hand\ndecisions:"));
  removeDecision(decisionsFile, "src/core", "src/features/notifications");
  assert.match(fs.readFileSync(decisionsFile, "utf8"), /# kept by hand/);
  const r = review();
  // "meant" and unchanged: quiet. A planned fix stays listed as decided.
  assert.ok(!r.links.some((l) => l.id === "src/ui -> src/ui/badge"));
  assert.equal(r.stats.quiet, 1);
  removeDecision(decisionsFile, "src/ui", "src/ui/badge");
  assert.equal(readDecisions(decisionsFile).length, 0);
});

test("a link marked meant is asked again when it grows", () => {
  recordDecision(repo, decisionsFile, { from: "src/core", to: "src/features/checkout", decision: "meant", note: "", change, imports: 1 });
  assert.ok(!review().links.some((l) => l.id === "src/core -> src/features/checkout"));
  fs.writeFileSync(
    path.join(repo, "src", "core", "tax.ts"),
    'import { roundToCents } from "../features/checkout/rounding";\n\nexport const vat = (x: number) => roundToCents(x * 0.25);\n',
  );
  git("add", "-A");
  git("commit", "-q", "-m", "Add VAT");
  const grown = review().links.find((l) => l.id === "src/core -> src/features/checkout");
  assert.ok(grown?.grew);
  assert.equal(grown.decision?.decision, "meant");
  git("reset", "-q", "--hard", "HEAD~1");
  removeDecision(decisionsFile, "src/core", "src/features/checkout");
});

test("an entry file such as index.ts is not suggested to move", () => {
  // core starts importing a folder through its index.ts, which only re-exports.
  const promo = path.join(repo, "src", "features", "promo");
  fs.mkdirSync(promo, { recursive: true });
  fs.writeFileSync(path.join(promo, "promo.ts"), 'import { listProducts } from "~/data/products";\n\nexport const promoCount = async () => (await listProducts()).length;\n');
  fs.writeFileSync(path.join(promo, "index.ts"), 'export { promoCount } from "./promo";\n');
  fs.writeFileSync(
    path.join(repo, "src", "core", "promoHook.ts"),
    'import { promoCount } from "../features/promo";\n\nexport const hasPromos = async () => (await promoCount()) > 0;\n',
  );
  git("add", "-A");
  git("commit", "-q", "-m", "Add promos");
  const link = review().links.find((l) => l.id === "src/core -> src/features/promo");
  assert.ok(link, "the link through index.ts is flagged");
  assert.equal(link.lens.length, 1);
  assert.equal(link.lens[0].file, "src/features/promo/index.ts");
  assert.equal(link.lens[0].reexports, 1);
  assert.equal(link.clue.kind, "flip");
  assert.match(link.clue.reason, /entry file/);
  git("reset", "-q", "--hard", "HEAD~1");
});

test("the decision's author is the repository's git user.name", () => {
  git("config", "user.name", "Ada Developer");
  const saved = recordDecision(repo, decisionsFile, { from: "src/ui", to: "src/ui/badge", decision: "meant", note: "", change, imports: 1 });
  assert.equal(saved[0].by, "Ada Developer");
  removeDecision(decisionsFile, "src/ui", "src/ui/badge");
});

test("the link disappears once the move is done", () => {
  git("mv", "src/features/checkout/rounding.ts", "src/core/rounding.ts");
  const money = path.join(repo, "src", "core", "money.ts");
  fs.writeFileSync(money, fs.readFileSync(money, "utf8").replace("../features/checkout/rounding", "./rounding"));
  git("commit", "-q", "-am", "Move rounding into core");
  const r = review();
  assert.ok(!r.links.some((l) => l.id === "src/core -> src/features/checkout"));
  assert.equal(r.links.length, 2);
  git("reset", "-q", "--hard", "HEAD~1");
});

test("says so when there is nothing to review, and still shows the codebase", () => {
  git("checkout", "-q", "main");
  const r = review();
  assert.equal(r.stats.commits, 0);
  assert.equal(r.links.length, 0);
  assert.ok(r.matrix.levels.at(-1).folders.length > 5);
  assert.ok(r.history.months.length > 5);
  git("checkout", "-q", "ai/discount-banner");
});

test("names a base that does not exist", () => {
  assert.throws(() => reviewChange({ repo, base: "no-such-branch", decisionsFile }), /not a branch, tag or commit/);
});
