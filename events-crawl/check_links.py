#!/usr/bin/env python3
"""Validate that every candidate URL actually resolves to a real event page.

Run this on survivors.json BEFORE presenting the table (Step 6). A URL that
merely returns HTTP 200 is NOT proof the page exists: several Estonian sites
soft-404, i.e. serve a "page not found" page under a 200 status.

Real cases seen in the wild:
  - taltech.ee    200 -> redirects to /palun-otsi-uuesti ("please search again")
  - taltech.ee/en 200 -> redirects to /en/please-search-again

Usage:
    python3 check_links.py survivors.json            # check all
    python3 check_links.py survivors.json --json     # machine-readable

Exit code is 1 if anything looks broken, so it can gate a script.

Note on false positives — do NOT drop a candidate on these alone:
  * facebook.com URLs return HTTP 400 to cookie-less curl. FB links must be
    verified in the logged-in Playwright browser instead; this script labels
    them "needs-browser" rather than broken.
  * JS-rendered SPAs (e.g. mangudeoo.ee) serve a tiny HTML shell. "tiny" is a
    hint to look at the <title>/og:description by hand, not a verdict.
"""
import json
import re
import subprocess
import sys
import concurrent.futures

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")

# Matched against the final URL and against the first ~6KB of the body.
SOFT_404 = re.compile(
    r"(?i)palun-otsi-uuesti|please-search-again|/404(?:\.html)?(?:$|[?#])"
    r"|not[-_]found|lehek(?:ü|u)lge ei leitud|page not found|page doesn't exist"
    r"|no longer available|event not found|this event has been cancell?ed"
)
NEEDS_BROWSER = re.compile(r"(?i)facebook\.com|instagram\.com|linkedin\.com|discord\.com")


def check(idx, cand):
    url = cand["url"]
    res = {"n": idx, "title": cand.get("title", "")[:70], "url": url, "flags": []}
    try:
        out = subprocess.run(
            ["curl", "-sL", "--compressed", "--max-time", "35", "-A", UA, url,
             "-o", f"/tmp/_lc_{idx}.html", "-w", "%{http_code} %{url_effective} %{size_download}"],
            capture_output=True, text=True, timeout=60,
        )
        code, final, size = out.stdout.strip().split(" ", 2)
    except Exception as exc:
        res["flags"].append(f"fetch-error:{exc.__class__.__name__}")
        return res

    res.update(code=code, final=final, size=int(size))

    if NEEDS_BROWSER.search(url) and not code.startswith("2"):
        # Social platforms block cookie-less curl; not evidence of a dead link.
        res["flags"].append("needs-browser")
        return res

    if not code.startswith("2"):
        res["flags"].append(f"http-{code}")
    if SOFT_404.search(final):
        res["flags"].append("soft404-url")

    try:
        body = open(f"/tmp/_lc_{idx}.html", encoding="utf-8", errors="replace").read()
    except OSError:
        body = ""
    head = re.sub(r"(?is)<(script|style).*?</\1>", " ", body)[:6000]
    if SOFT_404.search(head):
        res["flags"].append("soft404-body")
    if int(size) < 1500:
        res["flags"].append(f"tiny-{size}b")

    return res


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    cands = json.load(open(args[0]))

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = sorted(pool.map(lambda p: check(*p), enumerate(cands, 1)),
                         key=lambda r: r["n"])

    if as_json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
    else:
        for r in results:
            if not r["flags"]:
                continue
            print(f"#{r['n']:>3} {','.join(r['flags']):<28} {r['title']}")
            print(f"     {r['url']}")
            if r.get("final") and r["final"] != r["url"]:
                print(f"     -> {r['final']}")

    broken = [r for r in results if r["flags"] and r["flags"] != ["needs-browser"]]
    browser = [r for r in results if r["flags"] == ["needs-browser"]]
    print(f"\nchecked {len(results)}  suspect {len(broken)}  "
          f"verify-in-browser {len(browser)}", file=sys.stderr)
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
