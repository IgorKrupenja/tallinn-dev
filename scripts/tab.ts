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
import { REPO, SESSION, cliCommand, die, ensureInstalled } from "./browser.ts";

const TAG_RE = /^[A-Za-z0-9._-]{1,80}$/;
const USAGE = "usage: tab.ts [-s <session>] [--timeout <seconds>] open <tag> <url> | run <tag> [file] | close <tag> | cleanup <prefix>";

type State = { tid: string; url?: string | null; session: string };
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

/** Run tab.js in the browser with these arguments and, in `run` mode, the caller's code. */
async function runTabJs(args: Record<string, unknown>, body = "null"): Promise<Payload> {
  // One pass, so placeholder-like text inside the arguments or the body stays as it is. The body
  // goes on lines of its own, so a trailing `//` comment in it can't swallow the closing bracket.
  const fills: Record<string, string> = { __ARGS__: JSON.stringify(args), __BODY__: `\n${body}\n` };
  const template = await Bun.file(`${import.meta.dir}/tab.js`).text();
  const scriptPath = `${stateDir}/run-${process.pid}-${Date.now()}.js`;
  await Bun.write(scriptPath, template.replace(/__ARGS__|__BODY__/g, m => fills[m]!));
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
      const payload = await runTabJs({ mode: "close", tids });
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
    const payload = await runTabJs({ mode: "open", url: extra });
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
    const payload = await runTabJs({ mode: "close", tids: [state.tid] });
    await removeFile(statePath(tag));
    console.log(payload.closed ? "closed" : "tab was already gone");
    return 0;
  }

  const source = !extra || extra === "-" ? await Bun.stdin.text() : await Bun.file(extra).text();
  if (!source.trim()) die("no code to run");
  const shots = `${process.cwd()}/.playwright-cli`;
  await $`mkdir -p ${shots}`;
  const body = source.trim().replace(/;+$/, "");
  const payload = await runTabJs({ mode: "run", tid: state.tid, tag, shots }, body);
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
