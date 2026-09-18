// Follow-up probe: ref namespace/epoch, actionability wait, and pre-resolution fast-fail.
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const PAGE = `<!doctype html><html><body>
<h1>Ref probe</h1>
<button id="stable">Save</button>
<button id="disabled" disabled>Disabled</button>
<button id="slow">Slow Enable</button>
<button id="gone">Gone Soon</button>
<button id="nav">Navigate</button>
<script>
  setTimeout(() => { document.getElementById('slow').disabled = false; }, 2000);
  document.getElementById('gone').addEventListener('click', e => { e.currentTarget.remove(); });
  document.getElementById('nav').addEventListener('click', () => { location.href = '/second'; });
</script>
</body></html>`;

const SECOND = `<!doctype html><html><body><h1>Second</h1><button id="second-btn">Second</button><a href="/">Back</a></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/second' ? SECOND : PAGE);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const rec = (id, value) => console.log(`[${id}] ${value}`);
const firstLine = e => String(e && e.message || e).split('\n')[0];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();

const snap = async () => {
  const t0 = Date.now();
  const s = await page.ariaSnapshot({ mode: 'ai' });
  return { s, ms: Date.now() - t0 };
};
const refOf = (s, name) => {
  for (const line of s.split('\n')) {
    const m = line.match(/^\s*-\s+([\w-]+)\s+"([^"]*)"(.*)$/);
    if (m && m[2] === name) { const r = (m[3] || '').match(/\[ref=([^\]]+)\]/); return r ? r[1] : null; }
  }
  return null;
};

await page.goto(base + '/');
let r = await snap();
console.log(`--- page1 snapshot (${r.ms}ms, ${r.s.length} chars) ---\n${r.s}\n---`);
const stable = refOf(r.s, 'Save');
const disabled = refOf(r.s, 'Disabled');
const slow = refOf(r.s, 'Slow Enable');
const gone = refOf(r.s, 'Gone Soon');
rec('P1.refs', JSON.stringify({ stable, disabled, slow, gone }));

// A: does a ref survive a SECOND navigation with a NEW prefix (epoch) or the same one?
await page.goto(base + '/second');
r = await snap();
rec('A1.prefix-after-1st-nav', JSON.stringify({ raw: r.s.replace(/\n/g, ' | ') }));
await page.goto(base + '/');
r = await snap();
const stable2 = refOf(r.s, 'Save');
rec('A2.prefix-after-2nd-nav', JSON.stringify({ stable2, raw: r.s.replace(/\n/g, ' | ') }));

// B: disabled element — actionability wait then failure
{
  const dis = refOf(r.s, 'Disabled');
  const t0 = Date.now();
  try { await page.locator(`aria-ref=${dis}`).click({ timeout: 3000 }); rec('B1.click-disabled', `OK in ${Date.now() - t0}ms`); }
  catch (e) { rec('B1.click-disabled', `FAIL in ${Date.now() - t0}ms :: ${firstLine(e)}`); }
}

// C: element that enables itself after 2s — does the ref click wait for enabled?
{
  const sp = refOf(r.s, 'Slow Enable');
  const t0 = Date.now();
  try { await page.locator(`aria-ref=${sp}`).click({ timeout: 6000 }); rec('C1.click-becomes-enabled', `OK in ${Date.now() - t0}ms (enabled at ~2s)`); }
  catch (e) { rec('C1.click-becomes-enabled', `FAIL in ${Date.now() - t0}ms :: ${firstLine(e)}`); }
}

// D: kill an element, then compare raw locator vs pre-resolution (normalize)
{
  const rg = refOf((await snap()).s, 'Gone Soon');
  await page.locator(`aria-ref=${rg}`).click();
  const after = (await snap()).s;
  rec('D1.ref-after-element-removed', JSON.stringify({ goneNow: refOf(after, 'Gone Soon'), raw: after.replace(/\n/g, ' | ') }));

  const t0 = Date.now();
  try { await page.locator(`aria-ref=${rg}`).click({ timeout: 20000 }); rec('D2.raw-locator-on-dead-ref', `OK in ${Date.now() - t0}ms`); }
  catch (e) { rec('D2.raw-locator-on-dead-ref', `FAIL in ${Date.now() - t0}ms :: ${firstLine(e)}`); }

  const t1 = Date.now();
  try {
    const loc = page.locator(`aria-ref=${rg}`);
    await loc.normalize();
    rec('D3.normalize-on-dead-ref', `resolved in ${Date.now() - t1}ms :: ${String(loc).slice(0, 120)}`);
  } catch (e) { rec('D3.normalize-on-dead-ref', `FAIL in ${Date.now() - t1}ms :: ${firstLine(e)}`); }
}

await browser.close();
server.close();
