#!/usr/bin/env node
/**
 * Creates a small TypeScript shop with ten months of history, to try the
 * Review view on. Every run builds the same history: fixed authors, fixed
 * dates, and your git config is not read or changed.
 *
 *   main, Nov 2025 to Aug 2026   the shop grows; along the way src/core
 *                                picks up two uphill links:
 *     Apr 2026  src/core -> src/data     a new import (human)
 *     Jun 2026  src/core -> src/config   drift: config starts importing
 *                                        features, so it becomes less stable
 *                                        than core without core changing
 *   ai/discount-banner, Sep 2026 two agent-assisted commits (the pull
 *                                request, left checked out) that add three
 *                                uphill imports:
 *     src/core -> src/features/checkout       a helper in the wrong folder (move)
 *     src/core -> src/features/notifications  the event bus sends email itself (flip)
 *     src/ui   -> src/ui/badge                an index re-exporting its subfolder (likely meant)
 *
 * Some imports use the tsconfig alias "~/..." for src/, as real code does.
 *
 * Usage:  node demo/make-demo-repo.mjs [folder]      (default: ./demo-shop)
 * Needs git on the PATH.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const target = path.resolve(process.argv[2] ?? "demo-shop");
const MARKER = ".demo-shop";

if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
  if (!fs.existsSync(path.join(target, MARKER))) {
    console.error(`${target} exists and is not an old demo repo. Pick another folder.`);
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(target, { recursive: true });

const ADA = ["Ada Developer", "ada@shop.example"];
const BEN = ["Ben Reviewer", "ben@shop.example"];
const AGENT_TRAILER = "\n\nCo-authored-by: Claude <noreply@anthropic.com>";

function git(args, who = ADA, date) {
  const env = { ...process.env };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  return execFileSync(
    "git",
    ["-c", `user.name=${who[0]}`, "-c", `user.email=${who[1]}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd: target, env, stdio: ["ignore", "pipe", "pipe"] },
  ).toString();
}

function write(files) {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(target, ...file.split("/"));
    if (text === null) {
      fs.rmSync(full, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text.replace(/^\n/, ""), "utf8");
  }
}

function commit(date, who, message, files) {
  write(files);
  git(["add", "-A"], who);
  git(["commit", "-q", "-m", message], who, `${date}T10:00:00+02:00`);
}

git(["init", "-q"]);
git(["symbolic-ref", "HEAD", "refs/heads/main"]);

// ---------------------------------------------------------------------------
// Nov 2025: the shop

commit("2025-11-04", ADA, "Start the shop: products, cart and a button", {
  [MARKER]: "Created by make-demo-repo.mjs. Safe to delete.\n",
  ".gitignore": "node_modules\n",
  "package.json": `
{
  "name": "demo-shop",
  "private": true,
  "type": "module"
}
`,
  "tsconfig.json": `
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "~/*": ["src/*"] }
  },
  "include": ["src"]
}
`,
  "README.md": `
# demo-shop

A tiny shop with ten months of history, used to try the Review view.
The branch \`ai/discount-banner\` is the pull request to review against \`main\`.
`,
  "src/config/env.ts": `
export const env = {
  currency: "NOK",
  logLevel: "info" as "debug" | "info",
  apiUrl: "https://api.shop.example",
};
`,
  "src/core/money.ts": `
export interface Money {
  amount: number;
  currency: string;
}

export function money(amount: number, currency = "NOK"): Money {
  return { amount, currency };
}

export function add(a: Money, b: Money): Money {
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function formatMoney(m: Money): string {
  return \`\${m.amount.toFixed(2)} \${m.currency}\`;
}
`,
  "src/core/ids.ts": `
let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  return \`\${prefix}-\${Date.now().toString(36)}-\${counter}\`;
}
`,
  "src/core/log.ts": `
import { env } from "../config/env";

export function log(message: string): void {
  if (env.logLevel === "debug" || !message.startsWith("debug:")) console.log(\`[shop] \${message}\`);
}
`,
  "src/data/api.ts": `
import { env } from "~/config/env";
import { log } from "~/core/log";

export async function get<T>(path: string): Promise<T> {
  log(\`GET \${path}\`);
  const response = await fetch(env.apiUrl + path);
  return (await response.json()) as T;
}
`,
  "src/data/products.ts": `
import type { Money } from "~/core/money";
import { get } from "./api";

export interface Product {
  id: string;
  name: string;
  price: Money;
}

export function listProducts(): Promise<Product[]> {
  return get<Product[]>("/products");
}
`,
  "src/ui/theme/theme.ts": `
export const theme = { accent: "#4e79a7", radius: 4 };
`,
  "src/ui/button/button.ts": `
import { theme } from "../theme/theme";

export function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.borderRadius = \`\${theme.radius}px\`;
  b.addEventListener("click", onClick);
  return b;
}
`,
  "src/ui/index.ts": `
export { button } from "./button/button";
export { theme } from "./theme/theme";
`,
  "src/features/cart/cart.ts": `
import { add, money, type Money } from "~/core/money";
import type { Product } from "~/data/products";

export interface Cart {
  lines: { product: Product; quantity: number }[];
}

export function total(cart: Cart): Money {
  return cart.lines.reduce((sum, line) => add(sum, { ...line.product.price, amount: line.product.price.amount * line.quantity }), money(0));
}
`,
  "src/features/cart/cartView.ts": `
import { formatMoney } from "~/core/money";
import { button } from "~/ui";
import { total, type Cart } from "./cart";

export function renderCart(cart: Cart, onCheckout: () => void): HTMLElement {
  const root = document.createElement("section");
  root.textContent = \`Total: \${formatMoney(total(cart))}\`;
  root.append(button("Check out", onCheckout));
  return root;
}
`,
  "src/app.ts": `
import { log } from "./core/log";
import { renderCart } from "./features/cart/cartView";

log("starting");
document.body.append(renderCart({ lines: [] }, () => log("checkout")));
`,
});

// ---------------------------------------------------------------------------
// Dec 2025: checkout and orders

commit("2025-12-02", BEN, "Add checkout and orders", {
  "src/data/orders.ts": `
import { newId } from "~/core/ids";
import type { Money } from "~/core/money";
import { get } from "./api";

export interface Order {
  id: string;
  total: Money;
}

export function createOrder(total: Money): Order {
  return { id: newId("order"), total };
}

export function listOrders(): Promise<Order[]> {
  return get<Order[]>("/orders");
}
`,
  "src/features/checkout/pricing.ts": `
import { money, type Money } from "~/core/money";

export function shipping(subtotal: Money): Money {
  return subtotal.amount >= 500 ? money(0) : money(49);
}
`,
  "src/features/checkout/checkout.ts": `
import { add } from "~/core/money";
import { createOrder, type Order } from "~/data/orders";
import { total, type Cart } from "../cart/cart";
import { shipping } from "./pricing";

export function checkout(cart: Cart): Order {
  const subtotal = total(cart);
  return createOrder(add(subtotal, shipping(subtotal)));
}
`,
  "src/features/checkout/checkoutView.ts": `
import { formatMoney } from "~/core/money";
import { button } from "~/ui";
import type { Cart } from "../cart/cart";
import { checkout } from "./checkout";

export function renderCheckout(cart: Cart): HTMLElement {
  const root = document.createElement("section");
  root.append(button("Pay", () => {
    const order = checkout(cart);
    root.textContent = \`Paid \${formatMoney(order.total)}\`;
  }));
  return root;
}
`,
  "src/app.ts": `
import { log } from "./core/log";
import { renderCart } from "./features/cart/cartView";
import { renderCheckout } from "./features/checkout/checkoutView";

log("starting");
const cart = { lines: [] };
document.body.append(renderCart(cart, () => document.body.append(renderCheckout(cart))));
`,
});

// ---------------------------------------------------------------------------
// Jan 2026: events and notifications

commit("2026-01-13", ADA, "Add order events and notifications", {
  "src/core/events.ts": `
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler[]>();

export function on(event: string, handler: Handler): void {
  handlers.set(event, [...(handlers.get(event) ?? []), handler]);
}

export function emit(event: string, payload: unknown): void {
  for (const handler of handlers.get(event) ?? []) handler(payload);
}
`,
  "src/features/notifications/templates.ts": `
export function orderPlaced(orderId: string): string {
  return \`Thanks! Your order \${orderId} is on its way.\`;
}
`,
  "src/features/notifications/notify.ts": `
import { on } from "~/core/events";
import { log } from "~/core/log";
import { orderPlaced } from "./templates";

on("order:placed", (payload) => {
  const { id } = payload as { id: string };
  log(orderPlaced(id));
});
`,
  "src/features/checkout/checkout.ts": `
import { emit } from "~/core/events";
import { add } from "~/core/money";
import { createOrder, type Order } from "~/data/orders";
import { total, type Cart } from "../cart/cart";
import { shipping } from "./pricing";

export function checkout(cart: Cart): Order {
  const subtotal = total(cart);
  const order = createOrder(add(subtotal, shipping(subtotal)));
  emit("order:placed", order);
  return order;
}
`,
});

// ---------------------------------------------------------------------------
// Feb 2026: a modal

commit("2026-02-10", BEN, "Confirm payment in a modal", {
  "src/ui/modal/modal.ts": `
import { theme } from "../theme/theme";

export function modal(content: HTMLElement): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.style.borderRadius = \`\${theme.radius}px\`;
  dialog.append(content);
  return dialog;
}
`,
  "src/ui/index.ts": `
export { button } from "./button/button";
export { modal } from "./modal/modal";
export { theme } from "./theme/theme";
`,
  "src/features/checkout/checkoutView.ts": `
import { formatMoney } from "~/core/money";
import { button, modal } from "~/ui";
import type { Cart } from "../cart/cart";
import { checkout } from "./checkout";

export function renderCheckout(cart: Cart): HTMLElement {
  const root = document.createElement("section");
  root.append(button("Pay", () => {
    const order = checkout(cart);
    const text = document.createElement("p");
    text.textContent = \`Paid \${formatMoney(order.total)}\`;
    root.append(modal(text));
  }));
  return root;
}
`,
});

// ---------------------------------------------------------------------------
// Mar 2026: search

commit("2026-03-10", ADA, "Add product search", {
  "src/features/search/search.ts": `
import { listProducts, type Product } from "~/data/products";

export async function search(query: string): Promise<Product[]> {
  const products = await listProducts();
  return products.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
}
`,
  "src/features/search/searchView.ts": `
import { formatMoney } from "~/core/money";
import { button } from "~/ui";
import { search } from "./search";

export function renderSearch(): HTMLElement {
  const root = document.createElement("section");
  const input = document.createElement("input");
  root.append(input, button("Search", async () => {
    const hits = await search(input.value);
    root.append(...hits.map((p) => Object.assign(document.createElement("p"), { textContent: \`\${p.name} \${formatMoney(p.price)}\` })));
  }));
  return root;
}
`,
  "src/app.ts": `
import { log } from "./core/log";
import { renderCart } from "./features/cart/cartView";
import { renderCheckout } from "./features/checkout/checkoutView";
import { renderSearch } from "./features/search/searchView";

log("starting");
const cart = { lines: [] };
document.body.append(renderSearch(), renderCart(cart, () => document.body.append(renderCheckout(cart))));
`,
});

// ---------------------------------------------------------------------------
// Apr 2026: core starts asking the server for ids (an uphill import)

commit("2026-04-07", BEN, "Take order ids from the server", {
  "src/core/ids.ts": `
import { get } from "../data/api";

let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  return \`\${prefix}-\${Date.now().toString(36)}-\${counter}\`;
}

export async function serverId(prefix: string): Promise<string> {
  const { id } = await get<{ id: string }>(\`/ids/\${prefix}\`);
  return id;
}
`,
});

// ---------------------------------------------------------------------------
// May 2026: accounts

commit("2026-05-12", ADA, "Add an account page", {
  "src/features/account/account.ts": `
import { get } from "~/data/api";
import { listOrders, type Order } from "~/data/orders";

export interface Account {
  name: string;
  orders: Order[];
}

export async function loadAccount(): Promise<Account> {
  const { name } = await get<{ name: string }>("/me");
  return { name, orders: await listOrders() };
}
`,
  "src/features/account/accountView.ts": `
import { formatMoney } from "~/core/money";
import { button } from "~/ui";
import { loadAccount } from "./account";

export function renderAccount(): HTMLElement {
  const root = document.createElement("section");
  root.append(button("My orders", async () => {
    const account = await loadAccount();
    root.append(...account.orders.map((o) => Object.assign(document.createElement("p"), { textContent: formatMoney(o.total) })));
  }));
  return root;
}
`,
});

// ---------------------------------------------------------------------------
// Jun 2026: feature flags in config (config starts depending on features)

commit("2026-06-09", BEN, "Add feature flags", {
  "src/config/flags.ts": `
import { searchSettings } from "../features/search/settings";

export const flags = {
  search: searchSettings.enabled,
  accounts: true,
};
`,
  "src/config/limits.ts": `
import { shipping } from "../features/checkout/pricing";

export const limits = { maxCartLines: 50, shippingRule: shipping };
`,
  "src/features/search/settings.ts": `
export const searchSettings = { enabled: true, minQueryLength: 2 };
`,
  "src/app.ts": `
import { flags } from "./config/flags";
import { log } from "./core/log";
import { renderAccount } from "./features/account/accountView";
import { renderCart } from "./features/cart/cartView";
import { renderCheckout } from "./features/checkout/checkoutView";
import { renderSearch } from "./features/search/searchView";

log("starting");
const cart = { lines: [] };
if (flags.search) document.body.append(renderSearch());
if (flags.accounts) document.body.append(renderAccount());
document.body.append(renderCart(cart, () => document.body.append(renderCheckout(cart))));
`,
});

// ---------------------------------------------------------------------------
// Jul 2026: agent-assisted work that keeps imports pointing down

commit("2026-07-14", ADA, "Show order history on the account page" + AGENT_TRAILER, {
  "src/features/account/history.ts": `
import { formatMoney } from "~/core/money";
import type { Order } from "~/data/orders";

export function historyLines(orders: Order[]): string[] {
  return orders.map((o) => \`\${o.id}: \${formatMoney(o.total)}\`);
}
`,
  "src/features/account/accountView.ts": `
import { button } from "~/ui";
import { loadAccount } from "./account";
import { historyLines } from "./history";

export function renderAccount(): HTMLElement {
  const root = document.createElement("section");
  root.append(button("My orders", async () => {
    const account = await loadAccount();
    root.append(...historyLines(account.orders).map((line) => Object.assign(document.createElement("p"), { textContent: line })));
  }));
  return root;
}
`,
});

// ---------------------------------------------------------------------------
// Aug 2026: email and a weekly digest

commit("2026-08-11", BEN, "Send notifications by email, and a weekly digest", {
  "src/features/notifications/email.ts": `
import { log } from "~/core/log";

export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  log(\`email to \${to}: \${subject}\`);
  await Promise.resolve(body);
}
`,
  "src/features/notifications/digest.ts": `
import { sendEmail } from "./email";

export async function sendWeeklyDigest(to: string, orderCount: number): Promise<void> {
  await sendEmail(to, "Your week at the shop", \`You placed \${orderCount} orders this week.\`);
}
`,
  "src/features/notifications/notify.ts": `
import { on } from "~/core/events";
import { log } from "~/core/log";
import { sendEmail } from "./email";
import { orderPlaced } from "./templates";

on("order:placed", (payload) => {
  const { id, email } = payload as { id: string; email?: string };
  log(orderPlaced(id));
  if (email) void sendEmail(email, "Order placed", orderPlaced(id));
});
`,
});

// ---------------------------------------------------------------------------
// Sep 2026: the pull request, agent-assisted

git(["checkout", "-q", "-b", "ai/discount-banner"]);

commit("2026-09-15", ADA, "Add a discount banner to checkout" + AGENT_TRAILER, {
  // The agent needed rounding for discounts, put it next to the checkout
  // code it was working on, then used it from core.
  "src/features/checkout/rounding.ts": `
export function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}
`,
  "src/core/money.ts": `
import { roundToCents } from "../features/checkout/rounding";

export interface Money {
  amount: number;
  currency: string;
}

export function money(amount: number, currency = "NOK"): Money {
  return { amount: roundToCents(amount), currency };
}

export function add(a: Money, b: Money): Money {
  return { amount: roundToCents(a.amount + b.amount), currency: a.currency };
}

export function percentOf(m: Money, percent: number): Money {
  return { amount: roundToCents((m.amount * percent) / 100), currency: m.currency };
}

export function formatMoney(m: Money): string {
  return \`\${m.amount.toFixed(2)} \${m.currency}\`;
}
`,
  "src/features/checkout/discount.ts": `
import { percentOf, type Money } from "~/core/money";

export function discount(subtotal: Money, code: string): Money {
  return code === "AUTUMN10" ? percentOf(subtotal, 10) : percentOf(subtotal, 0);
}
`,
  "src/ui/badge/badge.ts": `
import { theme } from "../theme/theme";

export function badge(text: string): HTMLElement {
  const b = document.createElement("span");
  b.textContent = text;
  b.style.background = theme.accent;
  return b;
}
`,
  "src/ui/index.ts": `
export { badge } from "./badge/badge";
export { button } from "./button/button";
export { modal } from "./modal/modal";
export { theme } from "./theme/theme";
`,
  "src/features/checkout/checkoutView.ts": `
import { formatMoney } from "~/core/money";
import { badge, button, modal } from "~/ui";
import type { Cart } from "../cart/cart";
import { checkout } from "./checkout";

export function renderCheckout(cart: Cart): HTMLElement {
  const root = document.createElement("section");
  root.append(badge("AUTUMN10: 10% off"));
  root.append(button("Pay", () => {
    const order = checkout(cart);
    const text = document.createElement("p");
    text.textContent = \`Paid \${formatMoney(order.total)}\`;
    root.append(modal(text));
  }));
  return root;
}
`,
});

commit("2026-09-16", ADA, "Email the customer when an order is placed" + AGENT_TRAILER, {
  "src/core/events.ts": `
import { sendEmail } from "../features/notifications/email";

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler[]>();

export function on(event: string, handler: Handler): void {
  handlers.set(event, [...(handlers.get(event) ?? []), handler]);
}

export function emit(event: string, payload: unknown): void {
  for (const handler of handlers.get(event) ?? []) handler(payload);
  const email = (payload as { email?: string }).email;
  if (event === "order:placed" && email) void sendEmail(email, "Order placed", "Thanks for your order.");
}
`,
});

console.log(`Demo repository ready: ${target}`);
console.log("History: Nov 2025 to Aug 2026 on main; ai/discount-banner (2 commits, Sep 2026) is checked out.");
console.log("In the app: Pick repo -> this folder, base = main, then Review change.");
