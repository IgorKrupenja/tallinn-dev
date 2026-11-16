#!/usr/bin/env bun
/**
 * Run this repo's own playwright-cli on this repo's own browser.
 *
 * playwright-cli files its browsers and their profiles under the path it is installed at, so the
 * copy in this repo's node_modules gets a browser of its own, with logins kept apart from any other
 * copy on the machine. Skills reach that browser through this script or tab.ts, never through a
 * `playwright-cli` on PATH.
 *
 * The arguments go to playwright-cli as they are, after `-s=<session>` (the session is the repo's
 * package name). `open` also gets `--persistent` and the repo's playwright-cli.json (muted audio,
 * the installed Google Chrome). playwright-cli runs on Bun, browser server included, so Node isn't
 * needed: only the launcher in node_modules/.bin would ask for it.
 *
 *     bun scripts/browser.ts list
 *     bun scripts/browser.ts open https://example.com --headed
 *     bun scripts/browser.ts screenshot --filename=.playwright-cli/page.png
 */

/** The repo root. This file is <repo>/scripts/browser.ts, and import.meta.dir is its real folder even through a symlink. */
export const REPO = import.meta.dir.replace(/\/scripts$/, "");
/** The browser's session name: the repo's package name, so each repo's browser is easy to tell apart. */
export const SESSION: string = (await Bun.file(`${REPO}/package.json`).json()).name;
/** playwright-cli's entry script, run with this Bun (process.execPath). */
export const CLI = `${REPO}/node_modules/@playwright/cli/playwright-cli.js`;
const CONFIG = `${REPO}/playwright-cli.json`;

export function die(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function ensureInstalled(): Promise<void> {
  if (!(await Bun.file(CLI).exists())) die(`playwright-cli isn't installed in ${REPO}: run \`bun install\` there`);
}

/** The full playwright-cli command for these arguments, on this repo's browser unless they name a session. */
export function cliCommand(args: string[], session = SESSION): string[] {
  const named = args.some(a => a === "-s" || a.startsWith("-s=") || a.startsWith("--session"));
  const command = [process.execPath, CLI, ...(named ? [] : [`-s=${session}`]), ...args];
  if (args.find(a => !a.startsWith("-")) === "open") {
    if (!args.includes("--persistent") && !args.some(a => a.startsWith("--profile"))) command.push("--persistent");
    if (!args.some(a => a.startsWith("--config"))) command.push(`--config=${CONFIG}`);
  }
  return command;
}

if (import.meta.main) {
  await ensureInstalled();
  const proc = Bun.spawn(cliCommand(Bun.argv.slice(2)), { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}
