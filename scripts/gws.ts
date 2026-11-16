#!/usr/bin/env bun
/**
 * Run this repo's gws (the Google Workspace CLI, from node_modules) and parse its JSON.
 *
 * gws keeps its login in ~/.config/gws, one per macOS user, so every copy of it shares the same
 * sign-in. Scripts import `gws()` or `gwsItems()`, which throw on any failure (gws missing, an API
 * error, no answer within the timeout); on the command line, `bun scripts/gws.ts <args>` runs gws
 * with those arguments. gws's launcher runs on Bun, so Node isn't needed.
 *
 *     bun scripts/gws.ts calendar events list --params '{"calendarId": "primary", "maxResults": 5}'
 */

import { REPO, die } from "./browser.ts";

/** gws's launcher, which starts its native binary; run with this Bun (process.execPath). */
export const GWS = `${REPO}/node_modules/@googleworkspace/cli/run.js`;
const MISSING = `gws isn't installed in ${REPO}: run \`bun install\` there`;

type Options = { /** Seconds to wait for gws, 90 by default. */ timeout?: number };

async function run(args: string[], { timeout = 90 }: Options): Promise<string> {
  if (!(await Bun.file(GWS).exists())) throw new Error(MISSING);
  const call = `gws ${args.slice(0, 3).join(" ")}`;
  const proc = Bun.spawn([process.execPath, GWS, ...args], { stdout: "pipe", stderr: "pipe", timeout: timeout * 1000 });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (proc.signalCode) throw new Error(`${call} gave no answer within ${timeout}s`);
  if (code !== 0) {
    const detail = `${out}\n${err}`
      .split("\n")
      .filter(line => line.trim() && !line.startsWith("Using keyring backend"))
      .join("\n");
    throw new Error(`${call} failed (exit ${code}): ${detail.slice(0, 1000)}`);
  }
  return out;
}

/** Run gws with these arguments and return its parsed JSON output. */
export async function gws<T = unknown>(args: string[], options: Options = {}): Promise<T> {
  return JSON.parse(await run(args, options)) as T;
}

/** Run a gws list call across every page (`--page-all`, up to `pageLimit` pages) and return all pages' `items`. */
export async function gwsItems<T = unknown>(args: string[], { pageLimit = 100, ...options }: Options & { pageLimit?: number } = {}): Promise<T[]> {
  const out = await run([...args, "--page-all", "--page-limit", String(pageLimit)], options);
  return out
    .split("\n")
    .filter(line => line.trim())
    .flatMap(line => (JSON.parse(line) as { items?: T[] }).items ?? []);
}

if (import.meta.main) {
  if (!(await Bun.file(GWS).exists())) die(MISSING);
  const proc = Bun.spawn([process.execPath, GWS, ...Bun.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}
