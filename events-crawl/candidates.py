#!/usr/bin/env python3
"""Candidate memory for the events-crawl skill.

  filter  state.json candidates.json   -> print SHOW/HIDE, write shown list to stdout as JSON
  record  state.json presented.json "1 2 5"  -> approved -> added, the rest -> declined (reason: ignored)
  ban     state.json "<match phrase>" "<label>" [source_url|*]
  unskip  state.json "<url or title fragment>"

Candidate shape: {title, date, url, source_url, location?}
`date` may be "2026-09-17", "2026-09-17T18:00", or "17-19 October 2026" - only the year is used.
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
    """URL -> match key. Same event often appears with utm params, /et/ vs /en/, www, trailing slash."""
    u = (u or "").strip().lower()
    u = re.sub(r'^https?://', '', u)
    u = re.sub(r'^www\.', '', u)
    u = u.split('#')[0]
    u = re.sub(r'[?&](utm_[^&]*|fbclid=[^&]*|ref=[^&]*|acontext=[^&]*)', '', u)
    u = u.rstrip('?&')
    u = re.sub(r'/(et|en|ru)(/|$)', '/', u)       # language prefixes
    return u.rstrip('/')


def year_of(c):
    for field in (c.get('year'), c.get('date'), c.get('start')):
        if field is None:
            continue
        m = re.search(r'(20\d{2})', str(field))
        if m:
            return int(m.group(1))
    return None


def key_of(e):
    return (normalize(e.get('title')), year_of(e))


def do_filter(state, cands, verbose=True):
    seen_urls = {norm_url(e['url']) for e in state['added'] + state['declined'] if e.get('url')}
    seen_keys = {key_of(e) for e in state['added'] + state['declined']}
    bans = state.get('banned_series', [])

    show, hidden = [], []
    for c in cands:
        nu = norm_url(c.get('url'))
        if nu and nu in seen_urls:
            hidden.append((c, 'already added/declined (url)')); continue
        k = key_of(c)
        if k[1] is not None and k in seen_keys:
            hidden.append((c, f'already added/declined (title+{k[1]})')); continue
        nt = normalize(c.get('title'))
        hit = next((b for b in bans
                    if (b.get('source') in ('*', c.get('source_url')))
                    and b['match'] in nt), None)
        if hit:
            hidden.append((c, f"banned series «{hit['label']}»")); continue
        show.append(c)

    if verbose:
        print(f'SHOW {len(show)} / HIDE {len(hidden)}', file=sys.stderr)
        for c, why in hidden:
            print(f'  hidden: {c.get("title","?")[:60]} — {why}', file=sys.stderr)
    return show


def save(path, state):
    json.dump(state, open(path, 'w'), ensure_ascii=False, indent=2)
    print(f'wrote {path}', file=sys.stderr)


def main():
    cmd = sys.argv[1]
    spath = sys.argv[2]
    state = json.load(open(spath))
    today = datetime.date.today().isoformat()

    if cmd == 'filter':
        cands = json.load(open(sys.argv[3]))
        print(json.dumps(do_filter(state, cands), ensure_ascii=False, indent=2))

    elif cmd == 'record':
        presented = json.load(open(sys.argv[3]))
        picked = set()
        for tok in re.findall(r'\d+', sys.argv[4] if len(sys.argv) > 4 else ''):
            picked.add(int(tok))
        added = declined = 0
        for i, c in enumerate(presented, start=1):
            entry = {'url': c.get('url'), 'title': c.get('title'), 'year': year_of(c)}
            if i in picked:
                entry['added_at'] = today
                state['added'].append(entry); added += 1
            else:
                entry['reason'] = 'ignored'; entry['declined_at'] = today
                state['declined'].append(entry); declined += 1
        save(spath, state)
        print(f'recorded: {added} added, {declined} declined (ignored)')

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
