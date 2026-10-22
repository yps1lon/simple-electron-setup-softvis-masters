import * as fs from "node:fs";
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import type { Decision, DecisionRecord } from "./types.js";

/**
 * The intended architecture as an output: a YAML file of decisions, one per
 * uphill folder link that an author judged. There is no spec to write up
 * front. An entry exists only because a person looked at a link and chose;
 * nothing here is derived from the code.
 *
 * The file is edited as a YAML document, not re-serialised from scratch, so
 * comments and ordering added by hand survive.
 */

const KEY = "decisions";

const NEW_FILE = [
  "# Intended architecture, recorded one decision at a time.",
  "#",
  "# Each entry is a folder link that turned uphill in a change (a folder that",
  "# much of the code relies on started to import a less stable folder) and",
  "# what the author of the change decided: meant, move or flip.",
  "# `imports` is how many file imports the link had then; a link marked",
  "# meant is flagged again only when it grows past that.",
  "",
].join("\n");

const DECISIONS: readonly Decision[] = ["meant", "move", "flip"];

export function readDecisions(file: string): DecisionRecord[] {
  if (!fs.existsSync(file)) return [];
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  if (doc.errors.length > 0) {
    throw new Error(`${file}: ${doc.errors[0].message}`);
  }
  const raw: unknown = doc.toJS();
  if (raw === null || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>)[KEY];
  if (!Array.isArray(list)) return [];
  const records: DecisionRecord[] = [];
  for (const item of list) {
    const record = toRecord(item);
    if (record !== null) records.push(record);
  }
  return records;
}

/** Add or replace the decision for one folder pair; returns all decisions. */
export function saveDecision(file: string, record: DecisionRecord): DecisionRecord[] {
  return editDecisions(file, (seq, add) => {
    removePair(seq, record.from, record.to);
    const entry: Record<string, string | number> = {
      from: record.from,
      to: record.to,
      decision: record.decision,
    };
    if (record.note.trim() !== "") entry.note = record.note.trim();
    entry.by = record.by;
    entry.date = record.date;
    entry.change = record.change;
    entry.imports = record.imports;
    add(entry);
  });
}

/** Remove the decision for one folder pair (undo); returns all decisions. */
export function deleteDecision(file: string, from: string, to: string): DecisionRecord[] {
  if (!fs.existsSync(file)) return [];
  return editDecisions(file, (seq) => removePair(seq, from, to));
}

function editDecisions(
  file: string,
  change: (seq: YAMLSeq, add: (entry: Record<string, string | number>) => void) => void,
): DecisionRecord[] {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : NEW_FILE;
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`${file}: ${doc.errors[0].message}`);
  }
  let seq: unknown = doc.get(KEY, true);
  if (!isSeq(seq)) {
    seq = new YAMLSeq(doc.schema);
    doc.set(KEY, seq);
  }
  const list = seq as YAMLSeq;
  change(list, (entry) => list.items.push(doc.createNode(entry)));
  fs.writeFileSync(file, doc.toString(), "utf8");
  return readDecisions(file);
}

function removePair(seq: YAMLSeq, from: string, to: string): void {
  seq.items = seq.items.filter(
    (item) => !(isMap(item) && item.get("from") === from && item.get("to") === to),
  );
}

function toRecord(item: unknown): DecisionRecord | null {
  if (item === null || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const text = (key: string): string => {
    const v = o[key];
    return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  };
  const decision = text("decision") as Decision;
  if (text("from") === "" || text("to") === "" || !DECISIONS.includes(decision)) return null;
  return {
    from: text("from"),
    to: text("to"),
    decision,
    note: text("note"),
    by: text("by"),
    date: text("date"),
    change: text("change"),
    imports: typeof o.imports === "number" ? o.imports : 0,
  };
}
