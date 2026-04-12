---
name: estonia-events-crawl
description: Crawl event sources from Vivaldi bookmarks to discover new IT events in Estonia. Opens each source in browser, extracts event candidates, presents them for approval, then adds approved ones to calendar and updates Coda.
---

# Estonia IT Events - Crawl Sources Skill

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
- `$ESTONIA_EVENTS_CALENDAR_ID` - Target calendar ID
- `$GOPLACES_API_KEY` - Google Places API key
- `$CODA_API_TOKEN`, `$CODA_DOC_ID`, `$CODA_TABLE_ID` - Coda access

## Overview

1. Read event source URLs from Vivaldi bookmarks (fresh each time)
2. Open each source in browser and extract event links/info
3. Verify ALL sources were crawled (mandatory checkpoint)
4. Deduplicate against existing calendar
5. Present ALL candidates in a numbered table
6. User approves by number
7. Add approved events using `estonia-events-add` skill
8. Update Coda using `estonia-events-coda` skill

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
  - Nearby events render as `button` elements in snapshots without visible hrefs — **extract the `/url:` from the nested `link` element** (e.g. `/url: /yurdrxp2` → `https://luma.com/yurdrxp2`), or click the button to navigate
  - For **specific Luma calendars** (e.g. `luma.com/EstoniAI`), extract ALL upcoming events — these pages are small
- **Facebook groups/feeds**:
  - Feed content renders as empty `blockquote: Facebook` placeholders in accessibility snapshots — **use `browser_take_screenshot` instead** to read the feed visually
  - For pages with an Events tab, check the Events tab first (snapshots work there), then **always also check the main feed** via screenshots — some pages post event links but don't create formal FB events (e.g. EstoniaWEB3, Palo Alto Club)
  - **URL extraction**: event cards in snapshots have truncated titles but include a `link` element with `/url:` — always extract that URL. For feed posts with event links visible only in screenshots, navigate to the post to get the actual URL
- **LinkedIn feeds**:
  - For every post that mentions an event, check whether the event date is in the future
  - For company pages with an Events tab, check events first, then also scroll the posts feed
  - Snapshots generally work better than Facebook, but use `browser_take_screenshot` if content appears empty
- **K-space** (`wiki.k-space.ee`):
  - Chaostreffs is a valid recurring event (every Thursday) — check the wiki page to confirm it's still running
  - Check the calendar's recurring event RRULE and **extend the UNTIL date to ~6 months from today** if needed (use `gog calendar update` with `--rrule` and `--scope all`)
  - Also check for one-off events on the events page
- **Discord**: SPA that renders very poorly in accessibility snapshots.
  - **Use `browser_take_screenshot` instead** to read the channel visually
  - If you see an event mentioned in a screenshot, **navigate to the linked URL to confirm details** — a screenshot alone is not a substitute for having the actual event URL

## Step 3: Verify ALL Sources Were Crawled

**STOP and check before proceeding.** Go through the full bookmark list from Step 1 and confirm every single URL was visited. If ANY source was skipped — for any reason (felt noisy, seemed time-intensive, "enough candidates already", context getting long) — go back and crawl it NOW before moving on.

This is a known failure mode: after crawling 20+ sources and collecting many candidates, there is a strong temptation to skip the remaining "hard" sources (Fienta with 10+ load-more clicks, LinkedIn feeds, Discord). These are exactly the sources most likely to have unique events not found elsewhere. Do not proceed to deduplication until every source has been visited.

## Step 4: Deduplicate

After collecting all candidates, check each against the existing calendar:

```bash
set -a && source "${SKILLS_DIR:-$HOME/.claude/skills}/.env" && set +a

# Check by date range
gog calendar list "$ESTONIA_EVENTS_CALENDAR_ID" \
  --from "YYYY-MM-DDT00:00:00+02:00" \
  --to "YYYY-MM-DDT23:59:59+02:00" \
  --json
```

Compare by:

- Event name (similar match, not exact — "OpenClaw Meetup" matches "OpenClaw Meetup Tallinn")
- Start date/time (within a few minutes)
- URL in description (exact match)

Remove duplicates from the candidate list.

## Step 5: Filter

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

## Step 7: Add Approved Events

For each approved event, use the `estonia-events-add` skill flow:

1. Open the event URL in browser
2. Extract full details (click "See more" on FB, etc.)
3. Resolve location via goplaces
4. Check for duplicates (should be clean but double-check)
5. Create calendar entry

## Step 8: Update Coda

**Auto-proceed: after all approved events are added in Step 7, immediately proceed to this step without asking the user.**

After all events are added, run the `estonia-events-coda` skill to:

1. Trigger Google Calendar sync
2. Auto-archive past events
3. Label new events
4. Add missing links

## Common Pitfalls

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
