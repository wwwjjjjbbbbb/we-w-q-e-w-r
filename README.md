# EYEWALL

> `// the storm is watching_`

A drop-in multiplayer web chat. Dark navy, three columns: **channels on the left, conversation in the middle, friend and group status on the right.**
Messages read like a conversation: **yours on the right, everyone else's on the left.**
**Zero dependencies** — Node.js 18+ is all you need. No `npm install`.

## Features

- **Accounts** — nickname + password; pick an emoji avatar or upload an image
- **Friends** — search a nickname → profile card (avatar, presence, optional note) → send request. The other side gets a small toast; tapping it opens the full card with Accept / Decline
- **Accepted, live** — when someone takes your friend request you get a card the moment they tap Accept; opening it shows their avatar, name and whether they are online, with a button straight into the new DM
- **DMs and groups** — one-to-one messages; groups hold multiple `#` channels the owner can add or delete
- **Public groups** — listed under Explore, open for anyone to join
- **Anything sendable** — text, images (click to zoom), any file, and **video, big in both senses**:
  - *Big files* — up to **2 GB** per upload by default. The upload streams straight to disk, so a 300 MB clip costs the server almost no memory, and the composer shows a live `12.4 MB / 300 MB · 4%` readout while it goes
  - *Big picture* — a clip fills the width of the conversation column (up to 1000px, up to 78% of the screen height) instead of sitting in a thumbnail, with normal playback and fullscreen controls
  - Playback uses HTTP range requests, so viewers can drag the scrubber into the middle of a long video without downloading the whole file first
- **Hearts** — every message, video included, carries a heart button underneath. Tap it as many times as you want: each tap adds a random 5–16 and floats the amount up. Totals are shared with everyone (hover to see who tapped and how much). Tune the range with `LIKE_MIN` / `LIKE_MAX` at the top of `server.js`
- **Choose the time a message shows** — the clock in the composer sets any date and time; messages you send then carry it instead of the real one and sort into that place in the conversation. The real send time is kept and shown on hover, and the timestamp is marked so nobody is misled about which is which. Clear it and you are back on the live clock
- **Delete** — a message at a time, or open the conversation menu (⋮) to select several and remove them in one go; "Select every photo and video" ticks all the media at once. Deleting a message removes its file from the server too
- **Delete a whole conversation** — same menu: a DM goes for both sides, a group only its owner can delete (it disappears for every member, with every message and upload); anyone else gets Leave instead
- **Right-hand status rail** — friends online/offline, pending requests you can act on inline, and every group's `online / total` with the time of the last message
- **Realtime** — WebSocket push for messages, presence and friend activity
- **Phantom members** — the owner can conjure hundreds of members so a new group looks alive (they never speak)
- **One layout, every screen**
  - Desktop (>900px): three columns side by side
  - Phone and portrait tablet (≤900px): single column with a bottom tab bar (Chats / Friends / Explore / Me), full-screen conversations, status as a right-hand drawer; notch and home-indicator safe areas handled, and inputs never trigger the iOS zoom

## Layout

```
├── server.js         backend (HTTP API + WebSocket + JSON file storage, no deps)
├── public/index.html frontend (single file)
├── data/             created on first run: db.json and uploads/
├── test/             smoke.mjs (API) and ui.cjs (browser)
├── start.bat         double-click launcher for Windows
├── Dockerfile        container deploy
├── render.yaml       one-click Render deploy (free plan, data is wiped on restart)
└── render-persistent.yaml   paid Render deploy with a disk — nothing is ever wiped
```

## Run it locally

```bash
node server.js      # → http://localhost:3000
```

On Windows just double-click `start.bat`. Anyone on the same Wi-Fi can join at `http://<your-lan-ip>:3000`.

## Put it on the public internet

Anyone, on any device, opens the same URL, registers, and can add friends, create groups and chat.

### Option A — Render (easiest, free tier)

1. Upload the whole folder to a GitHub repository
2. Open <https://dashboard.render.com> → **New → Blueprint** → pick the repo → Apply. It reads `render.yaml` and deploys
3. A few minutes later you get `https://xxx.onrender.com`. Share it

`render.yaml` ships with the **free plan**: no cost, but the service sleeps after ~15 idle minutes (the next visitor waits ~1 minute for it to wake), and **a restart wipes all accounts, messages and uploads**.

#### Keeping the data (paid)

Nothing is stored permanently until the service has a **persistent disk**, and Render only attaches a disk to a paid instance. The repo ships `render-persistent.yaml` ready for that: delete `render.yaml`, rename `render-persistent.yaml` to `render.yaml`, push, and redeploy.

| | list price |
|---|---|
| Starter instance (512 MB RAM, never sleeps) | $7.00 / month |
| Persistent disk | $0.25 / GB / month — 10 GB is $2.50 |
| **Total** | **about $9.50 / month** |

Check <https://render.com/pricing> for today's numbers. A service with a disk runs as a single instance, so each deploy has a few seconds of downtime.

**Sizing the disk.** Videos are what fill it. 10 GB holds roughly 100 clips of 100 MB. You can grow a disk in the dashboard but never shrink it, so start small. Keep `MAX_UPLOAD_MB` well below the disk size.

#### Keeping the data for free

If you would rather not pay, run `node server.js` on a computer you leave on and put a free tunnel in front of it — [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives a public HTTPS address at no cost. The data then lives on your own disk, with as much space as that machine has, and you can back it up by copying the `data/` folder. The catch is that the chat is only reachable while that computer is awake and online.

### Option B — Railway / Zeabur / Fly.io

Deploy straight from the GitHub repo or the Dockerfile. Point `DATA_DIR` at a **persistent volume**; the port comes from the platform's `PORT` (already handled in code).

### Option C — your own server

```bash
DATA_DIR=/var/eyewall PORT=3000 nohup node server.js > log.txt 2>&1 &
```

Then put Caddy in front for automatic HTTPS (WebSocket upgrades pass through on their own):

```
chat.example.com {
    reverse_proxy localhost:3000
}
```

### Docker

```bash
docker build -t eyewall .
docker run -d -p 3000:3000 -v eyewall-data:/data eyewall
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | listening port |
| `DATA_DIR` | `./data` | where the database and uploads live |
| `MAX_UPLOAD_MB` | 2048 | per-file size cap in MB. Uploads stream straight to disk, so the practical limit is free disk space, not RAM |
| `MSG_KEEP` | 2000 | messages kept per channel |

## Notes and limits

- Passwords are salted and hashed with scrypt; the session is a random token kept in the browser
- Everything lives in one JSON file — fine for tens to a few hundred people. Beyond that, swap in SQLite or Postgres; the API doesn't change
- Group owners can delete anyone's message and manage channels and phantom members; everyone else can only delete their own

## Tests

```bash
PORT=3456 node server.js &
node test/smoke.mjs      # API + WebSocket
node test/ui.cjs         # needs playwright; writes test/desktop.png and test/mobile.png
```
