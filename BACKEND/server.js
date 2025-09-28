const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;

// --- In-memory stores for prototype ---
const users = {}; // username -> { password, id }
const sessions = {}; // token -> username
const messages = []; // { id, username, text, ts }

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

app.get("/session/:token", (req, res) => {
  const username = sessions[req.params.token];
  if (!username) return res.status(401).json({ error: "invalid session" });
  res.json({ username });
});

app.get("/history", (req, res) => {
  res.json(messages.slice(-200));
});

// --- Start HTTP server ---
const server = app.listen(PORT, () =>
  console.log(`RELINK backend on port ${PORT}`)
);

// --- WebSocket server ---
const wss = new WebSocket.Server({ server });

function broadcast(obj) {
  const raw = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(raw);
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

      const online = Array.from(
        new Set(Array.from(wss.clients).map((c) => c.username).filter(Boolean))
      );
      broadcast({ type: "presence", users: online });
    }

    if (data.type === "message") {
      let username = ws.username || "anonymous";
      if (data.token && sessions[data.token]) {
        username = sessions[data.token];
      }
      const msg = { id: uuidv4(), username, text: data.text, ts: Date.now() };
      messages.push(msg);
      broadcast({ type: "message", message: msg });
    }
  });

  ws.on("close", () => {
    const online = Array.from(
      new Set(Array.from(wss.clients).map((c) => c.username).filter(Boolean))
    );
    broadcast({ type: "presence", users: online });
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
