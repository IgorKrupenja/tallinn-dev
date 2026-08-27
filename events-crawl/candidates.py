#!/usr/bin/env python3
"""Candidate memory for the events-crawl skill.

The **calendar is the source of truth for what is already added** — we do not mirror it here.
state.json only remembers the things the calendar cannot tell us:
  * declined  — offered to Igor and not picked (silence is a "no")
  * banned_series — whole recurring series / organizers to never show again

  filter  state.json candidates.json [calendar.json]  -> survivors as JSON on stdout
  record  state.json presented.json "1 2 5"           -> non-picked -> declined
  ban     state.json "<match phrase>" "<label>" [source_url|*]
  unskip  state.json "<url or title fragment>"

candidates.json : [{title, date, url, source_url, location?}]
calendar.json   : raw `gog calendar list ... --json` output (one or more pages, concatenated).
                  Pass it whenever you have it — that is what suppresses already-added events.
"""
import json, re, sys, datetime


def normalize(t):
    """Title -> match key. Drops digits, punctuation and emoji; keeps EN/ET/RU words."""
    t = (t or "").lower()
    t = re.sub(r'[#№]', ' ', t)
    t = re.sub(r'\d+', ' ', t)
    t = re.sub(r'[^\w\s]', ' ', t, flags=re.UNICODE)
    return re.sub(r'\s+', ' ', t).strip()


def norm_url(u):
    """URL -> match key. The same event shows up with utm params, /et/ vs /en/, www, trailing slash."""
    u = (u or "").strip().lower()
    u = re.sub(r'^https?://', '', u)
    u = re.sub(r'^www\.', '', u)
    u = u.split('#')[0]
    u = re.sub(r'[?&](utm_[^&]*|fbclid=[^&]*|ref=[^&]*|acontext=[^&]*)', '', u)
    u = u.rstrip('?&')
    u = re.sub(r'/(et|en|ru)(/|$)', '/', u)
    return u.rstrip('/')


def year_of(c):
    for field in (c.get('year'), c.get('date'), c.get('start')):
        if field is None:
            continue
        m = re.search(r'(20\d{2})', str(field))
        if m:
            return int(m.group(1))
    return None


def load_calendar(path):
    """Read `gog calendar list --json` output -> ({normalized urls}, {(title,year)}).

    gog emits one JSON object per page, so the file may hold several concatenated objects.
    Every event written by events-add has its URL on the first line of the description.
    """
    raw = open(path).read()
    dec, i, evs = json.JSONDecoder(), 0, []
    while i < len(raw):
        while i < len(raw) and raw[i] in ' \n\r\t':
            i += 1
        if i >= len(raw):
            break
        obj, i = dec.raw_decode(raw, i)
        evs += obj.get('events', []) if isinstance(obj, dict) else obj

    urls, keys = set(), set()
    for e in evs:
        desc = re.sub(r'<[^>]+>', '', e.get('description') or '')   # older rows are HTML
        m = re.search(r'https?://\S+', desc.split('\n')[0])
        if m:
            urls.add(norm_url(m.group(0)))
        start = e.get('start', {})
        stamp = start.get('dateTime') or start.get('date') or ''
        ym = re.match(r'(\d{4})', stamp)
        keys.add((normalize(e.get('summary')), int(ym.group(1)) if ym else None))
    return urls, keys


def do_filter(state, cands, cal=None, verbose=True):
    cal_urls, cal_keys = cal if cal else (set(), set())
    dec_urls = {norm_url(e['url']) for e in state['declined'] if e.get('url')}
    dec_keys = {(normalize(e.get('title')), year_of(e)) for e in state['declined']}
    bans = state.get('banned_series', [])

    show, hidden = [], []
    for c in cands:
        nu, nt, yr = norm_url(c.get('url')), normalize(c.get('title')), year_of(c)

        if nu and nu in cal_urls:
            hidden.append((c, 'already on calendar (url)')); continue
        if yr is not None and (nt, yr) in cal_keys:
            hidden.append((c, f'already on calendar (title+{yr})')); continue
        if nu and nu in dec_urls:
            hidden.append((c, 'declined earlier (url)')); continue
        if yr is not None and (nt, yr) in dec_keys:
            hidden.append((c, f'declined earlier (title+{yr})')); continue
        hit = next((b for b in bans
                    if (b.get('source') in ('*', c.get('source_url')))
                    and b['match'] in nt), None)
        if hit:
            hidden.append((c, f"banned series «{hit['label']}»")); continue
        show.append(c)

    if verbose:
        if cal is None:
            print('WARNING: no calendar.json passed — already-added events will NOT be '
                  'suppressed. Pass the gog calendar dump.', file=sys.stderr)
        print(f'SHOW {len(show)} / HIDE {len(hidden)}', file=sys.stderr)
        for c, why in hidden:
            print(f'  hidden: {c.get("title","?")[:60]} — {why}', file=sys.stderr)
    return show


def save(path, state):
    json.dump(state, open(path, 'w'), ensure_ascii=False, indent=2)
    print(f'wrote {path}', file=sys.stderr)


def main():
    cmd, spath = sys.argv[1], sys.argv[2]
    state = json.load(open(spath))
    today = datetime.date.today().isoformat()

    if cmd == 'filter':
        cands = json.load(open(sys.argv[3]))
        cal = load_calendar(sys.argv[4]) if len(sys.argv) > 4 else None
        print(json.dumps(do_filter(state, cands, cal), ensure_ascii=False, indent=2))

    elif cmd == 'record':
        presented = json.load(open(sys.argv[3]))
        picked = {int(t) for t in re.findall(r'\d+', sys.argv[4] if len(sys.argv) > 4 else '')}
        n = 0
        for i, c in enumerate(presented, start=1):
            if i in picked:
                continue          # approved -> the calendar becomes its record, nothing to store
            state['declined'].append({'url': c.get('url'), 'title': c.get('title'),
                                      'year': year_of(c), 'reason': 'ignored',
                                      'declined_at': today})
            n += 1
        save(spath, state)
        print(f'recorded {n} declined (ignored); {len(picked)} approved -> calendar is their record')

    elif cmd == 'ban':
        match, label = normalize(sys.argv[3]), sys.argv[4]
        source = sys.argv[5] if len(sys.argv) > 5 else '*'
        state['banned_series'].append({'match': match, 'label': label,
                                       'source': source, 'banned_at': today})
        save(spath, state)
        print(f'banned series «{label}» (match: "{match}", source: {source})')

    elif cmd == 'unskip':
        needle = sys.argv[3].lower()
        nn = norm_url(needle)
        before = len(state['declined'])
        state['declined'] = [e for e in state['declined']
                             if not ((e.get('url') and nn and nn in norm_url(e['url']))
                                     or needle in (e.get('title') or '').lower())]
        save(spath, state)
        print(f'removed {before - len(state["declined"])} declined entry(ies)')

    else:
        print(__doc__); sys.exit(1)


if __name__ == '__main__':
    main()
