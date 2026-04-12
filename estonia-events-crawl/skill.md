---
name: estonia-events-crawl
description: Crawl event sources from Vivaldi bookmarks to discover new IT events in Estonia. Opens each source in browser, extracts event candidates, presents them for approval, then adds approved ones to calendar and updates Coda.
---

# Estonia IT Events - Crawl Sources Skill

Discover new IT events by crawling bookmarked event sources. Extracts candidates, deduplicates against the calendar, and presents a batch for user approval.

## Prerequisites

**ALWAYS load environment variables first:**

```bash
export $(grep -v '^#' "${SKILLS_DIR:-$HOME/.claude/skills}/.env" | xargs)
```

Required env vars (same as add/coda skills):

- `$ESTONIA_EVENTS_CALENDAR_ID` - Target calendar ID
- `$GOPLACES_API_KEY` - Google Places API key
- `$CODA_API_TOKEN`, `$CODA_DOC_ID`, `$CODA_TABLE_ID` - Coda access

## Overview

1. Read event source URLs from Vivaldi bookmarks (fresh each time)
2. Open each source in browser and extract event links/info
3. Deduplicate against existing calendar
4. Present ALL candidates in a numbered table
5. User approves by number
6. Add approved events using `estonia-events-add` skill
7. Update Coda using `estonia-events-coda` skill
8. Save crawl state

## Step 0: Load State

State file: `${SKILLS_DIR:-$HOME/.claude/skills}/estonia-events-crawl/crawl-state.json`

```json
{
  "sources": {
    "https://example.com/events": {
      "last_crawl": "2026-03-18",
      "last_event_date": "2026-03-15"
    }
  }
}
```

If the file doesn't exist, create it with empty `sources: {}`. The `last_event_date` field is used for sources with chronological feeds (e.g., Facebook) to know when to stop scrolling.

## Step 1: Read Bookmarks

**Read fresh from Vivaldi each time** — the bookmark list is not static, the user adds/removes sources between runs.

```bash
jq -r '
  .roots.bookmark_bar.children[]
  | select(.name == "talllinn.dev")
  | .children[]
  | select(.name == "Sources")
  | .children[]
  | .url
' "$HOME/Library/Application Support/Vivaldi/Default/Bookmarks"
```

## Step 2: Crawl Each Source

For each bookmark URL, open it in the browser and figure out what's on the page. Don't rely on hardcoded per-site logic — read the snapshot and extract events based on what you see.

**Collect ALL candidates across ALL sources before presenting to user.**

Keep a running list of candidates:

```
candidate = { title, date, url, source_url, location (if available) }
```

### General approach for every source

1. Navigate to the URL in browser
2. Handle cookie banners / popups (dismiss them)
3. Take a snapshot
4. Look for event listings: titles with dates, links to event detail pages
5. Extract future events — ignore past ones
6. If the page has pagination or "load more", scroll/click to get more (see limits below)
7. If a login wall blocks content (LinkedIn, Discord), skip the source and note it

### What to look for in snapshots

- Links containing `/events/`, `/event/`, or pointing to known event platforms (luma.com, eventbrite.com, fienta.com, meetup.com, facebook.com/events)
- Date patterns near link text (e.g., "Mar 26", "26.03.2026", "Thursday 2 April")
- Event card patterns: heading + date + location grouped together
- For social feeds (FB groups, LinkedIn posts): scan posts for shared event links

### Pagination and scrolling limits

**IMPORTANT: Do NOT dismiss sources after a surface-level scan. Be thorough — paginate, scroll, and dig into each source.**

- **Default**: Extract what's visible on the first page load. If there's a clear "Show more" or pagination, go up to 3 pages deep.
- **Eventbrite** (`eventbrite.com`): Paginate through **at least 4 pages** of results. Stop when you start seeing only Helsinki/Finland events. **Ignore paid online courses/workshops** (e.g. ISTQB certification courses costing €1000+). Paid conferences (at any price) are fine if they're real community events.
- **ECB** (`ecb.ee/calendar`): This is a goldmine of tech conferences. Scan the full table for tech keywords (cyber, digital, AI, startup, blockchain, fintech, smart, IoT, cloud, etc.). **Check ALL future years available in the year dropdown** — use the year dropdown at the top of the page and click the search button to switch years. ECB lists events years in advance (2027, 2028, etc.). The goal is to have as many events as possible in the calendar, even far ahead. When unsure if an event fits, open its detail page to investigate.
- **Fienta** (`fienta.com`): Click "Load more" **at least 10 times** to see events up to 2 weeks out. The first page only shows today's events. Scan all loaded events for tech relevance — there are tech events mixed in among cultural ones.
- **Luma general/discovery pages** (`luma.com/tech`, `luma.com/discover`): Only look at events **within the next 2 weeks** — these pages list global events and get very long.
- **Facebook groups/feeds**: Scroll down but stop at `last_event_date` from crawl state, or at most 10 scroll iterations if no state exists.
- **LinkedIn feeds**: Scroll at most 5 times — these are noisy and most event links appear in recent posts.
- **K-space** (`wiki.k-space.ee`): Chaostreffs is a valid recurring event (every Thursday). Ensure it's in the calendar up to ~6 months out. Also check for one-off events on the events page.

### Handling login walls

If a page requires login and you're not logged in:

- **Facebook**: Try to extract what's visible without login (event pages often show basic info). If fully blocked, skip.
- **LinkedIn**: Will need login. If not logged in, skip and note it. User will log in for next run.
- **Discord**: Requires login. Skip and note it if not logged in.

Don't ask the user to log in during the crawl — just skip and report at the end.

## Step 3: Deduplicate

After collecting all candidates, check each against the existing calendar:

```bash
export $(grep -v '^#' "${SKILLS_DIR:-$HOME/.claude/skills}/.env" | xargs)

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

## Step 4: Filter

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

Remove events about:

- Pure business/marketing with no tech angle
- Concerts, theatre, sports, cooking
- Non-tech networking
- Job fairs that aren't tech-specific
- **Paid training courses** (e.g. ISTQB certification at €1000+, professional certification programs). Paid conferences (at any price) are fine if they're real community/industry events.
- **Paid online-only events** listed on Eventbrite or similar — only include in-person or hybrid events in Estonia

**When in doubt, INCLUDE the candidate** — the user will make the final call.

## Step 5: Present Candidates

After ALL sources have been crawled, present the full candidate list as a numbered table:

```
| # | Event | Date | Location | Source |
|---|-------|------|----------|--------|
| 1 | AI Meetup Tallinn | Apr 15, 18:00 | LIFT99 | luma.com |
| 2 | Startup Pitch Night | Apr 20, 17:00 | Tehnopol | tehnopol.ee |
| ... | ... | ... | ... | ... |
```

Also note:

- Any sources that were skipped (login required, page errors, etc.)
- Total sources crawled vs skipped

Format:

```
| # | Event | Date | Location | URL | Source |
|---|-------|------|----------|-----|--------|
| 1 | ... | ... | ... | https://... | ... |

⚠️ Skipped sources (login required):
- linkedin.com/company/foundmeio/events/ — not logged in
- discord.com/channels/... — not logged in

✅ Crawled: 27/30 sources | ⏭️ Skipped: 3
```

Then ask: **"Which events to add? (e.g., 1,3,5-8,all)"**

## Step 6: Add Approved Events

For each approved event, use the `estonia-events-add` skill flow:

1. Open the event URL in browser
2. Extract full details (click "See more" on FB, etc.)
3. Resolve location via goplaces
4. Check for duplicates (should be clean but double-check)
5. Create calendar entry

## Step 7: Update Coda

After all events are added, run the `estonia-events-coda` skill to:

1. Trigger Google Calendar sync
2. Auto-archive past events
3. Label new events
4. Add missing links

## Step 8: Save State

Update `crawl-state.json` with:

- `last_crawl` date for each source that was successfully crawled
- `last_event_date` for chronological sources (latest event date seen)

```bash
# Write updated state
cat > "${SKILLS_DIR:-$HOME/.claude/skills}/estonia-events-crawl/crawl-state.json" << 'EOF'
{
  "sources": {
    "https://...": {
      "last_crawl": "2026-03-18",
      "last_event_date": "2026-04-15"
    }
  }
}
EOF
```

## Common Pitfalls

- **Dismissing sources after a surface-level scan** — e.g. seeing only today's events on Fienta and giving up, or skipping ECB because it looks like a big table. Dig deeper!
- **Saving snapshot files to the repo root** — use the `.playwright-mcp/` folder for snapshots (Playwright's default), don't save named snapshots to the working directory
- **Forgetting to check next year** on sources like ECB that list events far in advance
- **Not including URLs in the candidate table** — user needs URLs to review events
- **Including expensive training/certification courses** as if they were community events
- Not processing ALL sources before presenting candidates
- Including non-tech events (general ticketing sites list everything)
- Not handling login walls gracefully (skip, don't crash)
- Forgetting to update crawl state after successful run
- Not checking calendar for duplicates before presenting
- Trying to extract full details during crawl phase (just get links + basic info, full extraction happens in add phase)
- Spending too long on discovery pages (respect the pagination/scroll limits)
- Hardcoding source-specific logic instead of reading what's on the page
