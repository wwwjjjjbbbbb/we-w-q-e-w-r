// Browser smoke test: two contexts — register, add friend, DM, live receive, screenshot
const { chromium } = require('playwright');
const URL = 'http://localhost:3456/';
(async () => {
  const browser = await chromium.launch();
  const A = await (await browser.newContext({ viewport: { width: 1200, height: 760 } })).newPage();
  const B = await (await browser.newContext({ viewport: { width: 420, height: 800 }, isMobile: true })).newPage();
  const errors = []; for (const p of [A, B]) p.on('pageerror', e => errors.push(e.message));
  async function register(p, name) {
    await p.goto(URL); await p.click('#to-register'); await p.fill('#reg-name', name); await p.fill('#reg-pw', '1234'); await p.click('#reg-btn');
    await p.waitForSelector('#app:not(.hidden)');
  }
  await register(A, 'Alex'); await register(B, 'Sam');
  // A searches for B and sends a request
  await A.click('[data-ft="add"]'); await A.fill('#user-search', 'Sam'); await A.waitForSelector('[data-add]'); await A.click('[data-add]'); await A.waitForSelector('#uc-send'); await A.fill('#uc-note', 'Hey, it is Alex'); await A.click('#uc-send');
  // B accepts
  await B.click('#tabbar [data-tab="friends"]'); await B.click('[data-ft="pending"]'); await B.waitForSelector('[data-accept]');
  if (!(await B.textContent('.frow .sub')).includes('Hey, it is Alex')) throw new Error('request note not shown');
  await B.click('[data-accept]');
  await A.click('[data-ft="all"]'); await A.waitForSelector('[data-dm]');
  // A opens a DM and sends
  await A.click('[data-dm]'); await A.waitForSelector('#view-chat:not(.hidden)'); await A.fill('#input', 'Hey Sam!'); await A.press('#input', 'Enter');
  await A.waitForSelector('.m .txt');
  // B opens it and receives the next one live
  await B.click('#tabbar [data-tab="chats"]'); await B.waitForSelector('[data-dm^="dm_"]'); await B.click('[data-dm^="dm_"]'); await B.waitForSelector('.m .txt');
  await A.fill('#input', 'This one arrived live'); await A.press('#input', 'Enter');
  await B.waitForFunction(() => document.body.innerText.includes('This one arrived live'));
  // B likes it, A sees the count
  await B.click('.m:last-child .react'); await B.click('.m:last-child .react'); await B.click('.m:last-child .react');
  await A.waitForFunction(() => { const r=[...document.querySelectorAll('.m .react')].pop(); const n=parseInt((r?.textContent||'').replace(/\D/g,''),10); return n >= 15 && n <= 48; });
  // A creates a group with 300 phantom members
  await A.click('#sb-new-group'); await A.fill('#g-name', 'Night Radio'); await A.fill('#g-bots', '300'); await A.check('.check-list input'); await A.click('#g-create');
  await A.waitForSelector('.sys'); await A.waitForFunction(() => document.querySelectorAll('#rt-body .mem').length > 100);
  await A.fill('#input', 'Welcome to Night Radio. What are we on about tonight?'); await A.press('#input', 'Enter'); await A.waitForSelector('.m.me .bub');
  await B.click('#back'); await B.waitForSelector('[data-ch]'); await B.click('[data-ch]'); await B.waitForFunction(() => document.body.innerText.includes('Night Radio'));
  await A.screenshot({ path: 'test/desktop.png' }); await B.screenshot({ path: 'test/mobile.png' });
  console.log('page errors:', errors.length ? errors : 'none'); console.log('UI smoke passed');
  await browser.close();
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
