---
name: estonia-events-add
description: Add IT events to the Estonia IT Events calendar. Use when adding events from URLs (Facebook, Eventbrite, Luma, etc.) with full extraction, location resolution, and duplicate checking.
---

# Estonia IT Events - Add Event Skill

Add new events to Igor's "Estonia IT Events" Google Calendar with full content extraction and location resolution.

## Prerequisites

**ALWAYS load environment variables first:**

```bash
export $(grep -v '^#' "${SKILLS_DIR:-$HOME/.claude/skills}/.env" | xargs)
```

Required env vars:

- `$ESTONIA_EVENTS_CALENDAR_ID` - Target calendar ID
- `$GOPLACES_API_KEY` - Google Places API key

## Workflow

When a link to an event is provided:

### 0. Get Current Date/Year

**⚠️ CRITICAL: Always check the current date FIRST to avoid year errors!**

```bash
date +"%Y-%m-%d %H:%M:%S %Z"
```

Use this date as reference when parsing event dates. If an event shows "Feb 13" without a year, it means the NEXT occurrence of Feb 13 from TODAY.

### 1. Extract Full Content

Use the `browser` tool (or `web_fetch` as fallback) to get the full event description.

**⚠️ Mandatory for Facebook events:**

- ALWAYS click the "See more" button to expand the full text before extraction
- Facebook truncates descriptions by default

### 2. Strict Content Policy

- **DO NOT summarize** - use the complete original text
- **DO NOT translate** - preserve the original language
- **Keep all formatting** - preserve line breaks, emphasis, emojis, etc.

### 3. Resolve Location

If a venue name is provided, resolve it to a full address:

```bash
goplaces search "Venue Name" --api-key "$GOPLACES_API_KEY" --json
```

Use the `address` field from the result for the calendar event location.

### 4. Check for Duplicates

**Before creating the event**, check if it already exists in the calendar.

Fetch existing events for the date range:

```bash
# Fetch events for the specific date
# IMPORTANT: Use RFC3339 format with timezone, NOT date-only format
gog calendar list "$ESTONIA_EVENTS_CALENDAR_ID" \
  --from "YYYY-MM-DDT00:00:00+02:00" \
  --to "YYYY-MM-DDT23:59:59+02:00" \
  --json
```

**Note:** Date-only format (`YYYY-MM-DD`) does NOT work and returns zero results. Always use RFC3339 with timezone.

**Compare by:**

- Start time matches (within a few minutes tolerance)
- Event name matches (exact or very similar)

**If duplicate found:**

- ✅ Report: "Event already exists: [name] on [date]"
- ⛔ Do NOT create the calendar entry
- ✅ Stop workflow

**If no duplicate:**

- ✅ Proceed to step 5

### 5. Create Calendar Entry

Use `gog calendar create` with these requirements:

**Target Calendar:** MUST use `$ESTONIA_EVENTS_CALENDAR_ID`

**Description Format (MANDATORY):**

```
<EVENT_URL>

<FULL_EVENT_DESCRIPTION>
```

The first line MUST be the event URL, followed by an empty line, then the full description.

### 6. Command Template

```bash
gog calendar create "$ESTONIA_EVENTS_CALENDAR_ID" \
  --summary "Event Title" \
  --from "YYYY-MM-DDTHH:MM:SS+02:00" \
  --to "YYYY-MM-DDTHH:MM:SS+02:00" \
  --location "Full resolved address" \
  --description "https://event-url.com

Full event description text here..."
```

## Quality Checklist

Before creating the event:

- ✅ **Checked current date/year FIRST** (run `date` command)
- ✅ Environment variables sourced
- ✅ Full content extracted (no truncation)
- ✅ Original language preserved (no translation)
- ✅ Location resolved via goplaces (if venue provided)
- ✅ Checked for duplicates in calendar (by date + name)
- ✅ No duplicate found (if duplicate exists, STOP)
- ✅ Description starts with URL on first line
- ✅ Empty line after URL
- ✅ Using correct calendar ID from env var
- ✅ **Verified year is correct in all date fields**

## Common Pitfalls

❌ **NOT CHECKING CURRENT DATE FIRST** — always run `date` first to avoid year errors!
❌ Not checking for duplicates before adding
❌ Using date-only format (YYYY-MM-DD) in duplicate check — returns zero results!
❌ Forgetting to click "See more" on Facebook
❌ Summarizing or shortening the description
❌ Translating the content
❌ Not resolving the venue to a full address
❌ Wrong description format (URL not on first line)
❌ Hardcoding calendar ID instead of using env var
