const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;

// --- In-memory stores ---
const users = {}; // username -> { password, id }
const sessions = {}; // token -> username
const channels = { general: [] }; // channel -> [messages]

// --- REST routes ---
app.post("/signup", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "username & password required" });
  if (users[username])
    return res.status(409).json({ error: "username exists" });

  users[username] = { password, id: uuidv4() };
  res.json({ ok: true });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const u = users[username];
  if (!u || u.password !== password)
    return res.status(401).json({ error: "invalid credentials" });

  const token = uuidv4();
  sessions[token] = username;
  res.json({ token, username });
});

// Get messages for a channel
app.get("/history/:channel", (req, res) => {
  const ch = req.params.channel;
  if (!channels[ch]) return res.status(404).json({ error: "channel not found" });
  res.json(channels[ch].slice(-200));
});

// Create a new channel
app.post("/channel", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  if (channels[name]) return res.status(409).json({ error: "channel exists" });

  channels[name] = [];
  res.json({ ok: true, channel: name });
});

// List channels
app.get("/channels", (req, res) => {
  res.json(Object.keys(channels));
});

// --- Start HTTP server ---
const server = app.listen(PORT, () =>
  console.log(`RELINK backend on port ${PORT}`)
);

// --- WebSocket server ---
const wss = new WebSocket.Server({ server });

function broadcast(obj, channel) {
  const raw = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN && (!channel || c.channel === channel)) {
      c.send(raw);
    }
  });
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "join") {
      let username = data.username;
      if (data.token && sessions[data.token]) {
        username = sessions[data.token];
      }
      ws.username = username || "anonymous";
      ws.channel = data.channel || "general";

      broadcast(
        {
          type: "presence",
          users: Array.from(
            new Set(
              Array.from(wss.clients)
                .filter((c) => c.channel === ws.channel)
                .map((c) => c.username)
            )
          ),
        },
        ws.channel
      );
    }

    if (data.type === "switch") {
      ws.channel = data.channel;
    }

    if (data.type === "message") {
      let username = ws.username || "anonymous";
      if (data.token && sessions[data.token]) {
        username = sessions[data.token];
      }
      const msg = {
        id: uuidv4(),
        username,
        text: data.text,
        ts: Date.now(),
        channel: ws.channel || "general",
      };
      channels[msg.channel] = channels[msg.channel] || [];
      channels[msg.channel].push(msg);
      broadcast({ type: "message", message: msg }, msg.channel);
    }
  });

  ws.on("close", () => {
    if (!ws.channel) return;
    broadcast(
      {
        type: "presence",
        users: Array.from(
          new Set(
            Array.from(wss.clients)
              .filter((c) => c.channel === ws.channel)
              .map((c) => c.username)
          ),
        ),
      },
      ws.channel
    );
  });
});

// cleanup dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
