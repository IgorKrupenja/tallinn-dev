# tallinn-dev

AI agent skills that power [tallinn.dev](https://www.tallinn.dev), the [Estonia IT events calendar](https://calendar.google.com/calendar/embed?src=9d3f200d21bdcefd62afd208681817ebf5876ec5557ea99d1794fbe3b1f24f2e%40group.calendar.google.com). They crawl bookmarked sources for new events, add them to Google Calendar with full content and resolved venues, and intelligently label them via Coda API.

Uses the common [Agent Skills](https://agentskills.io/home) format supported by Claude Code, Cursor, Gemini CLI, Codex, OpenClaw and others.

## Prerequisites

- [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`, or `brew install oven-sh/bun/bun`.
- [Google Chrome](https://www.google.com/chrome/), for the browser.
- CLI tools [`jq`](https://jqlang.org) and `curl` (preinstalled on macOS).
- A Chromium-based browser with a bookmarks folder of event sources.

## Setup

1. Run `bun install`.
2. Run `cp .env.example .env` and fill in your values in the `.env` file. The skills find this repo at `$TALLINN_DEV_ROOT`, `~/Projects/tallinn-dev` by default: if you cloned it somewhere else, set that variable in your shell environment.
3. Sign gws in once to the Google account that owns the calendar, with Calendar access. It needs an OAuth client (a Desktop app) in `~/.config/gws/client_secret.json`, as the [gws README](https://github.com/googleworkspace/cli) explains:

   ```bash
   bun node_modules/skills-kit/src/gws.ts auth login --scopes 'openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/calendar'
   ```

4. The skills share one persistent Chrome profile that belongs to this repo: the playwright-cli in `node_modules` names its browser `tallinn-dev` (after the package) and keeps its logins apart from any other playwright-cli on the machine. Start it with `bun node_modules/skills-kit/src/browser.ts open --headed` and sign in to the sources that need it (Facebook, LinkedIn, Luma and so on) once.

The scripts are TypeScript run by Bun; `bun run typecheck` checks them. The skills reach the browser through [skills-kit](https://github.com/IgorKrupenja/skills-kit)'s `browser.ts` (any playwright-cli command) and `tab.ts` (a background tab per caller, so parallel chats don't collide), and Google Calendar through its `gws.ts`. `events-crawl/candidates.ts` and `check_links.ts` are the crawl's helpers.

## Skills

### events-crawl

Crawl bookmarked event sources (FB groups, Eventbrite, ECB, Fienta, Luma, LinkedIn, Discord, etc.) to discover new IT events in Estonia. Deduplicates against the calendar, presents candidates for approval, then chains into the [add](#events-add) and [Coda](#events-coda) skills.

| Variable                     | Description                                          |
| ---------------------------- | ---------------------------------------------------- |
| `BOOKMARKS_FILE`             | Path to your Chromium-based browser's bookmarks JSON |
| `BOOKMARKS_FOLDER`           | Folder path inside the bookmarks tree                |
| `GOOGLE_CALENDAR_ID`         | Target Google Calendar ID                            |
| `GOOGLE_PLACES_API_KEY`      | Google Places API key for venue resolution           |
| `CODA_API_TOKEN`             | Coda API authentication token                        |
| `CODA_DOC_ID`                | Coda document ID                                     |
| `CODA_TABLE_ID`              | Coda table ID                                        |

### events-add

Add tech events to the calendar from any URL with full content extraction, venue resolution, and duplicate checking.

| Variable                     | Description                                |
| ---------------------------- | ------------------------------------------ |
| `GOOGLE_CALENDAR_ID`         | Target Google Calendar ID                  |
| `GOOGLE_PLACES_API_KEY`      | Google Places API key for venue resolution |

### events-coda

Label and maintain the events database in Coda: auto-archive past events, populate missing labels and links from descriptions.

| Variable         | Description                   |
| ---------------- | ----------------------------- |
| `CODA_API_TOKEN` | Coda API authentication token |
| `CODA_DOC_ID`    | Coda document ID              |
| `CODA_TABLE_ID`  | Coda table ID                 |

## Security disclaimer

All secrets should be in env variables. Please check skills content and run them at your own risk.
