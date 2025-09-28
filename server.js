const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;

// In-memory stores (prototype)
const users = {};      // username -> { password, id }
const sessions = {};   // token -> username
const servers = {};    // serverId -> { id, name, invite, channels: {name: [messages]}, members: Set }

// helpers
function genInvite(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function ensureServerData(sid) {
  if (!servers[sid]) {
    servers[sid] = { id: sid, name: sid, invite: genInvite(), channels: { general: [] }, members: new Set() };
  }
}

// --- Auth routes ---
app.post("/signup", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username & password required" });
  if (users[username]) return res.status(409).json({ error: "username exists" });
  users[username] = { password, id: uuidv4() };
  return res.json({ ok: true });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const u = users[username];
  if (!u || u.password !== password) return res.status(401).json({ error: "invalid credentials" });
  const token = uuidv4();
  sessions[token] = username;
  return res.json({ token, username });
});

app.get("/session/:token", (req, res) => {
  const username = sessions[req.params.token];
  if (!username) return res.status(401).json({ error: "invalid session" });
  res.json({ username });
});

// --- Server management ---
// create a new server: { name }
// returns { id, invite }
app.post("/server", (req, res) => {
  const { name, token } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const id = uuidv4();
  const invite = genInvite(8);
  servers[id] = { id, name, invite, channels: { general: [] }, members: new Set() };
  // add creator as member when token provided
  if (token && sessions[token]) servers[id].members.add(sessions[token]);
  return res.json({ id, name, invite });
});

// join server via invite code
// POST /join/:invite  { token }
app.post("/join/:invite", (req, res) => {
  const { invite } = req.params;
  const { token } = req.body;
  const username = token && sessions[token];
  if (!username) return res.status(401).json({ error: "invalid session/token" });
  const sid = Object.keys(servers).find(s => servers[s].invite === invite);
  if (!sid) return res.status(404).json({ error: "invite not found" });
  servers[sid].members.add(username);
  return res.json({ ok: true, serverId: sid, name: servers[sid].name });
});

// list servers current user is a member of
// GET /servers?token=...
app.get("/servers", (req, res) => {
  const token = req.query.token;
  const username = token && sessions[token];
  if (!username) return res.status(401).json({ error: "invalid session/token" });
  const mine = Object.values(servers).filter(s => s.members.has(username)).map(s => ({ id: s.id, name: s.name }));
  res.json(mine);
});

// list channels for a server
app.get("/channels/:serverId", (req, res) => {
  const sid = req.params.serverId;
  if (!servers[sid]) return res.status(404).json({ error: "server not found" });
  res.json(Object.keys(servers[sid].channels));
});

// create channel inside a server
app.post("/channels/:serverId", (req, res) => {
  const sid = req.params.serverId;
  const { name } = req.body;
  if (!servers[sid]) return res.status(404).json({ error: "server not found" });
  if (!name) return res.status(400).json({ error: "name required" });
  if (servers[sid].channels[name]) return res.status(409).json({ error: "channel exists" });
  servers[sid].channels[name] = [];
  return res.json({ ok: true, channel: name });
});

// get history for a channel in a server
app.get("/history/:serverId/:channel", (req, res) => {
  const { serverId, channel } = req.params;
  if (!servers[serverId]) return res.status(404).json({ error: "server not found" });
  if (!servers[serverId].channels[channel]) return res.status(404).json({ error: "channel not found" });
  res.json(servers[serverId].channels[channel].slice(-200));
});

// debug: list all servers (optional)
app.get("/debug/servers", (req, res) => {
  res.json(Object.values(servers).map(s => ({ id: s.id, name: s.name, invite: s.invite, channels: Object.keys(s.channels), members: Array.from(s.members) })));
});

// --- Start server + WebSocket ---
const server = app.listen(PORT, () => console.log(`RELINK backend on port ${PORT}`));
const wss = new WebSocket.Server({ server });

// broadcast to sockets matching serverId and optional channel
function broadcast(obj, serverId = null, channel = null) {
  const raw = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState !== WebSocket.OPEN) return;
    if (serverId && c.serverId !== serverId) return;
    if (channel && c.channel !== channel) return;
    c.send(raw);
  });
}

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // data.types:
    // joinServer: { type:'joinServer', token, serverId, channel? }
    // switchChannel: { type:'switch', channel }
    // message: { type:'message', token, text }
    if (data.type === "joinServer") {
      const { token, serverId, channel } = data;
      const username = token && sessions[token];
      if (!username) {
        ws.send(JSON.stringify({ type: "error", error: "invalid token" }));
        return;
      }
      if (!servers[serverId] || !servers[serverId].members.has(username)) {
        ws.send(JSON.stringify({ type: "error", error: "not a member of server" }));
        return;
      }
      ws.username = username;
      ws.serverId = serverId;
      ws.channel = channel || "general";

      // broadcast presence for that server/channel
      const users = Array.from(new Set(
        Array.from(wss.clients)
          .filter(c => c.serverId === ws.serverId && c.channel === ws.channel)
          .map(c => c.username)
          .filter(Boolean)
      ));
      broadcast({ type: "presence", serverId: ws.serverId, channel: ws.channel, users }, ws.serverId, ws.channel);
      return;
    }

    if (data.type === "switch") {
      const { channel } = data;
      ws.channel = channel;
      if (!ws.serverId) return;
      // update presence for new channel
      const users = Array.from(new Set(
        Array.from(wss.clients)
          .filter(c => c.serverId === ws.serverId && c.channel === ws.channel)
          .map(c => c.username)
          .filter(Boolean)
      ));
      broadcast({ type: "presence", serverId: ws.serverId, channel: ws.channel, users }, ws.serverId, ws.channel);
      return;
    }

    if (data.type === "message") {
      if (!ws.serverId) return;
      let username = ws.username || (data.token && sessions[data.token]) || "anonymous";
      const serverId = ws.serverId;
      const channel = ws.channel || data.channel || "general";

      if (!servers[serverId] || !servers[serverId].channels[channel]) {
        ws.send(JSON.stringify({ type: "error", error: "channel not found" }));
        return;
      }
      const msg = { id: uuidv4(), username, text: data.text, ts: Date.now(), serverId, channel };
      servers[serverId].channels[channel].push(msg);
      broadcast({ type: "message", message: msg }, serverId, channel);
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.serverId || !ws.channel) return;
    const users = Array.from(new Set(
      Array.from(wss.clients)
        .filter(c => c.serverId === ws.serverId && c.channel === ws.channel)
        .map(c => c.username)
        .filter(Boolean)
    ));
    broadcast({ type: "presence", serverId: ws.serverId, channel: ws.channel, users }, ws.serverId, ws.channel);
  });
});

// cleanup dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
