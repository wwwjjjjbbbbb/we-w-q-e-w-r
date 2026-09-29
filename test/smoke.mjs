// End-to-end smoke test: start `PORT=3456 node server.js`then run `node test/smoke.mjs`
const B = 'http://localhost:3456/api';
const j = async (p, o = {}, t) => { const r = await fetch(B + p, { ...o, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: o.body && JSON.stringify(o.body) }); const d = await r.json(); if (!r.ok) throw new Error(p + ': ' + d.error); return d; };
const ok = (label, v) => console.log('✓', label, v === undefined ? '' : JSON.stringify(v));

const a = await j('/register', { method: 'POST', body: { name: 'Alex', pw: '1234', emoji: '🐱' } });
const b = await j('/register', { method: 'POST', body: { name: 'Sam', pw: '1234', emoji: '🐶' } });
try { await j('/register', { method: 'POST', body: { name: 'Alex', pw: '1234' } }); } catch (e) { ok('duplicate name rejected', e.message); }
try { await j('/login', { method: 'POST', body: { name: 'Alex', pw: 'xx' } }); } catch (e) { ok('wrong password rejected', e.message); }
ok('login', (await j('/login', { method: 'POST', body: { name: 'Alex', pw: '1234' } })).me.name);
ok('search', (await j('/users?q=Sa', {}, a.token)).users.map(u => u.name));
await j('/requests', { method: 'POST', body: { to: b.me.uid } }, a.token);
const fb = await j('/friends', {}, b.token); ok('Sam receives request', fb.reqIn.map(r => r.fromProfile.name));
await j('/requests/' + fb.reqIn[0].id + '/accept', { method: 'POST' }, b.token);
ok('Alex friends', (await j('/friends', {}, a.token)).friends.map(f => f.name));
const dm = await j('/chats/dm', { method: 'POST', body: { uid: b.me.uid } }, a.token);
await j(`/chats/${dm.chat.id}/channels/dm/messages`, { method: 'POST', body: { kind: 'text', text: 'hey there' } }, a.token);
const g = await j('/chats', { method: 'POST', body: { name: 'Weekend Plans', members: [b.me.uid] } }, a.token);
const pubg = await j('/chats', { method: 'POST', body: { name: 'Lobby', public: true, members: [] } }, b.token);
await j(`/chats/${pubg.chat.id}/join`, { method: 'POST' }, a.token);
ok('public groups', (await j('/rooms', {}, a.token)).rooms);
const up = await (await fetch(B + '/upload?name=' + encodeURIComponent('photo.png'), { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'image/png' }, body: Buffer.alloc(1000) })).json(); ok('upload', up);
const ch = g.chat.channels[0].id;
const m = await j(`/chats/${g.chat.id}/channels/${ch}/messages`, { method: 'POST', body: { kind: 'image', file: up.file } }, a.token);
const likeTotals = [];
for (let i = 0; i < 4; i++) likeTotals.push(Object.values((await j(`/chats/${g.chat.id}/channels/${ch}/messages/${m.msg.id}/like`, { method: 'POST' }, b.token)).msg.likes)[0]);
const steps = likeTotals.map((v, i) => v - (i ? likeTotals[i - 1] : 0));
if (steps.some(s => s < 5 || s > 16)) throw new Error('like step out of the 5-16 range: ' + steps.join(','));
ok('each tap adds 5-16', { steps, total: likeTotals[likeTotals.length - 1] });
const clamped = Object.values((await j(`/chats/${g.chat.id}/channels/${ch}/messages/${m.msg.id}/like`, { method: 'POST', body: { n: 9999 } }, b.token)).msg.likes)[0] - likeTotals[likeTotals.length - 1];
if (clamped !== 16) throw new Error('server did not clamp an oversized increment: ' + clamped);
ok('oversized increment clamped to', clamped);
ok('group messages', (await j(`/chats/${g.chat.id}/channels/${ch}/messages`, {}, b.token)).messages.map(x => x.kind + ':' + x.text));
const nc = await j(`/chats/${g.chat.id}/channels`, { method: 'POST', body: { name: 'announcements' } }, a.token); ok('new channel', nc.channel.name);
try { await j(`/chats/${g.chat.id}/channels`, { method: 'POST', body: { name: 'x' } }, b.token); } catch (e) { ok('non-owner channel rejected', e.message); }
await j(`/chats/${g.chat.id}/channels/${nc.channel.id}/messages`, { method: 'POST', body: { kind: 'text', text: 'first post in announcements' } }, b.token);
ok('announcement messages', (await j(`/chats/${g.chat.id}/channels/${nc.channel.id}/messages`, {}, a.token)).messages.length);
ok('phantom members', (await j(`/chats/${g.chat.id}/bots`, { method: 'POST', body: { count: 300 } }, a.token)).count);
const mem = await j(`/chats/${g.chat.id}/members`, {}, b.token); ok('members real/phantom', [mem.members.length, mem.bots.length, mem.bots[0].name]);
ok('headcount', (await j(`/chats/${g.chat.id}`, {}, a.token)).chat.memberCount);
try { await j(`/chats/${g.chat.id}/bots`, { method: 'POST', body: { count: 5 } }, b.token); } catch (e) { ok('non-owner phantom rejected', e.message); }
ok('Sam conversations', (await j('/chats', {}, b.token)).chats.map(c => c.type + ' ' + (c.name || '') + ' | ' + c.lastMsg));
// WebSocket push (Node 22 built-in client)
const ws = new WebSocket('ws://localhost:3456/ws?token=' + b.token);
await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
const hello = new Promise(r => ws.onmessage = ev => { const e = JSON.parse(ev.data); if (e.t === 'hello') r(e.online); });
ok('online list', (await hello).length);
const got = new Promise(r => ws.onmessage = ev => { const e = JSON.parse(ev.data); if (e.t === 'msg') r(e.msg.text); });
await j(`/chats/${dm.chat.id}/channels/dm/messages`, { method: 'POST', body: { kind: 'text', text: 'live push test '.repeat(20) } }, a.token);
ok('WebSocket received', (await got).slice(0, 12) + '…'); ws.close();
const bad = new WebSocket('ws://localhost:3456/ws?token=nope'); await new Promise(r => { bad.onerror = r; bad.onclose = r; }); ok('invalid token rejected');
ok('static / fallback / upload / 404', [(await fetch('http://localhost:3456/')).status, (await fetch('http://localhost:3456/anything')).headers.get('content-type'), (await fetch('http://localhost:3456' + up.file.url)).status, (await fetch('http://localhost:3456/api/nope')).status]);
await j(`/chats/${g.chat.id}/leave`, { method: 'POST' }, b.token);
ok('after Sam leaves', (await j('/chats', {}, a.token)).chats.map(c => (c.name || c.type) + ':' + c.memberIds.length));
console.log('\nALL PASSED');
