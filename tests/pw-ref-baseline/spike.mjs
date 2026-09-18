// Empirically probe Playwright's ref model against the failure modes pi-control-chrome hit.
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const PAGE = `<!doctype html><html><body>
<h1>Ref probe</h1>
<button id="stable">Save</button>
<button id="rename">Rename</button>
<button id="swap">Swap</button>
<button id="route">Route</button>
<button id="nav">Navigate</button>
<button id="hidden" style="display:none">Hidden</button>
<button id="disabled" disabled>Disabled</button>
<div id="late-slot"></div>
<div id="delayed-slot"></div>
<script>
  document.getElementById('rename').addEventListener('click', e => { e.currentTarget.textContent = 'Renamed'; });
  document.getElementById('swap').addEventListener('click', e => {
    const old = e.currentTarget;
    const fresh = document.createElement('button');
    fresh.id = 'swap'; fresh.textContent = 'Swap';
    old.replaceWith(fresh);
  });
  document.getElementById('route').addEventListener('click', () => {
    history.pushState({}, '', '/route-a');
    const m = document.createElement('div'); m.id = 'route-marker'; m.textContent = 'route a';
    document.body.appendChild(m);
  });
  document.getElementById('nav').addEventListener('click', () => { location.href = '/second'; });
  setTimeout(() => { const b = document.createElement('button'); b.id = 'delayed'; b.textContent = 'Delayed Target'; document.getElementById('delayed-slot').appendChild(b); }, 2500);
  setTimeout(() => { const b = document.createElement('button'); b.id = 'late'; b.textContent = 'Late Target'; document.getElementById('late-slot').appendChild(b); }, 4000);
</script>
</body></html>`;

const SECOND = `<!doctype html><html><body><h1>Second</h1><button id="second-btn">Second</button></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/second' ? SECOND : PAGE);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const rec = (id, value) => console.log(`[${id}] ${value}`);
const firstLine = e => String(e && e.message || e).split('\n')[0];

const refMap = snap => {
  const map = {};
  for (const line of snap.split('\n')) {
    const m = line.match(/^\s*-\s+([\w-]+)\s+"([^"]*)"(.*)$/);
    if (!m) continue;
    const r = (m[3] || '').match(/\[ref=([^\]]+)\]/);
    map[`${m[1]}:${m[2]}`] = r ? r[1] : '(no-ref)';
  }
  return map;
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
let snapNo = 0;
const snap = async tag => {
  const s = await page.ariaSnapshot({ mode: 'ai' });
  snapNo++;
  if (tag) console.log(`--- snapshot ${tag} (#${snapNo}, ${s.length} chars) ---\n${s}\n---`);
  return s;
};
const clickRef = async (ref, label, timeout = 5000) => {
  const t0 = Date.now();
  try { await page.locator(`aria-ref=${ref}`).click({ timeout }); rec(label, `OK in ${Date.now() - t0}ms`); }
  catch (e) { rec(label, `FAIL in ${Date.now() - t0}ms :: ${firstLine(e)}`); }
};

await page.goto(base + '/');

// M10: selector target waits for an element that does not exist yet (appears at 2500ms)
{
  const t0 = Date.now();
  try { await page.locator('#delayed').click({ timeout: 8000 }); rec('M10b.selector-autowait-nonexistent', `OK in ${Date.now() - t0}ms (element appears at ~2500ms)`); }
  catch (e) { rec('M10b.selector-autowait-nonexistent', `FAIL in ${Date.now() - t0}ms :: ${firstLine(e)}`); }
}

const s1 = await snap('s1-after-load');
const m1 = refMap(s1);
rec('M1.refs-at-load', JSON.stringify(m1));
rec('M8.hidden-button', JSON.stringify({ hidden: m1['button:Hidden'] ?? 'absent-from-snapshot' }));
rec('M10a.late-not-yet-present', JSON.stringify({ late: m1['button:Late Target'] ?? 'absent-from-snapshot' }));

// M10c: refs cannot reach an element that was absent when the snapshot was taken
rec('M10c.ref-for-absent-element', 'no ref exists -> must re-snapshot (2 round trips)');

// M2: are refs stable across snapshots with no change?
const s2 = await snap();
const m2 = refMap(s2);
const drift = Object.fromEntries(Object.keys(m1).map(k => [k, m1[k] === m2[k] ? 'same' : `${m1[k]} -> ${m2[k] ?? 'gone'}`]));
rec('M2.ref-stability-across-snapshots', JSON.stringify(drift));

// M4: same node, label changes
const rn = m1['button:Rename'];
await clickRef(rn, 'M4a.click-rename-by-ref');
await snap();
const m4 = refMap(await snap());
rec('M4b.ref-after-label-change', JSON.stringify({ before: rn, after: m4['button:Renamed'] ?? 'absent', numberReused: rn === m4['button:Renamed'] }));
await clickRef(rn, 'M4c.old-ref-after-label-change');

// M5: React-like replacement with an equivalent node
const sw = m1['button:Swap'];
await clickRef(sw, 'M5a.click-swap-by-ref');
const m5 = refMap(await snap());
rec('M5b.ref-after-node-replacement', JSON.stringify({ before: sw, after: m5['button:Swap'] ?? 'absent', numberReused: sw === m5['button:Swap'] }));
await clickRef(sw, 'M5c.old-ref-after-node-replacement');

// M6: in-app route change (pushState) — the bug that cost us three commits
const st = m1['button:Save'];
await clickRef(m1['button:Route'], 'M6a.click-route-pushstate');
rec('M6b.url-after-pushstate', page.url());
await clickRef(st, 'M6c.old-ref-after-pushstate');

// M7: full navigation
const m6 = refMap(await snap());
await clickRef(m6['button:Navigate'] ?? m1['button:Navigate'], 'M7a.click-navigate');
await page.waitForLoadState('load').catch(() => {});
rec('M7b.url-after-navigation', page.url());
await clickRef(st, 'M7c.old-ref-after-navigation');
rec('M7d.refs-on-new-document', JSON.stringify(refMap(await snap('s-on-second-page'))));

// M9: disabled (visible, receives pointer events, not enabled) — actionability wait?
const m8 = refMap(await snap());
rec('M9a.disabled-has-ref', String(m8['button:Disabled'] ?? 'absent'));
if (m8['button:Disabled']) await clickRef(m8['button:Disabled'], 'M9b.click-disabled-by-ref', 3000);

// M11: snapshot cost on this page
const final = await snap();
rec('M11.snapshot-chars', String(final.length));

await browser.close();
server.close();
