const path = require("path");
const { chromium } = require("playwright");

const FEED_URL = "https://www.linkedin.com/feed/";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PROFILE_DIR = path.join(__dirname, "..", ".chrome-profile");

function extractCards() {
  function clean(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const timePattern = /^(?:now|just now|\d+[smhdw]|\d+mo|\d+yr)$/i;
  const degreePattern = /^•\s*(1st|2nd|3rd\+)$/;

  function paragraphsOf(card) {
    return [...card.querySelectorAll("p")]
      .map((paragraph) => clean(paragraph.innerText))
      .filter((text) => text && !/modal window|dialog window/i.test(text));
  }

  function countFrom(texts, word) {
    const pattern = new RegExp("^([\\d,]+)\\s+" + word + "\\b", "i");
    for (const text of texts) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return "";
  }

  function hiddenCount(card, word) {
    const pattern = new RegExp("^([\\d,]+)\\s+" + word + "$", "i");
    for (const node of card.querySelectorAll('[aria-hidden="true"]')) {
      const match = clean(node.textContent).match(pattern);
      if (match) return match[1];
    }
    return "";
  }

  function reactionFallback(texts) {
    for (const text of texts) {
      const others = text.match(/\band\s+([\d,]+)\s+others?\s+reacted\b/i);
      if (others) {
        const extra = Number(others[1].replace(/,/g, ""));
        if (Number.isFinite(extra)) return String(1 + extra);
      }
      if (/\breacted\b/i.test(text) && !/\breactions?\b/i.test(text)) return "1";
    }
    return "";
  }

  function postUrl(card) {
    const fiberKey = Object.keys(card).find((key) => key.startsWith("__reactFiber"));
    if (!fiberKey) return "";
    let fiber = card[fiberKey];
    for (let step = 0; fiber && step < 30; step += 1) {
      const detection = fiber.memoizedProps && fiber.memoizedProps.duplicateDetection;
      const urn = detection && detection.dedupeId;
      if (typeof urn === "string" && urn.length) {
        if (/^urn:li:(?:ugcPost|activity|share|groupPost):\d+$/.test(urn)) {
          return "https://www.linkedin.com/feed/update/" + urn + "/";
        }
        return "";
      }
      fiber = fiber.return;
    }
    return "";
  }

  function profileUrl(card, author) {
    const link = [...card.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')].find(
      (anchor) => clean(anchor.innerText).startsWith(author)
    );
    if (!link) return "";
    try {
      const url = new URL(link.href);
      return url.origin + url.pathname.replace(/\/$/, "");
    } catch (_error) {
      return "";
    }
  }

  function externalLinks(card) {
    const found = [];
    function keep(value) {
      try {
        const url = new URL(value);
        if (url.protocol === "http:" || url.protocol === "https:") found.push(url.href);
      } catch (_error) {
        /* Ignore a link that is not a web address. */
      }
    }
    for (const anchor of card.querySelectorAll("a[href]")) {
      const href = anchor.href;
      if (!href || href.includes("/search/results/")) continue;
      if (href.includes("/safety/go/")) {
        try {
          const destination = new URL(href).searchParams.get("url");
          if (destination) keep(destination);
        } catch (_error) {
          /* Skip a malformed LinkedIn safety redirect. */
        }
        continue;
      }
      if (href.includes("linkedin.com")) continue;
      keep(href);
    }
    return [...new Set(found)];
  }

  const posts = [];
  const cards = document.querySelectorAll('[id^="expanded"][id*="FeedType_MAIN_FEED"]');

  for (const card of cards) {
    if (card.id.includes("replaceableCommentTools")) continue;

    const paragraphs = paragraphsOf(card);
    if (paragraphs.some((text) => text === "Promoted")) continue;

    const menu = card.querySelector('[aria-label^="Open control menu for post by "]');
    const author = menu
      ? clean(menu.getAttribute("aria-label").replace(/^Open control menu for post by\s+/, ""))
      : "";
    if (!author) continue;

    const authorIndex = paragraphs.findIndex(
      (text) => text === author || text.startsWith(author)
    );
    const degreeText = paragraphs.find((text) => degreePattern.test(text)) || "";
    const degree = degreeText.replace(/^•\s*/, "");
    const searchFrom = authorIndex === -1 ? 0 : authorIndex;
    let timeIndex = -1;
    for (let index = searchFrom + 1; index < paragraphs.length; index += 1) {
      if (timePattern.test(paragraphs[index])) {
        timeIndex = index;
        break;
      }
    }

    const degreeIndex = degreeText ? paragraphs.indexOf(degreeText) : searchFrom;
    const headlineStart = Math.max(degreeIndex, searchFrom) + 1;
    const headlineEnd = timeIndex === -1 ? paragraphs.length : timeIndex;
    const headline = paragraphs
      .slice(headlineStart, headlineEnd)
      .filter((text) => {
        if (text === author || text === "Suggested" || text === "Promoted") return false;
        if (degreePattern.test(text) || timePattern.test(text)) return false;
        if (/followers$/i.test(text) || /^view my services$/i.test(text)) return false;
        if (/likes this$/i.test(text) || /finds this/i.test(text)) return false;
        if (/\b(reacted|reactions?|comments?|reposts?)\b/i.test(text)) return false;
        if (text.length > 280) return false;
        return true;
      })
      .join(" · ");

    const body = card.querySelector('[data-testid="expandable-text-box"]');
    const text = clean(body && body.innerText)
      .replace(/\s*…\s*more$/i, "")
      .replace(/\s*\.\.\.\s*more$/i, "");

    posts.push({
      id: card.id.replace(/^expanded/, "").replace(/FeedType_MAIN_FEED.*$/, ""),
      author,
      headline,
      degree,
      text,
      time: timeIndex === -1 ? "" : paragraphs[timeIndex],
      reactions:
        countFrom(paragraphs, "reactions?") ||
        hiddenCount(card, "reactions?") ||
        reactionFallback(paragraphs),
      comments: countFrom(paragraphs, "comments?") || hiddenCount(card, "comments?"),
      reposts: countFrom(paragraphs, "reposts?") || hiddenCount(card, "reposts?"),
      profileUrl: profileUrl(card, author),
      postUrl: postUrl(card),
      links: externalLinks(card),
      suggested: paragraphs.some((item) => item === "Suggested"),
      hasVideo: Boolean(card.querySelector("video")),
      hasImage: Boolean(card.querySelector('img[alt="View image"]')),
    });
  }

  return posts;
}

async function expandPostText(page) {
  const buttons = page.locator(
    '[id^="expanded"][id*="FeedType_MAIN_FEED"] [data-testid="expandable-text-button"]'
  );
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const inComments = await button
      .evaluate((element) => Boolean(element.closest('[id*="replaceableCommentTools"]')))
      .catch(() => true);
    if (inComments) continue;
    const label = await button.innerText().catch(() => "");
    if (!/more/i.test(label)) continue;
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 1500 }).catch(() => {});
  }
  if (count > 0) await page.waitForTimeout(400);
}

async function revealMore(page) {
  await page.evaluate(() => {
    window.scrollBy(0, Math.max(700, Math.round(window.innerHeight * 0.9)));
  });
  await page.waitForTimeout(1400);
  const loadMore = page.getByRole("button", { name: /^Load more$/ });
  if ((await loadMore.count()) === 0) return;
  const button = loadMore.first();
  if (!(await button.isVisible().catch(() => false))) return;
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click({ timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function feedIsReady(page) {
  return page
    .evaluate(() => {
      const loginForm = Boolean(document.querySelector('input[name="session_key"]'));
      const loginUrl = /\/(login|checkpoint|authwall)|uas\/login/.test(location.href);
      const cards = document.querySelectorAll('[id^="expanded"][id*="FeedType_MAIN_FEED"]').length;
      const main = Boolean(document.querySelector("main#workspace"));
      return location.pathname.startsWith("/feed") && main && cards > 0 && !loginForm && !loginUrl;
    })
    .catch(() => false);
}

async function waitForFeed(page, { onStatus, shouldStop }) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (shouldStop()) return false;
    if (await feedIsReady(page)) return true;
    onStatus("Waiting for you to log in to LinkedIn in the Chrome window.", "waiting");
    await page.waitForTimeout(1000);
  }
  throw new Error("Timed out after 10 minutes waiting for LinkedIn login.");
}

async function collectFeed({ limit, onStatus, onPost, shouldStop }) {
  onStatus("Opening LinkedIn in Chrome.", "waiting");
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });

  const seen = new Set();
  let collected = 0;

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(FEED_URL, { waitUntil: "domcontentloaded" });
    const ready = await waitForFeed(page, { onStatus, shouldStop });
    if (!ready) {
      return { message: `Stopped. ${collected} posts collected.` };
    }

    onStatus("Reading your feed.", "reading");
    let quietPasses = 0;

    while (!shouldStop() && collected < limit && quietPasses < 3) {
      await expandPostText(page);
      const cards = await page.evaluate(extractCards);
      let added = 0;

      for (const card of cards) {
        if (shouldStop() || collected >= limit) break;
        if (!card.id || seen.has(card.id)) continue;
        seen.add(card.id);
        collected += 1;
        added += 1;
        onPost(card);
        onStatus(`Reading your feed. ${collected} of ${limit} posts collected.`, "reading");
      }

      if (collected >= limit || shouldStop()) break;
      quietPasses = added === 0 ? quietPasses + 1 : 0;
      if (quietPasses >= 3) break;
      await revealMore(page);
    }

    if (shouldStop()) return { message: `Stopped. ${collected} posts collected.` };
    if (collected >= limit) return { message: `Collected ${collected} posts.` };
    return { message: `Collected ${collected} posts. Nothing newer loaded.` };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { collectFeed };
