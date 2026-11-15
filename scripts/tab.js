// The code tab.ts runs in the browser. `playwright-cli run-code` evaluates this file as one
// function expression and calls it with whichever tab is current. Before that, tab.ts fills in the
// two placeholders below: the call's arguments as JSON, and in `run` mode the caller's
// `async (p, env) => {...}` code. The arguments are one of:
//
//   { mode: 'open', url }               open a background tab and load url
//   { mode: 'run', tid, tag, shots }    run the caller's code in tab tid
//   { mode: 'close', tids }             close these tabs
//
// A tid is Chrome's target id for a tab, which, unlike its URL, stays the same across navigations.
// The returned object reaches tab.ts as JSON.
async page => {
  const { mode, url, tid, tag, shots, tids } = __ARGS__;
  const ctx = page.context();

  async function targetId(tab) {
    const cdp = await ctx.newCDPSession(tab);
    try {
      return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  async function findTab(id) {
    for (const tab of ctx.pages()) {
      try {
        if ((await targetId(tab)) === id) return tab;
      } catch {}
    }
    return null;
  }

  async function openTab() {
    // ctx.newPage() would open a foreground tab, pulling Chrome in front of the user's other apps.
    const cdp = await ctx.newCDPSession(page);
    const { targetId: newId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      background: true,
    });
    await cdp.detach().catch(() => {});
    let tab = null;
    for (let i = 0; i < 50 && !tab; i++) {
      tab = await findTab(newId);
      if (!tab) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!tab) return { ok: false, error: 'the new background tab did not appear' };
    try {
      await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      return { ok: true, tid: newId, url: tab.url(), warning: String(e).slice(0, 300) };
    }
    return { ok: true, tid: newId, url: tab.url(), result: await tab.title() };
  }

  async function runInTab() {
    const tab = await findTab(tid);
    if (!tab) return { ok: false, gone: true, error: 'tab not found: it was closed' };
    const body = (__BODY__);
    let result = null;
    let error = null;
    try {
      result = await body(tab, { shots, tag });
    } catch (e) {
      error = String(e?.stack || e).split('\n').slice(0, 4).join('\n');
    }
    await tab.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { ok: !error, error, tid, url: tab.url(), result };
  }

  async function closeTabs() {
    let closed = 0;
    for (const id of tids) {
      const tab = await findTab(id);
      if (tab) {
        await tab.close();
        closed++;
      }
    }
    return { ok: true, closed };
  }

  const handlers = { open: openTab, run: runInTab, close: closeTabs };
  return await handlers[mode]();
}
