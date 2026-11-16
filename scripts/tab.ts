#!/usr/bin/env bun
/**
 * Drive one tab of this repo's browser without touching anyone else's tabs.
 *
 * Plain playwright-cli commands act on whichever tab is current, and other chats and agents switch
 * that at any moment. This helper keeps each caller in a tab of its own: it remembers the tab's
 * Chrome target id, which stays the same across navigations, and runs your code against that page
 * only.
 *
 *     tab.ts open <tag> <url>      open a new tab for <tag> and load <url>
 *     tab.ts run <tag> [file]      run `async (p, env) => {...}` from file (or stdin) in the tab
 *     tab.ts close <tag>           close the tab
 *     tab.ts cleanup <prefix>      close every tab whose tag starts with <prefix>
 *
 * Options: -s/--session <name> (default: this repo's browser, see browser.ts) and
 * --timeout <seconds> for one call (default 420).
 *
 * In `run`, `p` is the tab's Playwright Page and `env.shots` an absolute folder for screenshots
 * (`.playwright-cli/` in the current folder). Return a string or any JSON value; it is printed.
 */

import { $ } from "bun";
import { parseArgs } from "node:util";
import type { Page } from "playwright-core";
import { REPO, SESSION, cliCommand, die, ensureInstalled } from "./browser.ts";

const TAG_RE = /^[A-Za-z0-9._-]{1,80}$/;
const USAGE = "usage: tab.ts [-s <session>] [--timeout <seconds>] open <tag> <url> | run <tag> [file] | close <tag> | cleanup <prefix>";

type State = { tid: string; url?: string | null; session: string };
/** What inBrowser() does: open a background tab and load url, run code in tab tid, or close tabs. */
type BrowserArgs =
  | { mode: "open"; url: string }
  | { mode: "run"; tid: string; tag: string; shots: string }
  | { mode: "close"; tids: string[] };
/** The caller's code for `run`. */
type TabCode = (p: Page, env: { shots: string; tag: string }) => Promise<unknown>;
/** What inBrowser() reports back, as JSON. */
type Payload = {
  ok?: boolean;
  error?: string | null;
  warning?: string;
  gone?: boolean;
  tid?: string;
  url?: string;
  result?: unknown;
  closed?: number;
};

/**
 * The part that runs inside playwright-cli's browser server, where `page` is whichever tab is
 * current. It travels as source text (Bun prints it with the types stripped), so it must not use
 * anything from outside itself. A tid is Chrome's target id for a tab, which, unlike its URL,
 * stays the same across navigations.
 */
async function inBrowser(page: Page, args: BrowserArgs, code: TabCode | null): Promise<Payload> {
  const ctx = page.context();

  async function targetId(tab: Page): Promise<string> {
    const cdp = await ctx.newCDPSession(tab);
    try {
      return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  async function findTab(id: string): Promise<Page | null> {
    for (const tab of ctx.pages()) {
      try {
        if ((await targetId(tab)) === id) return tab;
      } catch {}
    }
    return null;
  }

  if (args.mode === "open") {
    // ctx.newPage() would open a foreground tab, pulling Chrome in front of the user's other apps.
    const cdp = await ctx.newCDPSession(page);
    const { targetId: tid } = await cdp.send("Target.createTarget", { url: "about:blank", background: true });
    await cdp.detach().catch(() => {});
    let tab: Page | null = null;
    for (let i = 0; i < 50 && !tab; i++) {
      tab = await findTab(tid);
      if (!tab) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!tab) return { ok: false, error: "the new background tab did not appear" };
    try {
      await tab.goto(args.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      return { ok: true, tid, url: tab.url(), warning: String(e).slice(0, 300) };
    }
    return { ok: true, tid, url: tab.url(), result: await tab.title() };
  }

  if (args.mode === "run") {
    const tab = await findTab(args.tid);
    if (!tab || !code) return { ok: false, gone: true, error: "tab not found: it was closed" };
    let result: unknown = null;
    let error: string | null = null;
    try {
      result = await code(tab, { shots: args.shots, tag: args.tag });
    } catch (e) {
      error = String((e as { stack?: string } | null)?.stack || e).split("\n").slice(0, 4).join("\n");
    }
    await tab.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    return { ok: !error, error, tid: args.tid, url: tab.url(), result };
  }

  let closed = 0;
  for (const id of args.tids) {
    const tab = await findTab(id);
    if (tab) {
      await tab.close();
      closed++;
    }
  }
  return { ok: true, closed };
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    session: { type: "string", short: "s", default: SESSION },
    timeout: { type: "string", default: "420" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});
const session = values.session;
const timeout = Number(values.timeout);
// One folder per browser, so tags of different repos' browsers never clash.
const stateDir = `${(Bun.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/playwright-cli-tabs/${session}`;

const statePath = (tag: string) => `${stateDir}/${tag}.json`;

async function loadState(tag: string): Promise<State | null> {
  const file = Bun.file(statePath(tag));
  return (await file.exists()) ? ((await file.json()) as State) : null;
}

/** Bun.write creates the state folder when it's missing. */
async function saveState(tag: string, data: State): Promise<void> {
  await Bun.write(statePath(tag), JSON.stringify(data));
}

async function removeFile(path: string): Promise<void> {
  await Bun.file(path).delete().catch(() => {});
}

/** Run inBrowser() with these arguments and, in `run` mode, the caller's code (source text). */
async function runInBrowser(args: BrowserArgs, source = "null"): Promise<Payload> {
  // `run-code` takes one `async page => {...}` function as source. The caller's code goes on lines
  // of its own, so a trailing `//` comment in it can't swallow the closing bracket.
  const script = `async page => (${inBrowser.toString()})(page, ${JSON.stringify(args)}, (\n${source}\n))`;
  const scriptPath = `${stateDir}/run-${process.pid}-${Date.now()}.js`;
  await Bun.write(scriptPath, script);
  let out: string;
  let err: string;
  let code: number;
  let timedOut: boolean;
  try {
    const proc = Bun.spawn(cliCommand(["--raw", "run-code", `--filename=${scriptPath}`], session), {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeout * 1000,
    });
    [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    timedOut = proc.signalCode !== null;
  } finally {
    await removeFile(scriptPath);
  }
  if (timedOut) die(`timed out after ${timeout}s; split the work into shorter runs`);
  out = out.trim();
  if (code !== 0 || out.startsWith("###") || !out) {
    let detail = (out || err.trim()).slice(0, 2000);
    if (detail.toLowerCase().includes("not open")) {
      detail += `\nThe '${session}' browser isn't open: start it with \`bun ${REPO}/scripts/browser.ts open --headed\`, or ask the agent that started you to.`;
    }
    die(detail);
  }
  try {
    return JSON.parse(out) as Payload;
  } catch {
    die(`unexpected output: ${out.slice(0, 2000)}`);
  }
}

function printResult(result: unknown): void {
  if (result === null || result === undefined) return;
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 1));
}

async function main(): Promise<number> {
  const [cmd, arg, extra] = positionals;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!cmd || !arg) die(USAGE);
  await ensureInstalled();

  if (cmd === "cleanup") {
    const files = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: stateDir })).catch(() => [] as string[]);
    const tags = files.filter(f => f.startsWith(arg)).map(f => f.slice(0, -".json".length));
    const states = await Promise.all(tags.map(loadState));
    const tids = states.flatMap(s => (s ? [s.tid] : []));
    if (tids.length) {
      const payload = await runInBrowser({ mode: "close", tids });
      console.log(`closed ${payload.closed ?? 0} of ${tids.length} tabs`);
    } else {
      console.log("no tabs to close");
    }
    await Promise.all(tags.map(tag => removeFile(statePath(tag))));
    return 0;
  }

  const tag = arg;
  if (!TAG_RE.test(tag)) die("tag may only use letters, digits, '.', '_' and '-'");

  if (cmd === "open") {
    if (!extra) die(USAGE);
    if (await loadState(tag)) die(`tag '${tag}' already has a tab: use run, or close it first`);
    const payload = await runInBrowser({ mode: "open", url: extra });
    if (!payload.ok || !payload.tid) die(payload.error || "could not open a tab");
    await saveState(tag, { tid: payload.tid, url: payload.url, session });
    if (payload.warning) console.error(`tab opened, but loading failed: ${payload.warning}`);
    console.log(`opened ${payload.url} (${payload.result ?? ""})`);
    return 0;
  }

  if (cmd !== "run" && cmd !== "close") die(USAGE);
  const state = await loadState(tag);
  if (!state) die(`no tab for tag '${tag}': open one first`);

  if (cmd === "close") {
    const payload = await runInBrowser({ mode: "close", tids: [state.tid] });
    await removeFile(statePath(tag));
    console.log(payload.closed ? "closed" : "tab was already gone");
    return 0;
  }

  const source = !extra || extra === "-" ? await Bun.stdin.text() : await Bun.file(extra).text();
  if (!source.trim()) die("no code to run");
  const shots = `${process.cwd()}/.playwright-cli`;
  await $`mkdir -p ${shots}`;
  const body = source.trim().replace(/;+$/, "");
  const payload = await runInBrowser({ mode: "run", tid: state.tid, tag, shots }, body);
  if (payload.gone) {
    await removeFile(statePath(tag));
    die(`the tab for '${tag}' is gone: open a new one`);
  }
  state.url = payload.url;
  await saveState(tag, state);
  printResult(payload.result);
  if (payload.error) {
    console.error(`error (tab now at ${payload.url}):\n${payload.error}`);
    return 1;
  }
  return 0;
}

process.exit(await main());
