// Maybe Big Brother Is Watching — backend (zero dependencies, Node.js built-ins only)
// Run: node server.js   → http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048); // 2 GB — uploads stream to disk, so this is bounded by free space, not RAM
const MSG_KEEP = Number(process.env.MSG_KEEP || 2000); // messages kept per channel
const LIKE_MIN = 5, LIKE_MAX = 16; // each tap of the heart adds a random amount in this range
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ================= Storage (JSON file) ================= */
const empty = () => ({ users: {}, names: {}, sessions: {}, friends: {}, requests: {}, chats: {}, messages: {} });
let db = empty();
try { db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* first run */ }
// Migration: older groups had no channels
for (const c of Object.values(db.chats)) {
  if (c.type === 'group' && !c.channels) c.channels = [{ id: 'c_general', name: 'general' }];
  if (!c.bots) c.bots = [];
  const legacy = db.messages[c.id];
  if (Array.isArray(legacy)) { db.messages[msgKey(c.id, c.type === 'dm' ? 'dm' : c.channels[0].id)] = legacy; delete db.messages[c.id]; }
}
function msgKey(chatId, ch) { return chatId + ':' + ch; }

// Migration: rewrite data written by the older Chinese build.
// The \uXXXX literals below are the legacy strings being matched; nothing here is ever shown.
const CJK_RE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
function enName(uid, used) {
  let h = 0; for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  for (let k = 0; k < 400; k++) {
    let n = BOT_A[(h + k * 7) % BOT_A.length] + BOT_B[(Math.floor(h / 7) + k * 13) % BOT_B.length];
    if ((h >> 5) % 10 < 6) n += String((h + k) % 1000).padStart((h >> 3) % 2 ? 2 : 3, '0');
    if (!used.has(n)) { used.add(n); return n; }
  }
  return 'Ghost' + uid.slice(-5);
}
function enText(t) {
  if (typeof t !== 'string' || !CJK_RE.test(t)) return t;
  let m;
  if ((m = t.match(/^(.*?) \u521b\u5efa\u4e86\u7fa4\u804a\u300c(.*)\u300d$/))) return `${m[1]} created the group "${m[2]}"`;
  if ((m = t.match(/^(.*?) \u52a0\u5165\u4e86\u7fa4\u804a$/))) return `${m[1]} joined the group`;
  if ((m = t.match(/^(.*?) \u9000\u51fa\u4e86\u7fa4\u804a$/))) return `${m[1]} left the group`;
  return t.replace('[\u56fe\u7247]', '[image]').replace('[\u89c6\u9891]', '[video]').replace(/^\[\u6587\u4ef6\]\s*/, '[file] ');
}
function migrateLegacy() {
  let migrated = false;
for (const c of Object.values(db.chats)) {
  for (const ch of c.channels || []) if (CJK_RE.test(ch.name)) { ch.name = ch.name === '\u5927\u5385' ? 'general' : (ch.name.replace(new RegExp(CJK_RE.source, 'g'), '').trim() || 'channel'); migrated = true; }
  const used = new Set((c.bots || []).map(b => b.name).filter(n => !CJK_RE.test(n)));
  for (const b of c.bots || []) if (CJK_RE.test(b.name)) { b.name = enName(b.uid, used); migrated = true; }
  for (const k of ['lastMsg', 'lastFrom']) { const v = enText(c[k]); if (v !== c[k]) { c[k] = v; migrated = true; } }
}
for (const list of Object.values(db.messages)) {
  if (!Array.isArray(list)) continue;
  for (const m of list) { const v = enText(m.text); if (v !== m.text) { m.text = v; migrated = true; } }
}
  if (migrated) { save(); console.log('Migrated legacy data to English.'); }
}
let saveTimer = null;
function flush() { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 150); }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { clearTimeout(saveTimer); flush(); process.exit(0); });

const id = (p = '') => p + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const now = () => Date.now();
const hashPw = (pw, salt = crypto.randomBytes(8).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const checkPw = (pw, stored) => { const [salt, h] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 32)); };
const pub = u => u && ({ uid: u.uid, name: u.name, avatar: u.avatar });
const profiles = ids => Object.fromEntries(ids.map(i => [i, pub(db.users[i]) || { uid: i, name: 'Deleted user' }]));
const dmId = (a, b) => 'dm_' + [a, b].sort().join('_');
const nameKey = n => String(n).trim().toLowerCase();
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

/* ================= Minimal WebSocket server ================= */
const sockets = new Map(); // uid -> Set<socket>
function wsFrame(str) {
  const payload = Buffer.from(str); const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function attachWs(socket, uid) {
  if (!sockets.has(uid)) sockets.set(uid, new Set());
  sockets.get(uid).add(socket);
  socket.alive = true;
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f; const masked = buf[1] & 0x80; let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
      if (masked) { const mask = buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4])); }
      buf = buf.subarray(off + (masked ? 4 : 0) + len);
      if (op === 0x8) { socket.end(Buffer.from([0x88, 0])); return; }           // close
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } // ping → pong
      if (op === 0xa) socket.alive = true;                                       // pong
    }
  });
  const drop = () => { sockets.get(uid)?.delete(socket); if (!sockets.get(uid)?.size) { sockets.delete(uid); pushAll({ t: 'presence', uid, online: false }); } };
  socket.on('close', drop); socket.on('error', drop); socket.on('end', drop);
  socket.write(wsFrame(JSON.stringify({ t: 'hello', uid, online: online() })));
  if (sockets.get(uid).size === 1) pushAll({ t: 'presence', uid, online: true });
}
setInterval(() => { for (const set of sockets.values()) for (const s of set) { if (!s.alive) { s.destroy(); continue; } s.alive = false; try { s.write(Buffer.from([0x89, 0])); } catch { s.destroy(); } } }, 30000);
function push(uids, payload) { const f = wsFrame(JSON.stringify(payload)); for (const uid of new Set(uids)) for (const s of sockets.get(uid) || []) { try { s.write(f); } catch {} } }
const pushAll = payload => push([...sockets.keys()], payload);
const online = () => [...sockets.keys()];
const chatView = c => ({ ...c, profiles: profiles(c.memberIds), memberCount: c.memberIds.length + (c.bots?.length || 0) });
const notifyChat = c => push(c.memberIds, { t: 'chat', chat: chatView(c) });

/* ================= Domain logic ================= */
const myChats = uid => Object.values(db.chats).filter(c => c.memberIds.includes(uid)).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
const mainChannel = c => c.type === 'dm' ? 'dm' : c.channels[0].id;
function addMessage(chatId, ch, data, preview) {
  const c = db.chats[chatId]; if (!c) return null;
  const m = { id: id(), ts: now(), sentAt: now(), likes: {}, ...data };
  const list = db.messages[msgKey(chatId, ch)] ||= [];
  list.push(m);
  // A hand-picked time can be older than the message before it, so re-sort rather than assume append order.
  if (m.ts < (list[list.length - 2]?.ts ?? m.ts)) list.sort((a, b) => a.ts - b.ts || a.sentAt - b.sentAt);
  if (list.length > MSG_KEEP) list.splice(0, list.length - MSG_KEEP);
  if (m.kind !== 'system') { c.lastMsg = preview ?? (m.text || '').slice(0, 60); c.lastTs = Math.max(c.lastTs || 0, m.ts); c.lastFromUid = m.uid; c.lastFrom = db.users[m.uid]?.name || ''; c.lastCh = ch; }
  save();
  push(c.memberIds, { t: 'msg', chatId, ch, msg: m });
  if (m.kind !== 'system') notifyChat(c);
  return m;
}
const systemMsg = (chatId, text) => { const c = db.chats[chatId]; if (c) addMessage(chatId, mainChannel(c), { kind: 'system', text, uid: 'system' }); };
const hasChannel = (c, ch) => c.type === 'dm' ? ch === 'dm' : c.channels.some(x => x.id === ch);
function befriend(a, b) {
  db.friends[a] = [...new Set([...(db.friends[a] || []), b])];
  db.friends[b] = [...new Set([...(db.friends[b] || []), a])];
  push([a, b], { t: 'friends' });
}
function newSession(uid) { const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = uid; save(); return token; }
const memberChat = (me, cid) => { const c = db.chats[cid]; if (!c || !c.memberIds.includes(me.uid)) fail(404, 'Conversation not found'); return c; };

// Routes: [method, regexp, requiresAuth, handler({me, params, body, query}) → JSON]
const routes = [];
const route = (m, re, needAuth, h) => routes.push({ m, re, needAuth, h });

route('POST', /^\/api\/register$/, false, ({ body }) => {
  const n = String(body.name || '').trim(), pw = String(body.pw || '');
  if (!n || n.length > 24) fail(400, 'Nickname must be 1–24 characters');
  if (pw.length < 4) fail(400, 'Password must be at least 4 characters');
  if (db.names[nameKey(n)]) fail(409, 'That nickname is taken — try another');
  const uid = id('u_');
  db.users[uid] = { uid, name: n, avatar: { emoji: String(body.emoji || '🙂').slice(0, 4) }, pwHash: hashPw(pw), createdAt: now() };
  db.names[nameKey(n)] = uid; db.friends[uid] = [];
  return { token: newSession(uid), me: pub(db.users[uid]) };
});
route('POST', /^\/api\/login$/, false, ({ body }) => {
  const uid = db.names[nameKey(body.name || '')];
  if (!uid) fail(404, 'No account with that nickname');
  if (!checkPw(String(body.pw || ''), db.users[uid].pwHash)) fail(401, 'Wrong password');
  return { token: newSession(uid), me: pub(db.users[uid]) };
});
route('POST', /^\/api\/logout$/, true, ({ token }) => { delete db.sessions[token]; save(); return { ok: true }; });
route('GET', /^\/api\/me$/, true, ({ me }) => ({ me: pub(me) }));
route('PUT', /^\/api\/me$/, true, ({ me, body }) => {
  const n = String(body.name || '').trim();
  if (!n || n.length > 24) fail(400, 'Nickname must be 1–24 characters');
  if (nameKey(n) !== nameKey(me.name) && db.names[nameKey(n)]) fail(409, 'That nickname is taken');
  delete db.names[nameKey(me.name)]; db.names[nameKey(n)] = me.uid; me.name = n;
  const av = body.avatar || {};
  if (av.url && String(av.url).startsWith('/uploads/')) me.avatar = { url: String(av.url) };
  else if (av.emoji) me.avatar = { emoji: String(av.emoji).slice(0, 4) };
  save();
  for (const c of Object.values(db.chats)) if (c.memberIds.includes(me.uid)) notifyChat(c);
  push(db.friends[me.uid] || [], { t: 'friends' });
  return { me: pub(me) };
});
route('GET', /^\/api\/users$/, true, ({ me, query }) => {
  const q = nameKey(query.get('q') || ''); if (!q) return { users: [] };
  return { users: Object.values(db.users).filter(u => u.uid !== me.uid && u.name.toLowerCase().includes(q)).slice(0, 20).map(pub) };
});
route('GET', /^\/api\/profiles$/, true, ({ query }) => ({ profiles: profiles((query.get('ids') || '').split(',').filter(Boolean)) }));

/* Friends */
route('GET', /^\/api\/friends$/, true, ({ me }) => {
  const reqs = Object.values(db.requests).filter(r => r.status === 'pending');
  return {
    friends: (db.friends[me.uid] || []).map(i => pub(db.users[i])).filter(Boolean),
    reqIn: reqs.filter(r => r.to === me.uid).map(r => ({ ...r, fromProfile: pub(db.users[r.from]) })),
    reqOut: reqs.filter(r => r.from === me.uid).map(r => ({ ...r, toProfile: pub(db.users[r.to]) })),
  };
});
route('POST', /^\/api\/requests$/, true, ({ me, body }) => {
  const to = String(body.to || '');
  if (!db.users[to] || to === me.uid) fail(400, 'User not found');
  if ((db.friends[me.uid] || []).includes(to)) fail(409, 'You are already friends');
  const reverse = db.requests[`${to}__${me.uid}`];
  if (reverse && reverse.status === 'pending') { befriend(me.uid, to); reverse.status = 'accepted'; save(); return { ok: true, accepted: true }; }
  db.requests[`${me.uid}__${to}`] = { id: `${me.uid}__${to}`, from: me.uid, to, status: 'pending', note: String(body.note || '').slice(0, 60), ts: now() }; save();
  push([me.uid, to], { t: 'friends' }); return { ok: true };
});
route('POST', /^\/api\/requests\/([^/]+)\/accept$/, true, ({ me, params }) => {
  const r = db.requests[params[0]]; if (!r || r.to !== me.uid || r.status !== 'pending') fail(404, 'Request not found');
  r.status = 'accepted'; r.acceptedAt = now(); befriend(r.from, r.to); save();
  // tell the person who asked, so they get the news without reloading
  push([r.from], { t: 'friend-accepted', uid: me.uid, name: me.name });
  return { ok: true };
});
route('POST', /^\/api\/requests\/([^/]+)\/reject$/, true, ({ me, params }) => {
  const r = db.requests[params[0]]; if (!r || r.to !== me.uid) fail(404, 'Request not found');
  r.status = 'rejected'; save(); push([r.from, r.to], { t: 'friends' }); return { ok: true };
});
route('DELETE', /^\/api\/requests\/([^/]+)$/, true, ({ me, params }) => {
  const r = db.requests[params[0]]; if (!r || r.from !== me.uid) fail(404, 'Request not found');
  delete db.requests[params[0]]; save(); push([r.from, r.to], { t: 'friends' }); return { ok: true };
});
route('DELETE', /^\/api\/friends\/([^/]+)$/, true, ({ me, params }) => {
  const o = params[0];
  db.friends[me.uid] = (db.friends[me.uid] || []).filter(i => i !== o); db.friends[o] = (db.friends[o] || []).filter(i => i !== me.uid);
  delete db.requests[`${me.uid}__${o}`]; delete db.requests[`${o}__${me.uid}`];
  save(); push([me.uid, o], { t: 'friends' }); return { ok: true };
});

/* Conversations */
route('GET', /^\/api\/chats$/, true, ({ me }) => ({ chats: myChats(me.uid).map(chatView) }));
route('GET', /^\/api\/rooms$/, true, ({ me }) => ({ rooms: Object.values(db.chats).filter(c => c.public).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).map(c => ({ id: c.id, name: c.name, memberCount: c.memberIds.length + (c.bots?.length || 0), lastMsg: c.lastMsg, joined: c.memberIds.includes(me.uid) })) }));
route('POST', /^\/api\/chats$/, true, ({ me, body }) => {
  const n = String(body.name || '').trim(); if (!n || n.length > 30) fail(400, 'Group name must be 1–30 characters');
  const friends = db.friends[me.uid] || [];
  const ids = [me.uid, ...(Array.isArray(body.members) ? body.members : []).filter(i => friends.includes(i) && db.users[i])];
  if (!body.public && ids.length < 2) fail(400, 'Invite at least one friend');
  const c = { id: id('g_'), type: 'group', name: n, public: !!body.public, memberIds: [...new Set(ids)], channels: [{ id: 'c_general', name: 'general' }], bots: [], createdBy: me.uid, createdAt: now(), lastTs: now(), lastMsg: '' };
  db.chats[c.id] = c; save();
  systemMsg(c.id, `${me.name} created the group "${n}"`); notifyChat(c); if (c.public) pushAll({ t: 'rooms' });
  return { chat: chatView(c) };
});
route('POST', /^\/api\/chats\/dm$/, true, ({ me, body }) => {
  const o = String(body.uid || ''); if (!db.users[o] || o === me.uid) fail(400, 'User not found');
  const cid = dmId(me.uid, o);
  if (!db.chats[cid]) { db.chats[cid] = { id: cid, type: 'dm', memberIds: [me.uid, o], bots: [], createdAt: now(), lastTs: now(), lastMsg: '' }; save(); notifyChat(db.chats[cid]); }
  return { chat: chatView(db.chats[cid]) };
});
route('GET', /^\/api\/chats\/([^/]+)$/, true, ({ me, params }) => { const c = db.chats[params[0]]; if (!c || (!c.memberIds.includes(me.uid) && !c.public)) fail(404, 'Conversation not found'); return { chat: chatView(c) }; });
route('POST', /^\/api\/chats\/([^/]+)\/join$/, true, ({ me, params }) => {
  const c = db.chats[params[0]]; if (!c || !c.public) fail(404, 'Group not found');
  if (!c.memberIds.includes(me.uid)) { c.memberIds.push(me.uid); save(); systemMsg(c.id, `${me.name} joined the group`); notifyChat(c); pushAll({ t: 'rooms' }); }
  return { chat: chatView(c) };
});
route('POST', /^\/api\/chats\/([^/]+)\/invite$/, true, ({ me, params, body }) => {
  const c = memberChat(me, params[0]); if (c.type !== 'group') fail(400, 'You can only invite people to a group');
  const friends = db.friends[me.uid] || [];
  const add = (Array.isArray(body.uids) ? body.uids : []).filter(i => friends.includes(i) && !c.memberIds.includes(i));
  for (const i of add) { c.memberIds.push(i); systemMsg(c.id, `${db.users[i].name} joined the group`); }
  save(); notifyChat(c); if (c.public) pushAll({ t: 'rooms' });
  return { chat: chatView(c), added: add.length };
});
route('POST', /^\/api\/chats\/([^/]+)\/leave$/, true, ({ me, params }) => {
  const c = memberChat(me, params[0]);
  c.memberIds = c.memberIds.filter(i => i !== me.uid);
  push([me.uid], { t: 'chat-removed', chatId: c.id });
  if (!c.memberIds.length) { delete db.chats[c.id]; for (const k of Object.keys(db.messages)) if (k.startsWith(c.id + ':')) delete db.messages[k]; }
  else { systemMsg(c.id, `${me.name} left the group`); notifyChat(c); }
  save(); if (c.public) pushAll({ t: 'rooms' }); return { ok: true };
});

/* Channels (groups only) */
route('POST', /^\/api\/chats\/([^/]+)\/channels$/, true, ({ me, params, body }) => {
  const c = memberChat(me, params[0]); if (c.type !== 'group') fail(400, 'Direct messages have no channels');
  if (c.createdBy !== me.uid) fail(403, 'Only the owner can manage channels');
  const n = String(body.name || '').trim().replace(/^#/, '').slice(0, 20); if (!n) fail(400, 'Channel name required');
  if (c.channels.length >= 30) fail(400, 'Too many channels');
  const ch = { id: id('c_'), name: n }; c.channels.push(ch); save(); notifyChat(c); return { channel: ch };
});
route('DELETE', /^\/api\/chats\/([^/]+)\/channels\/([^/]+)$/, true, ({ me, params }) => {
  const c = memberChat(me, params[0]); if (c.type !== 'group' || c.createdBy !== me.uid) fail(403, 'Only the owner can manage channels');
  if (c.channels.length <= 1) fail(400, 'A group needs at least one channel');
  c.channels = c.channels.filter(x => x.id !== params[1]); delete db.messages[msgKey(c.id, params[1])]; save(); notifyChat(c); return { ok: true };
});

/* Phantom members (owner only) */
const BOT_A = ['Night', 'Zero', 'Pixel', 'Dark', 'Lumen', 'Mist', 'North', 'Sky', 'Ember', 'Jade', 'Ink', 'Ash', 'Frost', 'Cipher', 'Swift', 'Dusk', 'Void', 'Wave', 'Shard', 'Echo', 'Phantom', 'Aurora', 'Isle', 'Onyx', 'Nova', 'Helium', 'Pulse', 'Dotted', 'Prism', 'Storm', 'Redeye', 'Quantum', 'Owl', 'Mint', 'Amber', 'Wasabi', 'Citrus', 'Cream', 'Cheddar', 'Cola', 'Pomelo', 'Peach', 'Chestnut', 'Salt', 'Caramel', 'Matcha', 'Coco', 'Plum', 'Iron', 'Copper', 'Neon', 'Static', 'Hollow', 'Grim', 'Raven', 'Wolf'];
const BOT_B = ['Knight', 'Hunter', 'Walker', 'Engineer', 'Watcher', 'Keeper', 'Collector', 'Slacker', 'Glutton', 'Drifter', 'Player', 'Captain', 'Detective', 'Painter', 'Poet', 'Coder', 'Designer', 'Planner', 'Stranger', 'Rookie', 'Legend', 'Buddy', 'Student', 'Doctor', 'Coach', 'Leader', 'Driver', 'Cook', 'Catsitter', 'Grinder', 'Owl', 'Lark', 'Hauler', 'Fan', 'Bard', 'Fixer', 'Pilot', 'Diver', 'Gardener', 'Baker', 'Ranger', 'Scout', 'Miner', 'Smith', 'Sailor', 'Wizard', 'Ghost', 'Runner'];
const BOT_E = ['🤖', '👾', '🛸', '🌌', '⚡', '🔮', '🧬', '🛰️', '💾', '🎧', '🎮', '🕹️', '🧊', '🌙', '☄️', '🪐', '🔭', '📡', '🦾', '🧿', '🐙', '🦊', '🐺', '🦉', '🐉', '🦎', '🐍', '🦈', '🐬', '🦋'];
const rnd = a => a[Math.floor(Math.random() * a.length)];
migrateLegacy();
route('POST', /^\/api\/chats\/([^/]+)\/bots$/, true, ({ me, params, body }) => {
  const c = memberChat(me, params[0]); if (c.type !== 'group') fail(400, 'Phantom members are for groups only');
  if (c.createdBy !== me.uid) fail(403, 'Only the owner can add phantom members');
  const count = Math.max(1, Math.min(500, Number(body.count) || 100)); c.bots ||= [];
  if (c.bots.length + count > 2000) fail(400, 'Phantom members are capped at 2000');
  const used = new Set(c.bots.map(b => b.name));
  for (let i = 0; i < count; i++) {
    let name; do { name = rnd(BOT_A) + rnd(BOT_B) + (Math.random() < 0.6 ? String(Math.floor(Math.random() * 999)).padStart(Math.random() < 0.5 ? 2 : 3, '0') : ''); } while (used.has(name)); used.add(name);
    c.bots.push({ uid: id('b_'), name, avatar: { emoji: rnd(BOT_E) }, online: Math.random() < 0.35 });
  }
  save(); notifyChat(c); if (c.public) pushAll({ t: 'rooms' }); return { count: c.bots.length };
});
route('DELETE', /^\/api\/chats\/([^/]+)\/bots$/, true, ({ me, params }) => {
  const c = memberChat(me, params[0]); if (c.createdBy !== me.uid) fail(403, 'Only the owner can remove phantom members');
  c.bots = []; save(); notifyChat(c); if (c.public) pushAll({ t: 'rooms' }); return { ok: true };
});

/* Member list (real + phantom) */
route('GET', /^\/api\/chats\/([^/]+)\/members$/, true, ({ me, params }) => {
  const c = memberChat(me, params[0]); const on = new Set(online());
  return { members: c.memberIds.map(i => ({ ...(pub(db.users[i]) || { uid: i, name: 'Deleted user' }), online: on.has(i), owner: c.createdBy === i })), bots: c.bots || [] };
});

/* Messages */
const chanOf = (me, cid, ch) => { const c = memberChat(me, cid); if (!hasChannel(c, ch)) fail(404, 'Channel not found'); return c; };
route('GET', /^\/api\/chats\/([^/]+)\/channels\/([^/]+)\/messages$/, true, ({ me, params, query }) => {
  const c = chanOf(me, params[0], params[1]); const list = db.messages[msgKey(c.id, params[1])] || [];
  const limit = Math.min(Number(query.get('limit')) || 200, 1000);
  return { messages: list.slice(-limit), profiles: profiles([...new Set(list.map(m => m.uid))].filter(i => i !== 'system')) };
});
route('POST', /^\/api\/chats\/([^/]+)\/channels\/([^/]+)\/messages$/, true, ({ me, params, body }) => {
  const c = chanOf(me, params[0], params[1]); const kind = body.kind || 'text';
  let data, preview;
  if (kind === 'text') { const t = String(body.text || '').trim().slice(0, 4000); if (!t) fail(400, 'Message cannot be empty'); data = { kind, text: t }; preview = t.slice(0, 60); }
  else if (['image', 'video', 'file'].includes(kind) && body.file?.url && String(body.file.url).startsWith('/uploads/')) {
    const f = body.file;
    data = { kind, url: String(f.url), fileName: String(f.name || '').slice(0, 200), fileSize: Number(f.size) || 0, mime: String(f.mime || '') };
    preview = kind === 'image' ? '[image]' : kind === 'video' ? '[video]' : `[file] ${data.fileName}`; data.text = preview;
  } else fail(400, 'Unsupported message format');
  if (body.ts !== undefined && body.ts !== null && body.ts !== '') {
    const t = Number(body.ts);
    if (!Number.isFinite(t)) fail(400, 'That timestamp is not a valid time');
    // a century either side of now — enough for any real use, and it keeps the sort sane
    const span = 100 * 365 * 24 * 3600 * 1000;
    if (t < now() - span || t > now() + span) fail(400, 'Pick a time within a hundred years of today');
    data.ts = Math.round(t); data.customTs = true;
  }
  return { msg: addMessage(c.id, params[1], { uid: me.uid, ...data }, preview) };
});
route('POST', /^\/api\/chats\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)\/like$/, true, ({ me, params, body }) => {
  const c = chanOf(me, params[0], params[1]); const m = (db.messages[msgKey(c.id, params[1])] || []).find(x => x.id === params[2]); if (!m) fail(404, 'Message not found');
  const inc = Math.min(LIKE_MAX, Math.max(LIKE_MIN, Math.floor(Number(body.n)) || (LIKE_MIN + Math.floor(Math.random() * (LIKE_MAX - LIKE_MIN + 1)))));
  m.likes ||= {}; m.likes[me.uid] = (Number(m.likes[me.uid]) || 0) + inc;
  save(); push(c.memberIds, { t: 'msg', chatId: c.id, ch: params[1], msg: m }); return { msg: m };
});
route('DELETE', /^\/api\/chats\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)$/, true, ({ me, params }) => {
  const c = chanOf(me, params[0], params[1]); const list = db.messages[msgKey(c.id, params[1])] || []; const i = list.findIndex(x => x.id === params[2]);
  if (i < 0) fail(404, 'Message not found');
  if (list[i].uid !== me.uid && c.createdBy !== me.uid) fail(403, 'You can only delete your own messages');
  const [m] = list.splice(i, 1); if (m.url) fs.rm(path.join(UPLOAD_DIR, path.basename(m.url)), () => {});
  save(); push(c.memberIds, { t: 'msg-deleted', chatId: c.id, ch: params[1], mid: m.id }); return { ok: true };
});

/* Delete a batch of messages at once. Silently skips any the caller may not remove. */
route('POST', /^\/api\/chats\/([^/]+)\/channels\/([^/]+)\/messages\/delete$/, true, ({ me, params, body }) => {
  const c = chanOf(me, params[0], params[1]);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 500);
  if (!ids.length) fail(400, 'Nothing selected');
  const list = db.messages[msgKey(c.id, params[1])] || [];
  const owner = c.createdBy === me.uid;
  const removed = [];
  for (const mid of ids) {
    const i = list.findIndex(x => x.id === mid);
    if (i < 0) continue;
    if (list[i].uid !== me.uid && !owner) continue;
    const [m] = list.splice(i, 1);
    if (m.url) fs.rm(path.join(UPLOAD_DIR, path.basename(m.url)), () => {});
    removed.push(m.id);
  }
  if (!removed.length) fail(403, 'You can only delete your own messages');
  save();
  for (const mid of removed) push(c.memberIds, { t: 'msg-deleted', chatId: c.id, ch: params[1], mid });
  return { deleted: removed.length, skipped: ids.length - removed.length };
});

/* Delete a whole conversation. A DM goes for both sides; a group only its owner can remove. */
route('DELETE', /^\/api\/chats\/([^/]+)$/, true, ({ me, params }) => {
  const c = memberChat(me, params[0]);
  if (c.type === 'group' && c.createdBy !== me.uid) fail(403, 'Only the owner can delete this group');
  const wasPublic = c.public, members = [...c.memberIds];
  for (const k of Object.keys(db.messages)) {
    if (!k.startsWith(c.id + ':')) continue;
    for (const m of db.messages[k]) if (m.url) fs.rm(path.join(UPLOAD_DIR, path.basename(m.url)), () => {});
    delete db.messages[k];
  }
  delete db.chats[c.id];
  save();
  push(members, { t: 'chat-removed', chatId: c.id });
  if (wasPublic) pushAll({ t: 'rooms' });
  return { ok: true };
});

/* Upload: POST /api/upload?name=<filename>, body is the raw file */
route('POST', /^\/api\/upload$/, true, async ({ query, req }) => {
  const name = (query.get('name') || 'file').slice(0, 200);
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const fname = id() + ext;
  const dest = path.join(UPLOAD_DIR, fname);
  const size = await streamToFile(req, dest, MAX_UPLOAD_MB * 1024 * 1024);
  if (!size) { fs.unlink(dest, () => {}); fail(400, 'No file received'); }
  return { file: { url: '/uploads/' + fname, name, size, mime: (req.headers['content-type'] || 'application/octet-stream').split(';')[0] } };
});

/* ================= HTTP server ================= */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };
function sendJson(res, status, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length }); res.end(b); }
function sendFile(res, file, cache, range) {
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const head = { 'Content-Type': type, 'Cache-Control': cache ? 'public, max-age=2592000, immutable' : 'no-cache', 'Accept-Ranges': 'bytes' };
    // Range requests let a browser seek inside a long video instead of downloading the whole thing first.
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
      let end = m[1] ? (m[2] ? Number(m[2]) : st.size - 1) : st.size - 1;
      start = Math.max(0, start); end = Math.min(st.size - 1, end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, `File must be under ${MAX_UPLOAD_MB} MB`)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
// Big files never sit in memory: pipe the request straight into data/uploads/.
function streamToFile(req, dest, limit) {
  return new Promise((resolve, reject) => {
    const tooBig = new HttpError(413, `File must be under ${MAX_UPLOAD_MB} MB`);
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return reject(tooBig); // refuse before a single byte is transferred
    const out = fs.createWriteStream(dest); let size = 0; let done = false;
    const stop = (err) => { if (done) return; done = true; out.destroy(); fs.unlink(dest, () => {}); reject(err); };
    // Stop reading but leave the socket alive so the 413 can still be written back.
    req.on('data', c => { size += c.length; if (size > limit) { req.unpipe(out); req.pause(); stop(tooBig); } });
    req.on('error', stop); out.on('error', stop);
    req.pipe(out);
    out.on('close', () => { if (!done) { done = true; resolve(size); } });
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/api/')) {
      const r = routes.find(x => x.m === req.method && x.re.test(p));
      if (!r) fail(404, 'Endpoint not found');
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const me = db.users[db.sessions[token]];
      if (r.needAuth && !me) fail(401, 'Please sign in first');
      const isUpload = p === '/api/upload';
      const raw = isUpload ? null : await readBody(req, 1024 * 1024); // uploads stream to disk inside the handler
      let body = {}; if (raw?.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Malformed request'); } }
      const out = await r.h({ me, token, params: p.match(r.re).slice(1), body, query: url.searchParams, raw, req });
      return sendJson(res, 200, out);
    }
    if (p.startsWith('/uploads/')) { const f = path.join(UPLOAD_DIR, path.basename(p)); return sendFile(res, f, true, req.headers.range); }
    const f = path.normalize(path.join(PUBLIC_DIR, p)); // static file, otherwise fall back to index.html
    if (f.startsWith(PUBLIC_DIR) && p !== '/' && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(res, f, false);
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), false);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e); return sendJson(res, 500, { error: 'Server error' });
  }
});
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  const uid = db.sessions[url.searchParams.get('token') || ''];
  if (url.pathname !== '/ws' || !key || !uid || !db.users[uid]) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true); attachWs(socket, uid);
});
server.listen(PORT, () => console.log(`EYEWALL → http://localhost:${PORT}   (data dir: ${DATA_DIR})`));
