#!/usr/bin/env bun
/**
 * Run this repo's gws (the Google Workspace CLI, from node_modules) and parse its JSON.
 *
 * gws keeps its login in ~/.config/gws, one per macOS user, so every copy of it shares the same
 * sign-in. Scripts import `gws()` or `gwsItems()`; on the command line,
 * `bun scripts/gws.ts <args>` is the same as `node_modules/.bin/gws <args>`.
 *
 *     bun scripts/gws.ts calendar events list --params '{"calendarId": "primary", "maxResults": 5}'
 */

import { $ } from "bun";
import { REPO, die } from "./browser.ts";

export const GWS = `${REPO}/node_modules/.bin/gws`;

async function ensureInstalled(): Promise<void> {
  if (!(await Bun.file(GWS).exists())) die(`gws isn't installed in ${REPO}: run \`bun install\` there`);
}

async function run(args: string[]): Promise<string> {
  await ensureInstalled();
  const { stdout, stderr, exitCode } = await $`${GWS} ${args}`.nothrow().quiet();
  if (exitCode !== 0) {
    const detail = `${stdout}\n${stderr}`
      .split("\n")
      .filter(line => line.trim() && !line.startsWith("Using keyring backend"))
      .join("\n");
    throw new Error(`gws ${args.slice(0, 3).join(" ")} failed (exit ${exitCode}): ${detail.slice(0, 1000)}`);
  }
  return stdout.toString();
}

/** Run gws with these arguments and return its parsed JSON output. Throws with gws's message on failure. */
export async function gws<T = unknown>(args: string[]): Promise<T> {
  return JSON.parse(await run(args)) as T;
}

/** Run a gws list call across every page (`--page-all`) and return all pages' `items`. */
export async function gwsItems<T = unknown>(args: string[], pageLimit = 100): Promise<T[]> {
  const out = await run([...args, "--page-all", "--page-limit", String(pageLimit)]);
  return out
    .split("\n")
    .filter(line => line.trim())
    .flatMap(line => (JSON.parse(line) as { items?: T[] }).items ?? []);
}

if (import.meta.main) {
  await ensureInstalled();
  const proc = Bun.spawn([GWS, ...Bun.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}
