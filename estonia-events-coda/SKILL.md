---
name: estonia-events-coda
description: Update and label events in the Estonia IT Events Coda database. Use when labeling events, adding missing links, or cleaning up the Coda table.
---

# Estonia IT Events - Coda Update Skill

Update event labels and links in the Estonia IT Events Coda table.

## Prerequisites

**ALWAYS load environment variables first:**

```bash
export $(grep -v '^#' "$HOME/.claude/skills/.env" | xargs)
```

Note: Uses `$HOME` so it works regardless of which directory Claude Code is opened from.

Required env vars:

- `$CODA_API_TOKEN` - Coda API authentication token
- `$CODA_DOC_ID` - Document ID
- `$CODA_TABLE_ID` - Table ID

## Workflow

### 0. Auto-Archive Past Events (Run This First!)

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

### 1. Fetch Events Missing Labels or Links

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
    | ($desc | split("\n")[0]) as $firstLine
    | {
        id: .id,
        name: .values.Name,
        start: .values.Start,
        end: .values.End,
        labels: (.values.Labels // "❌ MISSING"),
        link: (.values.Link // "❌ MISSING"),
        url_in_description: (if ($firstLine | test("^https?://")) then $firstLine else "No URL" end),
        location: .values.Location,
        description: $desc
      }
  ' | jq -s '.'
```

**Server-side filtering:** Uses `"Archived":false` query to fetch only non-archived events, keeping the payload small.

**Pro tip:** Most events have the URL as the first line of description - extract and populate the Link field from there!

### 2. Fetch Available Labels

Get the current list of valid labels from Coda:

```bash
curl -s -H "Authorization: Bearer $CODA_API_TOKEN" \
  "https://coda.io/apis/v1/docs/$CODA_DOC_ID/tables/$CODA_TABLE_ID/columns" \
  | jq -r '.items[] | select(.name == "Labels") | .format.options[] | .name' | sort
```

### 3. Remove "🔥 New" Label (Always Run This!)

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

### 4. Manual Labeling Process

**⚠️ Important:**

- **DO NOT use automated keyword matching** - it produces too many false positives
- **Actually read each event description carefully**
- **Use judgment** - assign labels based on actual content, not keywords
- **ALWAYS add "🔥 New"** to the labels when labeling events that were missing labels/links

### 5. Extract URLs from Descriptions

Check the `url_in_description` field from step 1. If present, use it to populate the Link field.

### 6. Update Event Row

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

- Wait 1-2 seconds between API calls to be nice to Coda

## Quality Checklist

Before updating events:

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

❌ Forgetting to run auto-archive step first
❌ Missing "Archived" column in Coda table
❌ Using keyword matching instead of reading descriptions
❌ Forgetting to add "🔥 New" to newly labeled events
❌ Wrong label format (spaces after commas)
❌ Not extracting URLs from description first lines
❌ API rate limiting (going too fast)
❌ Hardcoding IDs instead of using env vars
