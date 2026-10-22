import * as path from "node:path";
import { deleteDecision, readDecisions, saveDecision } from "./decisions.js";
import {
  classify,
  commitDate,
  countCommits,
  currentBranch,
  git,
  gitBuffer,
  mergeBase,
  resolveCommit,
  userName,
} from "./git.js";
import { buildMatrix } from "./matrix.js";
import { edgeKey, monthOf, replay, snapshotAt, windowStart, type ReplayResult } from "./replay.js";
import { DEFAULT_MIN_GAP, findUphillLinks } from "./review-core.js";
import type { Birth, Decision, DecisionRecord, HistoryData, ReviewResult } from "./types.js";

/**
 * Review one change: the checked-out branch (or `head`) against the branch
 * it goes into, the way a pull request compares them.
 *
 * One replay covers everything: the history window (the stability race),
 * the graph at the merge base and at the head (the review and the ladder),
 * and the head for the whole-codebase matrix. Git is only read.
 */

export interface ReviewOptions {
  /** Repository root on disk. */
  repo: string;
  /** Branch, tag or commit the change goes into, e.g. "main". */
  base: string;
  /** The change's last commit; defaults to HEAD, the checked-out branch. */
  head?: string;
  /** YAML file for decisions; defaults to architecture.yaml in the repo. */
  decisionsFile?: string;
  /** Smallest instability gap to flag; defaults to 0.2. */
  minGap?: number;
  /** Months of history for the stability race; defaults to 12. */
  months?: number;
}

/** Births smaller than this are left out of the history (noise near equal instability). */
const MIN_BIRTH_GAP = 0.05;

export function reviewChange(options: ReviewOptions): ReviewResult {
  const repo = path.resolve(options.repo);
  const headRef = options.head ?? "HEAD";
  const headCommit = resolveCommit(repo, headRef);
  const baseTip = resolveCommit(repo, options.base);
  // Like a pull request: compare with where the branch left the base, so
  // work merged into the base since then is not counted as this change.
  const baseCommit = mergeBase(repo, baseTip, headCommit) ?? baseTip;
  const decisionsFile = path.resolve(options.decisionsFile ?? path.join(repo, "architecture.yaml"));
  const minGap = options.minGap ?? DEFAULT_MIN_GAP;
  const headMonth = monthOf(commitDate(repo, headCommit));

  const run = replay({
    repo,
    head: headCommit,
    sinceMonth: windowStart(headMonth, options.months ?? 12),
    headMonth,
    capture: [baseCommit],
  });
  // The merge base is on the replayed path unless it is older than the
  // window or came in through a merge; then it is parsed on its own.
  const base = run.captured.get(baseCommit) ?? snapshotAt(repo, baseCommit);
  const head = run.end;
  const decisions = readDecisions(decisionsFile);

  const texts = new Map<string, string | null>();
  const headText = (file: string): string | null => {
    if (!texts.has(file)) texts.set(file, readFileAt(repo, headCommit, file));
    return texts.get(file) ?? null;
  };
  const core = findUphillLinks({
    base,
    head,
    headText,
    commitOf: (e) => {
      const i = run.edgeCommit.get(edgeKey(e.from, e.to));
      return i === undefined || i < 0 ? null : run.commits[i];
    },
    decisions,
    minGap,
  });

  const range = `${baseCommit}..${headCommit}`;
  const changeCommits = countCommits(repo, range);
  return {
    root: toPosix(repo),
    base: { ref: options.base, commit: baseCommit.slice(0, 10) },
    head: {
      ref: headRef === "HEAD" ? (currentBranch(repo) ?? "HEAD") : headRef,
      commit: headCommit.slice(0, 10),
    },
    decisionsFile: toPosix(decisionsFile),
    minGap,
    links: core.links,
    matrix: buildMatrix(head, base, core.links, decisions, minGap),
    history: history(run),
    stats: {
      commits: changeCommits,
      agentCommits: changeCommits === 0 ? 0 : agentCommits(repo, range),
      files: head.files.length,
      newImports: core.newImports,
      flagged: core.links.length,
      sideways: core.links.filter((l) => l.kind === "sideways").length,
      intoSubfolder: core.links.filter((l) => l.kind === "into-subfolder").length,
      decided: core.links.filter((l) => l.decision !== null && !l.grew).length,
      quiet: core.quiet,
    },
  };
}

export interface DecisionInput {
  from: string;
  to: string;
  decision: Decision;
  note?: string;
  /** Which change it was decided on, e.g. "main..ai/discount-banner". */
  change: string;
  /** File imports on the link now. */
  imports: number;
}

/**
 * Record what the author decided. `by` is the repository's git user.name
 * and `date` is today, so the YAML shows who judged a link and when.
 */
export function recordDecision(repo: string, decisionsFile: string, input: DecisionInput): DecisionRecord[] {
  return saveDecision(decisionsFile, {
    from: input.from,
    to: input.to,
    decision: input.decision,
    note: input.note ?? "",
    by: userName(repo),
    date: today(),
    change: input.change,
    imports: input.imports,
  });
}

export function removeDecision(decisionsFile: string, from: string, to: string): DecisionRecord[] {
  return deleteDecision(decisionsFile, from, to);
}

// ---------------------------------------------------------------------------

function history(run: ReplayResult): HistoryData {
  const instability: Record<string, (number | null)[]> = {};
  for (const [folder, series] of run.instability) instability[folder] = series;
  const links: Record<string, number[]> = {};
  for (const [key, series] of run.linkCounts) links[key.replace("\0", " -> ")] = series;
  const births: Birth[] = run.births
    .filter((b) => b.gap >= MIN_BIRTH_GAP || b.cause === "new import")
    .map((b) => ({
      from: b.from,
      to: b.to,
      month: monthOf(run.commits[b.commit].date),
      cause: b.cause,
      gap: b.gap,
      imports: b.imports,
      commit: run.commits[b.commit],
    }));
  return {
    months: run.months,
    instability,
    links,
    births,
    commits: run.commits.length,
    agentCommits: run.commits.filter((c) => c.cls === "agent").length,
  };
}

function agentCommits(repo: string, range: string): number {
  const RS = "\x1e";
  const US = "\x1f";
  const out = git(repo, ["log", `--format=${RS}%an${US}%B`, range]);
  let n = 0;
  for (const record of out.split(RS)) {
    if (!record.trim()) continue;
    const [author, body] = record.split(US);
    if (classify(author, body ?? "").cls === "agent") n++;
  }
  return n;
}

function readFileAt(repo: string, commit: string, file: string): string | null {
  try {
    return gitBuffer(repo, ["cat-file", "blob", `${commit}:${file}`]).toString("utf8");
  } catch {
    return null;
  }
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}
