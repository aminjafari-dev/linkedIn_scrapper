const feed = document.querySelector("#feed");
const statusLine = document.querySelector("#status");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const limitInput = document.querySelector("#limit");
const form = document.querySelector("#controls");

const posts = [];

function safeHttp(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch (_error) {
    /* Leave a non-web address out of the page. */
  }
  return "";
}

function setStatus(status) {
  statusLine.textContent = status.message;
  statusLine.dataset.phase = status.phase || "idle";
  const busy = status.phase === "waiting" || status.phase === "reading";
  startButton.disabled = busy;
  stopButton.disabled = !busy;
  limitInput.disabled = busy;
}

function metaChip(label) {
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = label;
  return chip;
}

function renderPost(post) {
  const article = document.createElement("article");
  article.className = "card";

  const header = document.createElement("header");
  const name = document.createElement("h2");
  name.className = "author";
  const profileUrl = safeHttp(post.profileUrl);
  if (profileUrl) {
    const link = document.createElement("a");
    link.href = profileUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = post.author;
    name.append(link);
  } else {
    name.textContent = post.author;
  }

  const time = document.createElement("p");
  time.className = "time";
  time.textContent = [post.degree, post.time].filter(Boolean).join(" · ");
  header.append(name, time);
  article.append(header);

  if (post.headline) {
    const headline = document.createElement("p");
    headline.className = "headline";
    headline.textContent = post.headline;
    article.append(headline);
  }

  if (post.text) {
    const text = document.createElement("p");
    text.className = "text";
    text.textContent = post.text;
    article.append(text);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  if (post.suggested) meta.append(metaChip("Suggested"));
  if (post.reactions) meta.append(metaChip(`${post.reactions} reactions`));
  if (post.comments) meta.append(metaChip(`${post.comments} comments`));
  if (post.reposts) meta.append(metaChip(`${post.reposts} reposts`));
  if (post.hasVideo) meta.append(metaChip("Video"));
  if (post.hasImage) meta.append(metaChip("Image"));
  if (meta.childElementCount) article.append(meta);

  if (post.links && post.links.length) {
    const list = document.createElement("ul");
    list.className = "links";
    for (const href of post.links) {
      const safeHref = safeHttp(href);
      if (!safeHref) continue;
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = safeHref;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = safeHref;
      item.append(link);
      list.append(item);
    }
    if (list.childElementCount) article.append(list);
  }

  return article;
}

function render() {
  feed.replaceChildren();
  if (!posts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Collected posts will show up here.";
    feed.append(empty);
    return;
  }
  for (const post of posts) feed.append(renderPost(post));
}

function applyEvent(event) {
  if (event.type === "snapshot") {
    posts.splice(0, posts.length, ...(event.posts || []));
    setStatus(event.status);
    render();
    return;
  }
  if (event.type === "reset") {
    posts.splice(0, posts.length);
    render();
    return;
  }
  if (event.type === "status") {
    setStatus(event);
    return;
  }
  if (event.type === "post") {
    posts.push(event.post);
    render();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const limit = Number(limitInput.value);
  startButton.disabled = true;
  const response = await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    setStatus({ phase: "error", message: body.error || "Could not start." });
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  await fetch("/api/stop", { method: "POST" });
});

const stream = new EventSource("/api/events");
stream.addEventListener("message", (event) => {
  applyEvent(JSON.parse(event.data));
});
stream.onerror = () => {
  if (statusLine.dataset.phase === "waiting" || statusLine.dataset.phase === "reading") return;
  setStatus({ phase: "error", message: "Lost the connection to the local reader." });
};

render();
