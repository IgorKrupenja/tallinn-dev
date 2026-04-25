# tallinn-dev

AI agent skills that power [tallinn.dev](https://www.tallinn.dev) — the [Estonia IT events calendar](https://calendar.google.com/calendar/embed?src=9d3f200d21bdcefd62afd208681817ebf5876ec5557ea99d1794fbe3b1f24f2e%40group.calendar.google.com). They crawl bookmarked sources for new events, add them to Google Calendar with full content and resolved venues, and intelligently label them via Coda API. 

Uses the common [Agent Skills](https://agentskills.io/home) format supported by Claude Code, Cursor, Gemini CLI, Codex, OpenClaw and others.

## Prerequisites

- CLI tools [`gog`](https://gogcli.sh), [`jq`](https://jqlang.org), [`goplaces`](https://github.com/steipete/goplaces).
- A Chromium-based browser with a bookmarks folder of event sources.

## Setup

1. Clone this repo into a folder your agentic AI tool uses for skills.
2. Run `cp .env.example .env` and fill in your values in the `.env` file.

## Skills

### events-crawl

Crawl bookmarked event sources (FB groups, Eventbrite, ECB, Fienta, Luma, LinkedIn, Discord, etc.) to discover new IT events in Estonia. Deduplicates against the calendar, presents candidates for approval, then chains into the add and Coda skills.

| Variable                     | Description                                          |
| ---------------------------- | ---------------------------------------------------- |
| `BOOKMARKS_FILE`             | Path to your Chromium-based browser's bookmarks JSON |
| `BOOKMARKS_FOLDER`           | Folder path inside the bookmarks tree                |
| `ESTONIA_EVENTS_CALENDAR_ID` | Target Google Calendar ID                            |
| `GOPLACES_API_KEY`           | Google Places API key for venue resolution           |
| `CODA_API_TOKEN`             | Coda API authentication token                        |
| `CODA_DOC_ID`                | Coda document ID                                     |
| `CODA_TABLE_ID`              | Coda table ID                                        |

### events-add

Add tech events to the calendar from any URL with full content extraction, venue resolution, and duplicate checking.

| Variable                     | Description                                |
| ---------------------------- | ------------------------------------------ |
| `ESTONIA_EVENTS_CALENDAR_ID` | Target Google Calendar ID                  |
| `GOPLACES_API_KEY`           | Google Places API key for venue resolution |

### events-coda

Label and maintain the events database in Coda — auto-archive past events, populate missing labels and links from descriptions.

| Variable         | Description                   |
| ---------------- | ----------------------------- |
| `CODA_API_TOKEN` | Coda API authentication token |
| `CODA_DOC_ID`    | Coda document ID              |
| `CODA_TABLE_ID`  | Coda table ID                 |

## Security disclaimer

All secrets should be in env variables. Please check skills content and run them at your own risk.
