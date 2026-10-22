import { execFileSync } from "node:child_process";
import * as os from "node:os";
import type { AuthorClass, CommitRef } from "./types.js";

/**
 * Git, read only. Every call reads objects or history; nothing writes to the
 * repository, its index or its working tree.
 */

export function gitBuffer(repo: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, {
    cwd: repo,
    input,
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export function git(repo: string, args: string[]): string {
  return gitBuffer(repo, args).toString("utf8");
}

export function resolveCommit(repo: string, ref: string): string {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`"${ref}" is not a branch, tag or commit in ${repo}`);
  }
}

export function mergeBase(repo: string, a: string, b: string): string | null {
  try {
    return git(repo, ["merge-base", a, b]).trim() || null;
  } catch {
    return null;
  }
}

export function currentBranch(repo: string): string | null {
  try {
    const name = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    return name === "HEAD" ? null : name;
  } catch {
    return null;
  }
}

export function userName(repo: string): string {
  try {
    const name = git(repo, ["config", "user.name"]).trim();
    if (name !== "") return name;
  } catch {
    // no user.name configured
  }
  return os.userInfo().username;
}

/** Committer date of a commit, ISO 8601. */
export function commitDate(repo: string, commit: string): string {
  return git(repo, ["show", "-s", "--format=%cI", commit]).trim();
}

export function countCommits(repo: string, range: string): number {
  return Number(git(repo, ["rev-list", "--count", range]).trim());
}

/** Contents of many blobs in one `git cat-file --batch`; null for a missing object. */
export function readBlobs(repo: string, names: string[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (let s = 0; s < names.length; s += 4000) {
    const part = names.slice(s, s + 4000);
    const out = gitBuffer(repo, ["cat-file", "--batch"], part.join("\n") + "\n");
    let pos = 0;
    for (const name of part) {
      const lineEnd = out.indexOf(10, pos);
      const header = out.subarray(pos, lineEnd).toString("utf8");
      pos = lineEnd + 1;
      if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
        result.set(name, null);
        continue;
      }
      const size = Number(header.split(" ")[2]);
      result.set(name, out.subarray(pos, pos + size).toString("utf8"));
      pos += size + 1;
    }
  }
  return result;
}

export interface TreeEntry {
  path: string;
  oid: string;
}

/** Every blob in a commit's tree (symlinks and submodules left out). */
export function listTree(repo: string, commit: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const entry of git(repo, ["ls-tree", "-r", "-z", commit]).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || mode === "120000") continue;
    out.push({ path: entry.slice(tab + 1), oid });
  }
  return out;
}

export interface FileChange {
  /** A, M, D, R (rename) or C (copy), T (type change). */
  status: string;
  from: string;
  to: string;
  /** Blob id after the change (all zeros for a deletion). */
  oid: string;
}

export interface LoggedCommit {
  sha: string;
  parent: string | null;
  author: string;
  date: string;
  body: string;
  changes: FileChange[];
}

const RS = "\x1e";
const US = "\x1f";

/**
 * First-parent history of `head` since a date, oldest first, with the files
 * each commit changed against its first parent. First parent only: on a
 * branch that means the branch's own commits, and a merge counts as one
 * change, like a pull request.
 */
export function logFirstParent(repo: string, head: string, since: string): LoggedCommit[] {
  const raw = git(repo, [
    "log",
    "--first-parent",
    "--reverse",
    `--since=${since}`,
    "-M",
    "--raw",
    "-z",
    "--no-abbrev",
    `--format=${RS}%H${US}%P${US}%an${US}%cI${US}%B${US}`,
    head,
  ]);
  const commits: LoggedCommit[] = [];
  for (const record of raw.split(RS)) {
    if (!record.trim()) continue;
    const parts = record.split(US);
    if (parts.length < 6) continue;
    const [sha, parents, author, date, body] = parts;
    const tokens = parts.slice(5).join(US).split("\0");
    const changes: FileChange[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].replace(/^\n+/, "");
      if (!t.startsWith(":")) continue;
      const fields = t.slice(1).split(" ");
      const status = fields[4] ? fields[4][0] : "M";
      const oid = fields[3];
      if (status === "R" || status === "C") {
        changes.push({ status, from: tokens[i + 1], to: tokens[i + 2], oid });
        i += 2;
      } else {
        changes.push({ status, from: tokens[i + 1], to: tokens[i + 1], oid });
        i += 1;
      }
    }
    commits.push({ sha, parent: parents.split(" ")[0] || null, author, date, body, changes });
  }
  return commits;
}

/** A logged commit as the views show it. */
export function commitRef(c: LoggedCommit): CommitRef {
  const { cls, tools } = classify(c.author, c.body);
  return {
    sha: c.sha.slice(0, 10),
    date: c.date.slice(0, 10),
    subject: c.body.split("\n")[0].slice(0, 120),
    author: c.author,
    cls,
    tools,
  };
}

/**
 * Agent-assisted, human or bot, from the author name and the trailers, the
 * same rules as in the study. Agent-assisted means a coding agent is named
 * as co-author or author (Claude Code, Copilot, Cursor, Codex and others).
 */
export function classify(author: string, body: string): { cls: AuthorClass; tools: string[] } {
  const toolOf = (s: string): string | null =>
    /claude|anthropic/i.test(s)
      ? "claude"
      : /copilot/i.test(s)
        ? "copilot"
        : /codegen/i.test(s)
          ? "codegen"
          : /cursor/i.test(s)
            ? "cursor"
            : /(aider|codex|devin|jules|openai|gemini|amazon q|kiro|windsurf|cline)/i.test(s)
              ? "other-agent"
              : null;
  const tools = new Set<string>();
  for (const m of body.matchAll(/^co-authored-by:\s*(.+)$/gim)) {
    const tool = toolOf(m[1]);
    if (tool) tools.add(tool);
  }
  if (/Generated with \[Claude Code\]/i.test(body)) tools.add("claude");
  if (/^(Copilot|copilot-swe-agent(\[bot\])?|codegen-sh\[bot\]|Claude|devin-ai-integration\[bot\]|cursor\[bot\]|google-labs-jules\[bot\])$/i.test(author)) {
    tools.add(toolOf(author) ?? "other-agent");
  }
  if (tools.size > 0) return { cls: "agent", tools: [...tools] };
  if (/\[bot\]|dependabot|renovate|github-actions|translat|crowdin|l10n|localization|release-bot/i.test(author)) {
    return { cls: "bot", tools: [] };
  }
  return { cls: "human", tools: [] };
}
