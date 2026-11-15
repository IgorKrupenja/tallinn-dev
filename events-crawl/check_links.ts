#!/usr/bin/env bun
/**
 * Validate that every candidate URL actually resolves to a real event page.
 *
 * Run this on survivors.json BEFORE presenting the table (Step 6). A URL that merely returns
 * HTTP 200 is NOT proof the page exists: several Estonian sites soft-404, i.e. serve a "page not
 * found" page under a 200 status.
 *
 * Real cases seen in the wild:
 *   - taltech.ee    200 -> redirects to /palun-otsi-uuesti ("please search again")
 *   - taltech.ee/en 200 -> redirects to /en/please-search-again
 *
 * Usage:
 *     bun check_links.ts survivors.json            # check all
 *     bun check_links.ts survivors.json --json     # machine-readable
 *
 * Exit code is 1 if anything looks broken, so it can gate a script.
 *
 * Note on false positives (do NOT drop a candidate on these alone):
 *   - facebook.com URLs return HTTP 400 to cookie-less curl. FB links must be verified in the
 *     logged-in Playwright browser instead; this script labels them "needs-browser" rather than
 *     broken.
 *   - JS-rendered SPAs (e.g. mangudeoo.ee) serve a tiny HTML shell. "tiny" is a hint to look at the
 *     <title>/og:description by hand, not a verdict.
 *
 * Candidate n's page is saved as /tmp/_lc_<n>.html, for that look by hand.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0 Safari/537.36";

// Matched against the final URL and against the first ~6KB of the body.
const SOFT_404 = new RegExp(
  [
    "palun-otsi-uuesti",
    "please-search-again",
    "/404(?:\\.html)?(?:$|[?#])",
    "not[-_]found",
    "lehek(?:ü|u)lge ei leitud",
    "page not found",
    "page doesn't exist",
    "no longer available",
    "event not found",
    "this event has been cancell?ed",
  ].join("|"),
  "i",
);
const NEEDS_BROWSER = /facebook\.com|instagram\.com|linkedin\.com|discord\.com/i;

type Candidate = { title?: string | null; url: string };

type Result = {
  n: number;
  title: string;
  url: string;
  flags: string[];
  code?: string;
  final?: string;
  size?: number;
};

/** What curl reports for a page: status code, URL after redirects, and size in bytes as printed. */
type Fetched = { code: string; final: string; size: string };

/** The first n characters of text, counted in code points so an emoji is never cut in half. */
const firstChars = (text: string, n: number) => [...text].slice(0, n).join("");

/**
 * Download url to bodyPath with curl, following redirects. If that fails, returns the reason
 * instead: no-curl, timeout or bad-output (it becomes the flag fetch-error:<reason>).
 */
async function curl(url: string, bodyPath: string): Promise<Fetched | string> {
  if (!Bun.which("curl")) return "no-curl";
  const report = "%{http_code} %{url_effective} %{size_download}";
  const proc = Bun.spawn(
    ["curl", "-sL", "--compressed", "--max-time", "35", "-A", UA, url, "-o", bodyPath, "-w", report],
    { stdout: "pipe", stderr: "ignore", timeout: 60_000 },
  );
  const out = (await proc.stdout.text()).trim();
  await proc.exited;
  if (proc.signalCode) return "timeout"; // killed by the timeout
  const match = /^([^ ]*) ([^ ]*) (\d+)$/.exec(out); // "<code> <final url> <size>"
  if (!match) return "bad-output";
  const [, code = "", final = "", size = ""] = match;
  return { code, final, size };
}

async function check(n: number, candidate: Candidate): Promise<Result> {
  const url = candidate.url;
  const result: Result = { n, title: firstChars(candidate.title ?? "", 70), url, flags: [] };
  const bodyPath = `/tmp/_lc_${n}.html`;
  const fetched = await curl(url, bodyPath);
  if (typeof fetched === "string") {
    result.flags.push(`fetch-error:${fetched}`);
    return result;
  }

  const { code, final, size } = fetched;
  result.code = code;
  result.final = final;
  result.size = Number(size);

  if (NEEDS_BROWSER.test(url) && !code.startsWith("2")) {
    // Social platforms block cookie-less curl; not evidence of a dead link.
    result.flags.push("needs-browser");
    return result;
  }

  if (!code.startsWith("2")) result.flags.push(`http-${code}`);
  if (SOFT_404.test(final)) result.flags.push("soft404-url");

  const body = await Bun.file(bodyPath).text().catch(() => ""); // no file: nothing was downloaded
  const head = firstChars(body.replace(/<(script|style).*?<\/\1>/gis, " "), 6000);
  if (SOFT_404.test(head)) result.flags.push("soft404-body");
  if (Number(size) < 1500) result.flags.push(`tiny-${size}b`);

  return result;
}

/** Map items through fn, at most `limit` at a time. The results keep the items' order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function main(args: string[]): Promise<number> {
  const asJson = args.includes("--json");
  const [path] = args.filter(a => !a.startsWith("--"));
  if (!path) {
    console.error("usage: check_links.ts survivors.json [--json]");
    return 1;
  }
  const candidates: Candidate[] = await Bun.file(path).json();
  const results = await mapLimit(candidates, 8, (candidate, i) => check(i + 1, candidate));

  if (asJson) {
    console.log(JSON.stringify(results, null, 1));
  } else {
    for (const r of results) {
      if (!r.flags.length) continue;
      console.log(`#${String(r.n).padStart(3)} ${r.flags.join(",").padEnd(28)} ${r.title}`);
      console.log(`     ${r.url}`);
      if (r.final && r.final !== r.url) console.log(`     -> ${r.final}`);
    }
  }

  const onlyNeedsBrowser = (r: Result) => r.flags.length === 1 && r.flags[0] === "needs-browser";
  const broken = results.filter(r => r.flags.length && !onlyNeedsBrowser(r));
  const browser = results.filter(onlyNeedsBrowser);
  console.error(`\nchecked ${results.length}  suspect ${broken.length}  verify-in-browser ${browser.length}`);
  return broken.length ? 1 : 0;
}

process.exitCode = await main(Bun.argv.slice(2));
