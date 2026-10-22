// Small DOM and SVG helpers shared by the views. Plain DOM, no d3: the
// drawings are small and static, and the views can be tested in a browser
// without the bundle.

const SVG_NS = "http://www.w3.org/2000/svg";

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function svgText(text, attrs) {
  const node = svgEl("text", attrs);
  node.textContent = text;
  return node;
}

// One tooltip for the whole app, placed next to the pointer.
export function hover(target, text) {
  const tip = document.getElementById("tip");
  const move = (event) => {
    const pad = 14;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const x = event.clientX + pad + w > window.innerWidth ? event.clientX - pad - w : event.clientX + pad;
    const y = event.clientY + pad + h > window.innerHeight ? event.clientY - pad - h : event.clientY + pad;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  };
  target.addEventListener("mouseenter", (event) => {
    tip.textContent = text();
    tip.hidden = false;
    move(event);
  });
  target.addEventListener("mousemove", move);
  target.addEventListener("mouseleave", () => {
    tip.hidden = true;
  });
}

export function hideTip() {
  document.getElementById("tip").hidden = true;
}

/** Last two path segments, the whole path when it is short. */
export function shortName(folder) {
  const parts = folder.split("/");
  return parts.length <= 2 ? folder : parts.slice(-2).join("/");
}

export function tailName(folder, n) {
  return folder.split("/").slice(-n).join("/");
}

export function clip(text, max) {
  return text.length <= max ? text : "…" + text.slice(text.length - max + 1);
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function baseName(file) {
  return file.split("/").pop();
}

export function decisionLabel(decision) {
  return decision === "meant" ? "meant" : decision === "move" ? "fix: move" : "fix: flip";
}

/** "agent-assisted" or "human" (or "bot"), for commits. */
export function authorLabel(commit) {
  if (commit === null || commit === undefined) return "";
  return commit.cls === "agent" ? `agent-assisted (${commit.tools.join(", ")})` : commit.cls;
}

export function commitLine(commit) {
  if (commit === null || commit === undefined) return "before the history window";
  return `${commit.date} ${commit.sha} "${commit.subject}", ${authorLabel(commit)}`;
}

/** A button-like span that opens a file in the editor. */
export function fileLink(root, relPath, line, onOpen) {
  const span = el("span", "file-link", line ? `${relPath}:${line}` : relPath);
  span.title = "Open in editor";
  span.tabIndex = 0;
  const open = () => onOpen(`${root}/${relPath}`);
  span.addEventListener("click", open);
  span.addEventListener("keydown", (e) => {
    if (e.key === "Enter") open();
  });
  return span;
}

/** Swatch plus text, for legends (identity is never colour alone). */
export function legendItem(kind, text) {
  const item = el("span", "legend-item");
  item.append(el("i", `sw ${kind}`), document.createTextNode(text));
  return item;
}

/** A row of toggle buttons; calls pick(value) on click. */
export function segmented(options, value, pick, label) {
  const group = el("div", "seg");
  group.setAttribute("role", "group");
  if (label) group.setAttribute("aria-label", label);
  for (const o of options) {
    const b = el("button", o.value === value ? "on" : "", o.label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(o.value === value));
    if (o.title) b.title = o.title;
    b.addEventListener("click", () => pick(o.value));
    group.append(b);
  }
  return group;
}
