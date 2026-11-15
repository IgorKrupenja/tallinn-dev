#!/usr/bin/env bun
/**
 * Candidate memory for the events-crawl skill.
 *
 * The **calendar is the source of truth for what is already added**, so it isn't mirrored here.
 * state.json only remembers the things the calendar cannot tell us:
 *   - declined: offered to Igor and not picked (silence is a "no")
 *   - banned_series: whole recurring series or organizers to never show again
 *
 * The commands and file formats are in USAGE below, which is also printed on a bad command.
 */

const USAGE = `\
usage:
  candidates.ts filter  state.json candidates.json [calendar.json]  -> survivors as JSON on stdout
  candidates.ts record  state.json presented.json "1 2 5"           -> non-picked -> declined
  candidates.ts ban     state.json "<match phrase>" "<label>" [source_url|*]
  candidates.ts unskip  state.json "<url or title fragment>"

candidates.json: [{title, date, url, source_url, location?}]
calendar.json:   raw \`gws calendar events list ... --page-all\` output (one JSON object per page,
                 one after another; old \`gog calendar list --json\` dumps work too).
                 Pass it whenever you have it: that is what suppresses already-added events.`;

/** A crawled event. Fields other than these pass through untouched. */
type Candidate = {
  title?: string | null;
  url?: string | null;
  source_url?: string | null;
  year?: unknown;
  date?: unknown;
  start?: unknown;
};

/** An event offered and not picked, or (added by hand) an alias of an event on the calendar. */
type Declined = {
  url?: string | null;
  title?: string | null;
  year?: number | null;
  reason?: string;
  declined_at?: string;
  note?: string;
};

/** A whole series to hide: `match` is a normalized phrase, `source` a bookmark URL or "*" for all. */
type Ban = { match: string; label: string; source?: string | null; banned_at?: string; why?: string };

type State = { declined: Declined[]; banned_series?: Ban[] };

/** The fields of a Google Calendar event read here. */
type CalendarEvent = {
  summary?: string | null;
  description?: string | null;
  start?: { dateTime?: string; date?: string } | null;
};

/** One page of a calendar dump: gws keeps the events in `items`, gog kept them in `events`. */
type CalendarPage = CalendarEvent[] | { items?: CalendarEvent[]; events?: CalendarEvent[] };

/** What is already on the calendar: normalized event URLs and title+year keys. */
type Calendar = { urls: Set<string>; keys: Set<string> };

/** Title -> match key. Drops digits, punctuation and emoji; keeps EN/ET/RU words. */
function normalize(title: string | null | undefined): string {
  return (title || "")
    .toLowerCase()
    .replace(/[#№]/g, " ")
    .replace(/\p{Nd}+/gu, " ") // digits of any script
    .replace(/[^\p{L}\p{N}_\s]/gu, " ") // keep letters, numbers and "_" of any script
    .replace(/\s+/g, " ")
    .trim();
}

/** URL -> match key. The same event shows up with utm params, /et/ vs /en/, www, trailing slash. */
function normUrl(url: string | null | undefined): string {
  return (url || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("#")[0]!
    .replace(/[?&](utm_[^&]*|fbclid=[^&]*|ref=[^&]*|acontext=[^&]*)/g, "")
    .replace(/[?&]+$/, "")
    .replace(/\/(et|en|ru)(\/|$)/g, "/")
    .replace(/\/+$/, "");
}

/** The first 20xx year in an entry's year, date or start field, looked for in that order. */
function yearOf(entry: { year?: unknown; date?: unknown; start?: unknown }): number | null {
  for (const field of [entry.year, entry.date, entry.start]) {
    if (field === null || field === undefined) continue;
    const year = /20\d{2}/.exec(typeof field === "object" ? JSON.stringify(field) : String(field));
    if (year) return Number(year[0]);
  }
  return null;
}

/** The Set key for a normalized title and its year. */
const titleYear = (title: string, year: number | null) => JSON.stringify([title, year]);

/** The first n characters of text, counted in code points so an emoji is never cut in half. */
const firstChars = (text: string, n: number) => [...text].slice(0, n).join("");

/**
 * Read a calendar dump: the URLs and title+year keys of the events on the calendar.
 *
 * gws writes one JSON object per page, so the file may hold several objects one after another.
 * Every event written by events-add has its URL on the first line of the description.
 */
async function loadCalendar(path: string): Promise<Calendar> {
  const { values, done } = Bun.JSONL.parseChunk(await Bun.file(path).text());
  if (!done) throw new SyntaxError(`${path} isn't a calendar dump (JSON objects one after another)`);
  const events = (values as CalendarPage[]).flatMap(page =>
    Array.isArray(page) ? page : (page.items ?? page.events ?? []),
  );

  const urls = new Set<string>();
  const keys = new Set<string>();
  for (const event of events) {
    const description = (event.description || "").replace(/<[^>]+>/g, ""); // older rows are HTML
    const url = /https?:\/\/\S+/.exec(description.split("\n")[0]!);
    if (url) urls.add(normUrl(url[0]));
    const start = event.start ?? {};
    const year = /^\d{4}/.exec(start.dateTime || start.date || "");
    keys.add(titleYear(normalize(event.summary), year ? Number(year[0]) : null));
  }
  return { urls, keys };
}

/** The candidates to show. Says on stderr which ones are hidden and why. */
function filterCandidates(state: State, candidates: Candidate[], calendar: Calendar | null): Candidate[] {
  const added = calendar ?? { urls: new Set<string>(), keys: new Set<string>() };
  const declinedUrls = new Set(state.declined.filter(e => e.url).map(e => normUrl(e.url)));
  const declinedKeys = new Set(state.declined.map(e => titleYear(normalize(e.title), yearOf(e))));
  const bans = state.banned_series ?? [];

  /** Why a candidate is hidden, or null to show it. */
  function hiddenBecause(candidate: Candidate): string | null {
    const url = normUrl(candidate.url);
    const title = normalize(candidate.title);
    const year = yearOf(candidate);
    if (url && added.urls.has(url)) return "already on calendar (url)";
    if (year !== null && added.keys.has(titleYear(title, year))) return `already on calendar (title+${year})`;
    if (url && declinedUrls.has(url)) return "declined earlier (url)";
    if (year !== null && declinedKeys.has(titleYear(title, year))) return `declined earlier (title+${year})`;
    const sources = ["*", candidate.source_url ?? null];
    const ban = bans.find(b => sources.includes(b.source ?? null) && title.includes(b.match));
    return ban ? `banned series «${ban.label}»` : null;
  }

  const show: Candidate[] = [];
  const hidden: string[] = [];
  for (const candidate of candidates) {
    const why = hiddenBecause(candidate);
    if (why) hidden.push(`  hidden: ${firstChars(candidate.title ?? "?", 60)} [${why}]`);
    else show.push(candidate);
  }

  if (!calendar) {
    console.error(
      "WARNING: no calendar.json passed, so already-added events will NOT be suppressed. " +
        "Pass the gws calendar dump.",
    );
  }
  console.error(`SHOW ${show.length} / HIDE ${hidden.length}`);
  for (const line of hidden) console.error(line);
  return show;
}

/** Write state.json the way it has always been written: 2-space indent, no newline at the end. */
async function save(path: string, state: State): Promise<void> {
  await Bun.write(path, JSON.stringify(state, null, 2));
  console.error(`wrote ${path}`);
}

function usage(): number {
  console.log(USAGE);
  return 1;
}

async function main(args: string[]): Promise<number> {
  const [command, statePath, ...rest] = args;
  if (!command || !statePath) return usage();
  const state: State = await Bun.file(statePath).json();
  const today = Temporal.Now.plainDateISO().toString(); // the local date, YYYY-MM-DD

  switch (command) {
    case "filter": {
      const [candidatesPath, calendarPath] = rest;
      if (!candidatesPath) return usage();
      const candidates: Candidate[] = await Bun.file(candidatesPath).json();
      const calendar = calendarPath === undefined ? null : await loadCalendar(calendarPath);
      console.log(JSON.stringify(filterCandidates(state, candidates, calendar), null, 2));
      return 0;
    }

    case "record": {
      const [presentedPath, answer = ""] = rest;
      if (!presentedPath) return usage();
      const presented: Candidate[] = await Bun.file(presentedPath).json();
      const picked = new Set((answer.match(/\d+/g) ?? []).map(Number));
      // Picked ones need no entry: once added, the calendar is their record.
      const ignored = presented.filter((_, i) => !picked.has(i + 1));
      for (const c of ignored) {
        state.declined.push({
          url: c.url ?? null,
          title: c.title ?? null,
          year: yearOf(c),
          reason: "ignored",
          declined_at: today,
        });
      }
      await save(statePath, state);
      console.log(`recorded ${ignored.length} declined (ignored); ${picked.size} approved -> calendar is their record`);
      return 0;
    }

    case "ban": {
      const [phrase, label, source = "*"] = rest;
      if (phrase === undefined || label === undefined) return usage();
      const match = normalize(phrase);
      (state.banned_series ??= []).push({ match, label, source, banned_at: today });
      await save(statePath, state);
      console.log(`banned series «${label}» (match: "${match}", source: ${source})`);
      return 0;
    }

    case "unskip": {
      const [fragment] = rest;
      if (fragment === undefined) return usage();
      const needle = fragment.toLowerCase();
      const needleUrl = normUrl(needle);
      const before = state.declined.length;
      state.declined = state.declined.filter(
        e =>
          !(
            (e.url && needleUrl && normUrl(e.url).includes(needleUrl)) ||
            (e.title || "").toLowerCase().includes(needle)
          ),
      );
      await save(statePath, state);
      console.log(`removed ${before - state.declined.length} declined entry(ies)`);
      return 0;
    }

    default:
      return usage();
  }
}

process.exitCode = await main(Bun.argv.slice(2));
