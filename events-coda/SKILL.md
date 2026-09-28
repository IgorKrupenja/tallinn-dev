---
name: events-coda
description: Update and label events in the Estonia IT Events Coda database. Use when labeling events, adding missing links, or cleaning up the Coda table.
---

# Events - Coda Update Skill

Update event labels and links in the Estonia IT Events Coda table.

## Prerequisites

**ALWAYS load environment variables first:**

Note: Use `set -a && source ... && set +a` instead of `export $(grep ... | xargs)` because some env vars contain paths with spaces.

```bash
set -a && source "$(dirname "$(realpath "${SKILLS_DIR:-$HOME/.claude/skills}/events-coda")")/.env" && set +a
```

The variables live in the **repo's** `.env` (the `tallinn-dev` root, next to the skill folders),
not in `~/.claude/skills/.env`, which has no Coda variables. The skill folders are symlinks into
the repo, so `realpath` finds it from either location. For other AI tools (e.g. Cursor), export
`SKILLS_DIR` pointing at the folder that holds the skill folders before running this.

Required env vars:

- `$CODA_API_TOKEN` - Coda API authentication token
- `$CODA_DOC_ID` - Document ID
- `$CODA_TABLE_ID` - Table ID

## Workflow

### 0. Trigger Google Calendar Sync in Coda (Run This First!)

The Coda table syncs from Google Calendar, but it does not auto-refresh. You must manually trigger a sync before working with the data.

1. Open the doc **logged in**. Coda is now Superhuman Docs, and opening `coda.io/d/...` directly
   renders an anonymous view with no Refresh button. Go through the workspace first:
   ```
   browser_navigate to: https://coda.io/docs        (lands in Igor's workspace, logged in)
   browser_navigate to: https://docs.superhuman.com/d/Estonia-IT-events_dzkj730WT5a
   ```
2. Click the **Refresh** button next to the table's search icon
   (`getByRole('button', { name: 'Refresh' })`).
3. After ~40-60 s the UI says "Table last updated from Google Calendar just now". **The API lags
   the UI by about another minute**, so before reading rows, poll
   `GET https://coda.io/apis/v1/docs/$CODA_DOC_ID/tables/$CODA_TABLE_ID` until its `rowCount` or
   `updatedAt` changes.
4. Once the sync is complete, proceed to the next steps.

**Note:** There is no API-based way to trigger this sync — the browser click is the only option.

**The table mirrors Google Calendar.** To remove an event, delete it in the calendar
(`gog calendar delete "$GOOGLE_CALENDAR_ID" <eventId> --force`; deleting a recurring master
removes all instances), then Refresh. Never delete rows or set `Archived` through the API to get
rid of an event: Igor rejected that, because synced rows are driven by the calendar. Step 1's
archiving of events that already ended is the only `Archived` write.

### 1. Auto-Archive Past Events

Automatically mark past events as archived to keep the working set small:

```bash
# Get all non-archived events
QUERY=$(printf '"Archived":false' | jq -sRr @uri)

curl -s -H "Authorization: Bearer $CODA_API_TOKEN" \
  "https://coda.io/apis/v1/docs/$CODA_DOC_ID/tables/$CODA_TABLE_ID/rows?useColumnNames=true&query=$QUERY" \
  | jq -r '
    .items[]
    | select(.values.End < "'$(date -I)'")
    | {
        id: .id,
        name: .values.Name,
        end: .values.End
      }
  ' | jq -s '. | length as $count | if $count > 0 then ("Found " + ($count | tostring) + " past events to archive") else "No past events to archive" end'
```

For each past event, set Archived=true:

```bash
EVENT_ID="i-xxxxx..."

curl -s -X PUT \
  -H "Authorization: Bearer $CODA_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://coda.io/apis/v1/docs/$CODA_DOC_ID/tables/$CODA_TABLE_ID/rows/$EVENT_ID" \
  -d '{
    "row": {
      "cells": [
        {"column": "Archived", "value": true}
      ]
    }
  }' | jq '.'
```

**Note:** This keeps the API response small by filtering archived events server-side.

### 2. Fetch Events Missing Labels or Links

Get non-archived events that are missing either Labels OR Links:

```bash
# Server-side filter: only non-archived events
QUERY=$(printf '"Archived":false' | jq -sRr @uri)

curl -s -H "Authorization: Bearer $CODA_API_TOKEN" \
  "https://coda.io/apis/v1/docs/$CODA_DOC_ID/tables/$CODA_TABLE_ID/rows?useColumnNames=true&query=$QUERY" \
  | jq -r '
    .items[]
    | select(
        ((.values.Labels == "" or .values.Labels == null) or
         (.values.Link == "" or .values.Link == null))
      )
    | .values.Description as $desc
    # Coda flattens the synced Description (no newlines), so take the leading URL by regex:
    # split("\n")[0] would return the whole description.
    | ((($desc // "") | capture("^\\s*(?<u>https?://\\S+)") | .u) // "No URL") as $url
    | {
        id: .id,
        name: .values.Name,
        start: .values.Start,
        end: .values.End,
        labels: (.values.Labels // "❌ MISSING"),
        link: (.values.Link // "❌ MISSING"),
        url_in_description: $url,
        location: .values.Location,
        description: $desc
      }
  ' | jq -s '.'
```

**Server-side filtering:** Uses `"Archived":false` query to fetch only non-archived events, keeping the payload small.

**Pro tip:** Most events have the URL as the first line of description - extract and populate the Link field from there!

### 3. Fetch Available Labels

Get the current list of valid labels from Coda:

```bash
curl -s -H "Authorization: Bearer $CODA_API_TOKEN" \
  "https://coda.io/apis/v1/docs/$CODA_DOC_ID/tables/$CODA_TABLE_ID/columns" \
  | jq -r '.items[] | select(.name == "Labels") | .format.options[] | .name' | sort
```

**Only labels already in this list get saved.** Writing an unknown label returns HTTP 202 as if it
worked, but the value is silently dropped, and `format.allowNewValues` is `null`, so the column
format gives no warning. A new option has to be added in the UI: Labels column header → *Edit
column* → scroll the select-list settings to the bottom → *Add option* (done for `Hardware` on
2026-09-13). Playwright gotcha in that panel: the option fields are
`textarea[placeholder="Add text"]` and `fill()` does not register there. Send one real keystroke
with `browser_press_key`, then `pressSequentially` the rest, then blur and click away to commit
(Escape discards it). Read the row back after writing a newly added label.

### 4. Remove "🔥 New" Label (Always Run This!)

Remove "🔥 New" from events that were previously labeled (this cleans up old labels):

```bash
QUERY=$(printf '"Archived":false' | jq -sRr @uri)

# Find events with "New" in labels
curl -s -H "Authorization: Bearer $CODA_API_TOKEN" \
  "https://coda.io/apis/v1/docs/$CODA_DOC_ID/tables/$CODA_TABLE_ID/rows?useColumnNames=true&query=$QUERY" \
  | jq -r '
    .items[]
    | select(.values.Labels | contains("New"))
    | {
        id: .id,
        name: .values.Name,
        labels: .values.Labels
      }
  ' | jq -s '.'
```

For each event found, remove "🔥 New" from the labels (keep other labels):

```bash
EVENT_ID="i-xxxxx..."
# Example: if labels are "🔥 New,GameDev,Hackathon", set to "GameDev,Hackathon"
NEW_LABELS="GameDev,Hackathon"

curl -s -X PUT \
  -H "Authorization: Bearer $CODA_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://coda.io/apis/v1/docs/$CODA_DOC_ID/tables/$CODA_TABLE_ID/rows/$EVENT_ID" \
  -d "{
    \"row\": {
      \"cells\": [
        {\"column\": \"Labels\", \"value\": \"$NEW_LABELS\"}
      ]
    }
  }"
```

**Note:** This step runs EVERY time to clean up "🔥 New" labels from previous runs. Only newly labeled events in step 4 get "🔥 New" added back.

### 5. Manual Labeling Process

**⚠️ Important:**

- **DO NOT use automated keyword matching** - it produces too many false positives
- **Actually read each event description carefully**
- **Use judgment** - assign labels based on actual content, not keywords
- **ALWAYS add "🔥 New"** to the labels when labeling events that were missing labels/links

### 6. Extract URLs from Descriptions

Check the `url_in_description` field from step 1. If present, use it to populate the Link field.

### 7. Update Event Row

Update both Labels and Link fields:

```bash
# Example variables
EVENT_ID="i-xxxxx..."
LABELS="🔥 New,Startups,Hackathon"  # ALWAYS add "🔥 New" for newly labeled events
LINK="https://example.com/event"

curl -X PUT \
  -H "Authorization: Bearer $CODA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"row\": {
      \"cells\": [
        {\"column\": \"Labels\", \"value\": \"$LABELS\"},
        {\"column\": \"Link\", \"value\": \"$LINK\"}
      ]
    }
  }" \
  "https://coda.io/apis/v1/docs/$CODA_DOC_ID/tables/$CODA_TABLE_ID/rows/$EVENT_ID"
```

**Label format:**

- Multiple labels are comma-separated with NO spaces
- Example: `"🔥 New,Dev,Students,Hackathon"`

**Rate limiting:**

- Wait **2 seconds** between API calls to avoid Coda rate limiting (1 second is not enough when doing bulk updates)

## Quality Checklist

Before updating events:

- ✅ Triggered Google Calendar sync in Coda (browser Refresh) and waited for it to complete
- ✅ Environment variables sourced
- ✅ "Archived" column exists in Coda table
- ✅ Ran auto-archive step to mark past events
- ✅ Fetched available labels from Coda
- ✅ Removed "🔥 New" label from existing events (if present)
- ✅ Read event descriptions carefully
- ✅ Assigned labels based on actual content (not keywords)
- ✅ Added "🔥 New" to newly labeled events
- ✅ Extracted URLs from description first lines
- ✅ Using correct comma-separated format (no spaces)

## Common Pitfalls

❌ Not triggering Google Calendar sync before starting (data will be stale)
❌ Forgetting to run auto-archive step first
❌ Missing "Archived" column in Coda table
❌ Using keyword matching instead of reading descriptions
❌ Forgetting to add "🔥 New" to newly labeled events
❌ Wrong label format (spaces after commas)
❌ Not extracting URLs from description first lines
❌ API rate limiting (going too fast)
❌ Hardcoding IDs instead of using env vars
