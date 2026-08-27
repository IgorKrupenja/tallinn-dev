---
name: events-crawl
description: Crawl event sources from Vivaldi bookmarks to discover new IT events in Estonia. Opens each source in browser, extracts event candidates, presents them for approval, then adds approved ones to calendar and updates Coda.
---

# Events - Crawl Sources Skill

Discover new IT events by crawling bookmarked event sources. Extracts candidates, deduplicates against the calendar, and presents a batch for user approval.

## Prerequisites

**ALWAYS load environment variables first:**

Note: Use `set -a && source ... && set +a` instead of `export $(grep ... | xargs)` because some env vars contain paths with spaces.

```bash
set -a && source "${SKILLS_DIR:-$HOME/.claude/skills}/.env" && set +a
```

Required env vars:

- `$BOOKMARKS_FILE` - Path to Chromium bookmarks JSON file
- `$BOOKMARKS_FOLDER` - Folder path in bookmarks (e.g. `talllinn.dev/Sources`)
- `$GOOGLE_CALENDAR_ID` - Target calendar ID
- `$GOOGLE_PLACES_API_KEY` - Google Places API key
- `$CODA_API_TOKEN`, `$CODA_DOC_ID`, `$CODA_TABLE_ID` - Coda access

Also used: **`events-crawl/state.json`** — the memory of what Igor was offered and passed on, so
the same events are never offered twice. What is already *added* is not tracked there; the
calendar is the source of truth for that. See the **Candidate memory** section near the end of
this file. If `state.json` is missing, create it from `state.example.json`.

## Overview

1. Read event source URLs from Vivaldi bookmarks (fresh each time)
2. Open each source in browser and extract event links/info
3. Verify ALL sources were crawled (mandatory checkpoint)
4. Dump the calendar (the source of truth for what is already added)
5. Filter — one pass drops what is already on the calendar AND what Igor already passed on
6. Present ALL survivors in a numbered table
7. User approves by number
8. **Record the answer to `state.json`** — everything presented and not picked → `declined`
9. Add approved events using `events-add` skill
10. Update Coda using `events-coda` skill

## Step 1: Read Bookmarks

**Read fresh each time** — the bookmark list is not static, the user adds/removes sources between runs.

`$BOOKMARKS_FOLDER` is a `/`-separated path of folder names (e.g. `talllinn.dev/Sources`). Walk into each folder by name:

```bash
# Build jq filter dynamically from BOOKMARKS_FOLDER (e.g. "talllinn.dev/Sources")
FILTER=$(python3 -c "
import os
folders = os.environ['BOOKMARKS_FOLDER'].split('/')
f = '.roots.bookmark_bar.children[]'
for folder in folders:
    f += f' | select(.name == \"{folder}\") | .children[]'
f += ' | .url'
print(f)
")

jq -r "$FILTER" "$BOOKMARKS_FILE"
```

## Step 2: Crawl Each Source

For each bookmark URL, open it in the browser and figure out what's on the page. Don't rely on hardcoded per-site logic — read the snapshot and extract events based on what you see.

**Collect ALL candidates across ALL sources before presenting to user.**

Keep a running list of candidates:

```
candidate = { title, date, url, source_url, location (if available) }
```

**Every candidate MUST have a URL.** If you can see an event title/date but don't have a direct link, click into it or extract the href from the snapshot before moving on. A candidate without a URL is incomplete — the user needs URLs to review events and the add-event skill needs them to extract details.

### General approach for every source

**NEVER skip sources — not even if they feel noisy, time-intensive, or you think you already have enough candidates.** Every source is bookmarked for a reason. If a page requires login, ask the user to log in. If a source requires many clicks or scrolls (Fienta, LinkedIn), do the work — that's the whole point of crawling. "I have 30 candidates already" is NOT a reason to skip remaining sources.

1. Navigate to the URL in browser
2. Handle cookie banners / popups (dismiss them)
3. Take a snapshot
4. Look for event listings: titles with dates, links to event detail pages
5. Extract future events — ignore past ones
6. If the page has pagination or "load more", scroll/click to get more (see limits below)
7. **Don't dismiss posts based on post age** — a post from weeks ago may promote an event that's still in the future. Always check the actual event date, not the post/publish date. Click through to the event link if the date isn't clear from the post itself.
8. **Scroll feeds deeply** — for any feed-style page (FB pages, LinkedIn, groups), scroll **at least 5 times** before moving on. Events are often 3-4 posts down, not at the top. Don't stop after seeing just the first 1-2 posts.
9. **When unsure if an event fits, open its detail page** to investigate before excluding it.
10. **Paid conferences are fine** if they're real community/industry events. Only exclude paid online training courses (e.g. ISTQB certification at €1000+).

### What to look for in snapshots

- Links containing `/events/`, `/event/`, or pointing to known event platforms (luma.com, eventbrite.com, fienta.com, meetup.com, facebook.com/events)
- Date patterns near link text (e.g., "Mar 26", "26.03.2026", "Thursday 2 April")
- Event card patterns: heading + date + location grouped together
- For social feeds (FB groups, LinkedIn posts): scan posts for shared event links
- **Programs, accelerators, and initiatives** (e.g. "ScaleUP Program", "Incubator Batch") — these often have kickoff events, demo days, pitch nights, or application deadlines with public events attached. Follow the link and check for specific dates/events inside.
- **Job shadow weeks, career days, and open-door events at tech clusters** (e.g. Ülemiste City, Tehnopol) — these are relevant if they take place in a tech/startup hub where the participating companies are predominantly tech companies. Include them even if the event itself isn't strictly "about" technology.

### Per-source crawling notes

**IMPORTANT: Do NOT dismiss sources after a surface-level scan. Be thorough — paginate, scroll, and dig into each source.**

- **Default**: Extract what's visible on the first page load. If there's a clear "Show more" or pagination, go up to 5 pages deep.
- **Eventbrite** (`eventbrite.com`):
  - Paginate through **at least 4 pages** of results
  - Stop when you start seeing only Helsinki/Finland events
- **ECB** (`ecb.ee/calendar`): Goldmine of tech conferences.
  - Scan the full table for tech keywords (cyber, digital, AI, startup, blockchain, fintech, smart, IoT, cloud, etc.)
  - **Check ALL future years** in the year dropdown — click the search button to switch years. ECB lists events years in advance (2027, 2028, etc.)
  - Each table row has a "WWW" column (3rd column) with a direct link to the event website — **always extract that URL**, don't link to the ECB calendar page itself
- **Fienta** (`fienta.com`):
  - Click "Load more" **at least 10 times** to see events up to 2 weeks out
  - The first page only shows today's events
  - Scan all loaded events for tech relevance — tech events are mixed in among cultural ones
- **Luma** (`luma.com/tech`, `luma.com/discover`, specific calendars):
  - The 2-week limit applies **only to global/international event listings** (major events, popular calendars)
  - The **"Nearby Events" section shows local Tallinn events** — extract ALL of them regardless of date, since there are very few
  - **Nearby Events is lazy-loaded** — after navigating, you MUST `window.scrollTo(0, document.body.scrollHeight)` and wait ~2 seconds before reading the section. On first load `body.innerText` shows just the heading followed immediately by the footer (`"Nearby Events\nDiscoverPricingHelp\nGet the App"`) — that means the cards haven't fetched yet, NOT that there are no local events. Do not treat this as empty.
  - Nearby events render as `button` elements in snapshots without visible hrefs — **extract the `/url:` from the nested `link` element** (e.g. `/url: /yurdrxp2` → `https://luma.com/yurdrxp2`), or click the button to navigate
  - For **specific Luma calendars** (e.g. `luma.com/EstoniAI`), extract ALL upcoming events — these pages are small
- **Facebook groups/feeds**:
  - Feed content renders as empty `blockquote: Facebook` placeholders in accessibility snapshots — **use `browser_take_screenshot` instead** to read the feed visually
  - For pages with an Events tab, check the Events tab first (snapshots work there), then **always also check the main feed** via screenshots — some pages post event links but don't create formal FB events (e.g. EstoniaWEB3, Palo Alto Club)
  - **URL extraction**: event cards in snapshots have truncated titles but include a `link` element with `/url:` — always extract that URL. For feed posts with event links visible only in screenshots, navigate to the post to get the actual URL
- **LinkedIn feeds**:
  - For company pages with an Events tab, check events first, then also scroll the posts feed
  - Snapshots generally work better than Facebook, but use `browser_take_screenshot` if content appears empty
- **K-space** (`wiki.k-space.ee`):
  - Chaostreffs is a valid recurring event (every Thursday) — check the wiki page to confirm it's still running
  - Check the calendar's recurring event RRULE and **extend the UNTIL date to ~6 months from today** if needed (use `gog calendar update` with `--rrule` and `--scope all`)
  - Also check for one-off events on the events page
- **Discord**: SPA that renders very poorly in accessibility snapshots.
  - **Use `browser_take_screenshot` instead** to read the channel visually
  - If you see an event mentioned in a screenshot, **navigate to the linked URL to confirm details** — a screenshot alone is not a substitute for having the actual event URL
  - **Newest messages are at the BOTTOM** — Discord channels load most-recent first. Scroll the message list UP (not down) repeatedly to load older posts. Keep scrolling until you've seen messages from at least the past month.

## Step 3: Verify ALL Sources Were Crawled

**STOP and check before proceeding.** Go through the full bookmark list from Step 1 and confirm every single URL was visited. If ANY source was skipped — for any reason (felt noisy, seemed time-intensive, "enough candidates already", context getting long) — go back and crawl it NOW before moving on.

This is a known failure mode: after crawling 20+ sources and collecting many candidates, there is a strong temptation to skip the remaining "hard" sources (Fienta with 10+ load-more clicks, LinkedIn feeds, Discord). These are exactly the sources most likely to have unique events not found elsewhere. Do not proceed to deduplication until every source has been visited.

## Step 4: Dump the calendar

The calendar is the source of truth for what is already added. Dump it once — Step 5's filter
does the actual matching, so there is no separate hand-rolled dedup pass to get wrong:

```bash
set -a && source "${SKILLS_DIR:-$HOME/.claude/skills}/.env" && set +a

# MUST use --all-pages (default --max is only 10!) and RFC3339 dates with timezone.
# Range: today → a few years out, because ECB lists conferences years in advance.
gog calendar list "$GOOGLE_CALENDAR_ID" \
  --from "$(date -I)T00:00:00+02:00" \
  --to "2029-12-31T23:59:59+02:00" \
  --all-pages --json > /tmp/calendar.json
```

`gog` writes one JSON object per page, so the file may hold several concatenated objects —
`candidates.py` handles that. Every event created by `events-add` has its URL on the first line
of the description, which is what makes URL-level matching possible.

Note `--all-pages` still emits a `nextPageToken`; ignore it, the pages are all there.

## Step 5: Filter

### Candidate memory — run this FIRST, before any human judgement

**Igor should never be shown the same event twice** — neither one already on the calendar, nor
one he was offered and passed on. If he was offered something and did not ask for it, that is a
"no" and it must never resurface. Don't re-derive the logic, run the helper:

```bash
# write the crawled candidates to /tmp/candidates.json first:
#   [{ "title": ..., "date": ..., "url": ..., "source_url": ..., "location": ... }]
# /tmp/calendar.json is the dump from Step 4.
python3 "$SKILLS_DIR/events-crawl/candidates.py" filter \
  "$SKILLS_DIR/events-crawl/state.json" /tmp/candidates.json /tmp/calendar.json > survivors.json
```

It prints `SHOW n / HIDE n` plus a one-line reason per hidden event to stderr, and the
survivors as JSON on stdout. **Present only the survivors.** Mention the hidden count in the run
summary (e.g. "26 suppressed: 4 already on calendar, 22 previously declined") so the filter is
visible, never silent.

**The calendar is the source of truth for what is already added** — `state.json` does NOT mirror
it. Every event written by `events-add` carries its URL on the first line of the description, so
the calendar is a complete URL index (verified: 231/231 non-Chaostreff events). This matters:
if Igor deletes an event from the calendar it becomes offerable again, which is correct. A
mirrored "added" list would silently suppress it forever.

Always pass `calendar.json`. Without it the filter warns and only applies `state.json`, so
already-added events would come back.

Matching is deliberately layered, because the same event reappears in different clothes:

| Layer | Source | Catches |
| --- | --- | --- |
| Normalized URL | calendar, then `declined` | utm/fbclid params, `www.`, trailing slash, `/et/` vs `/en/`, http/https |
| Normalized title **+ year** | calendar, then `declined` | same event surfaced via a different link (e.g. ECB links a Facebook post one year and the official site the next) |
| `banned_series` | `state.json` | whole recurring series / organizers, by title phrase, scoped to one source or `*` |

**The year is part of the key on purpose.** Declining *Cloud Tech Tallinn 2027* must NOT hide
*Cloud Tech Tallinn 2028* — annual conferences are the norm here. Series bans ignore the year.

**Aliases.** Occasionally a source lists an event that IS on the calendar but under a different
title, date *and* URL, so neither layer matches — e.g. ECB carries a phantom `02.10` row for the
Tallinn Design Festival conference that actually runs `01.10`. Record those in `declined` with
`reason: "duplicate-of-calendar-event"` and a `note` naming the real entry.

### Blocked organizers — hard exclusions

**Drop these silently, no matter how tech-relevant they look.** These override "when in doubt, INCLUDE" below — do NOT surface them as candidates for the user to judge.

| Organizer | Identifying markers | Reason |
| --- | --- | --- |
| **Tallinn Tech Social** / IT Social | `itsocialevent.com`, Eventbrite organizer "Tallinn Tech Social", socials `@tech.social.event`, titles like "Tallinn Tech Mixer and Social (Tech / AI / Data / IT)" | Reported scam (2026-08-03): sells cheap tickets (€3–5) to events that don't happen. No named organizer, dead WhatsApp/Facebook/Discord channels, fake "5/5 on TrustPilot" badge linking to no reviews, AI-generated blog filler. Reported to Eventbrite by an attendee. Recurring weekly series — will keep reappearing on Eventbrite crawls. |
| **MUD Events** | Eventbrite organizer "MUD Events" (`eventbrite.com/o/37845888663`), titles like "Business Networking - Startups, Investors & Tech", venue "TECH HUB - Telliskivi 60a/5" | Removed by user request (2026-08-03). Paid-ticket franchise networking: template description reused across cities ("part of a global series hosted in major cities worldwide"), no named host. Not a confirmed scam like the above, but not a real local community event either — don't list it. Recurring weekly series. |

When a blocked organizer's event is found, note it in the run summary as blocked (so the user knows the filter fired) but never add it to the calendar.

**Signals that should make you check an organizer before adding** (not auto-blocks — investigate, and ask the user if unsure):

- Paid ticket for a generic "networking / mixer / social" event with **no named organizer or host** anywhere
- Franchise-style copy ("part of a global series hosted in major cities worldwide") with a template description reused across cities
- Rating/trust badges that don't link to a real profile
- Community links (Discord/WhatsApp/Telegram) that are empty or have no activity

Remove candidates that are NOT IT/tech/startup related. Keep events about:

- Software development, programming, coding
- AI, machine learning, data science
- Startups, entrepreneurship, venture capital, pitch events
- Tech meetups, hackathons, conferences
- IT infrastructure, cybersecurity, cloud
- Design/UX in tech context
- HealthTech, FinTech, EdTech, GreenTech (tech verticals)
- Blockchain, Web3, crypto

Kids/student tech events (camps, school hackathons) are fine — they get a "student" label in Coda. These are uncommon but valid.

**Non-public events are also fine** — university seminars, invite-only meetups, career events at tech companies, etc. Many people can have access to these and they're still valuable to list. Don't filter out events just because they seem "internal" or targeted at a specific audience (students, alumni, employees).

Remove events about:

- Pure business/marketing with no tech angle
- Concerts, theatre, sports, cooking
- Non-tech networking
- Job fairs that aren't tech-specific
- **Paid training courses** (e.g. ISTQB certification at €1000+, professional certification programs). Paid conferences (at any price) are fine if they're real community/industry events.
- **Paid online-only events** listed on Eventbrite or similar — only include in-person or hybrid events in Estonia

**When in doubt, INCLUDE the candidate** — the user will make the final call.

## Step 6: Present Candidates

After ALL sources have been crawled, present the full candidate list as a numbered table:

```
| # | Event | Date | Location | Source |
|---|-------|------|----------|--------|
| 1 | AI Meetup Tallinn | Apr 15, 18:00 | LIFT99 | luma.com |
| 2 | Startup Pitch Night | Apr 20, 17:00 | Tehnopol | tehnopol.ee |
| ... | ... | ... | ... | ... |
```

Also note:

- Any sources that were skipped (page errors, etc.)
- Total sources crawled vs skipped

Format:

```
| # | Event | Date | Location | URL | Source |
|---|-------|------|----------|-----|--------|
| 1 | ... | ... | ... | https://... | ... |


✅ Crawled: 30/30 sources
```

Then ask: **"Which events to add?"**

**Before asking, save the presented list verbatim** (same order as the numbers shown) — Step 7
needs it to work out what was ignored:

```bash
cp survivors.json /tmp/presented.json
```

## Step 7: Record the answer (MANDATORY — do this before adding)

Igor answers by number ("add 1 2 5", "1,4,9 skip others"). Everything presented and **not**
picked counts as declined — silence is a "no", that is the whole point of this step.

```bash
python3 "$SKILLS_DIR/events-crawl/candidates.py" record \
  "$SKILLS_DIR/events-crawl/state.json" /tmp/presented.json "add 1 2 5"
```

The rest → `declined` with `reason: "ignored"`. **Approved events are not written to
`state.json`** — once they land on the calendar in Step 8, the calendar is their record. If an
add fails, the event correctly shows up again next crawl.

Run this **even if he picks nothing** ("none of these" → all declined).

Edge cases:

- **He replies to only part of the batch, then adds more later** ("also add 5"): run
  `unskip` for that one, then add it normally.
  ```bash
  python3 candidates.py unskip state.json "https://luma.com/xyz"   # url or title fragment
  ```
- **He never answers the batch at all** and asks for something unrelated: do NOT record
  declines — an unanswered batch is not a rejection. Keep `presented.json` and ask next time
  whether to drop it.
- **He wants a whole recurring series gone** ("stop showing me this", "ban that organizer"):
  ```bash
  python3 candidates.py ban state.json "The Founders Room" "The Founders Room (paid weekly)" "*"
  ```
  Use the source bookmark URL instead of `*` to scope the ban to one source.
- **A declined event turns out to be wanted**: `unskip` it. The file is plain JSON — hand-editing
  or deleting an entry is perfectly fine.

## Step 8: Add Approved Events

For each approved event, use the `events-add` skill flow:

1. Open the event URL in browser
2. Extract full details (click "See more" on FB, etc.)
3. Resolve location via goplaces
4. Check for duplicates (should be clean but double-check)
5. Create calendar entry

## Step 9: Update Coda

**Auto-proceed: after all approved events are added in Step 8, immediately proceed to this step without asking the user.**

After all events are added, run the `events-coda` skill to:

1. Trigger Google Calendar sync
2. Auto-archive past events
3. Label new events
4. Add missing links

## Candidate memory — `state.json` schema

Lives at `events-crawl/state.json`, next to this file. Committed to git (these are public
events — no privacy concern, and history makes a bad entry easy to undo). Plain JSON on
purpose: hand-editing and `git diff` are the recovery tools.

**Two buckets only.** There is deliberately no `added` list: the calendar already records what
was added, and mirroring it here would go stale the moment Igor deletes something.

```jsonc
{
  "declined": [
    { "url": "https://...", "title": "...", "year": 2026,
      "reason": "ignored",           // "ignored" = presented and not picked
                                     // "duplicate-of-calendar-event" = alias, see Aliases above
      "declined_at": "2026-08-27",
      "note": "optional — for aliases, name the real calendar entry" }
  ],
  "banned_series": [
    { "match": "founders room",      // normalized phrase, matched as substring of the title
      "label": "The Founders Room",  // human-readable, used in reports
      "source": "*",                 // bookmark URL to scope the ban, or "*" for global
      "banned_at": "2026-08-27",
      "why": "Paid weekly generic founder networking" }
  ]
}
```

`match` must be run through the same `normalize()` the filter uses — the `ban` subcommand does
this for you, so prefer it over editing by hand.

Helper (`events-crawl/candidates.py`), all four subcommands:

```bash
python3 candidates.py filter state.json candidates.json calendar.json > survivors.json
python3 candidates.py record state.json presented.json "add 1 2 5"
python3 candidates.py ban    state.json "<phrase>" "<label>" [source_url|*]
python3 candidates.py unskip state.json "<url or title fragment>"
```

## Common Pitfalls

- **Presenting an event Igor already ignored** — the single biggest annoyance for him. Always run
  the Step 5 `filter` before presenting, and always run the Step 7 `record` after he answers. If
  `record` is skipped, every ignored event comes back on the next crawl.
- **Recording declines for a batch he never answered** — an unanswered batch is not a rejection.
  Only `record` once he has actually replied with a selection.
- **Running `filter` without `calendar.json`** — it only applies `state.json` then, so events
  already on the calendar are offered again. The helper warns on stderr; don't ignore it.
- **Re-introducing an "added" list** — the calendar is the source of truth for that. A mirror
  goes stale and would suppress an event Igor deliberately deleted.
- **Hand-writing a `banned_series` match with digits or punctuation in it** — `normalize()` strips
  those, so the ban would never fire. Use the `ban` subcommand.
- **Re-adding a blocked organizer** — check candidates against the blocklist in Step 5 before presenting. The blocked series are recurring, so they resurface on every Eventbrite crawl.
- **Dismissing sources after a surface-level scan** — e.g. seeing only today's events on Fienta and giving up, or skipping ECB because it looks like a big table. Dig deeper!
- **Saving snapshot files to the repo root** — use the `.playwright-mcp/` folder for snapshots (Playwright's default), don't save named snapshots to the working directory. If you need to save named snapshots, use `/tmp/` or another temp folder outside the repo.
- **Forgetting to check next year** on sources like ECB that list events far in advance
- **Not including URLs in the candidate table** — user needs URLs to review events
- **Including expensive training/certification courses** as if they were community events
- Not processing ALL sources before presenting candidates
- Including non-tech events (general ticketing sites list everything)
- Not handling login walls gracefully (skip, don't crash)
- **Assuming you're not logged in** to LinkedIn/Discord — the browser session is typically already authenticated. Always try navigating first.
- Not checking calendar for duplicates before presenting
- Trying to extract full details during crawl phase (just get links + basic info, full extraction happens in add phase)
