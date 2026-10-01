const fs = require("fs");
const path = require("path");
const express = require("express");
const { collectFeed } = require("./scraper");

const PORT = Number(process.env.PORT) || 4173;
const DATA_PATH = path.join(__dirname, "..", "data", "posts.json");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let posts = [];
let status = { phase: "idle", message: "Press Start to open LinkedIn." };
let running = false;
let stopRequested = false;
const clients = new Set();

function loadSaved() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    if (Array.isArray(saved.posts)) posts = saved.posts;
  } catch (_error) {
    posts = [];
  }
}

function savePosts() {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(
    DATA_PATH,
    JSON.stringify({ updatedAt: new Date().toISOString(), posts }, null, 2)
  );
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(payload);
}

function setStatus(phase, message) {
  status = { phase, message };
  broadcast({ type: "status", phase, message });
}

app.get("/api/posts", (_req, res) => {
  res.json({ posts, status });
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "snapshot", posts, status })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

app.post("/api/start", (req, res) => {
  if (running) {
    res.status(409).json({ error: "A collection is already running." });
    return;
  }

  let limit = Number(req.body && req.body.limit);
  if (!Number.isFinite(limit)) limit = 20;
  limit = Math.max(1, Math.min(100, Math.round(limit)));

  running = true;
  stopRequested = false;
  posts = [];
  savePosts();
  broadcast({ type: "reset" });
  setStatus("waiting", "Opening LinkedIn in Chrome.");
  res.json({ ok: true, limit });

  collectFeed({
    limit,
    shouldStop: () => stopRequested,
    onStatus: (message, phase) => setStatus(phase || "reading", message),
    onPost: (post) => {
      posts.push(post);
      savePosts();
      broadcast({ type: "post", post });
    },
  })
    .then((result) => {
      const phase = stopRequested ? "stopped" : "done";
      setStatus(phase, result.message);
    })
    .catch((error) => {
      setStatus("error", error.message || "Collection failed.");
    })
    .finally(() => {
      running = false;
      stopRequested = false;
    });
});

app.post("/api/stop", (_req, res) => {
  if (!running) {
    res.json({ ok: true, running: false });
    return;
  }
  stopRequested = true;
  setStatus("reading", "Stopping after the current step.");
  res.json({ ok: true });
});

loadSaved();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`LinkedIn feed reader at http://127.0.0.1:${PORT}`);
});
