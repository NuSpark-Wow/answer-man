// The Answer Man (Ask Mr. Paul) — answer engine
// Vercel serverless function. No packages needed.
//
// Environment variables (Vercel > Project > Settings > Environment Variables):
//   ANTHROPIC_API_KEY        required
//   UPSTASH_REDIS_REST_URL   recommended (or KV_REST_API_URL)   — limits + answer cache
//   UPSTASH_REDIS_REST_TOKEN recommended (or KV_REST_API_TOKEN)
//   TURNSTILE_SITE_KEY       optional — invisible "are you human" check
//   TURNSTILE_SECRET_KEY     optional
//   Optional tuning: MODEL, RANKING_MODEL, DAILY_QUESTIONS, DAILY_LISTS,
//                    DAILY_GLOBAL, RANKING_SIZES, ALLOWED_HOSTS

const MODEL = process.env.MODEL || "claude-haiku-5-5";
const RANKING_MODEL = process.env.RANKING_MODEL || "claude-sonnet-5-5";
const DAILY_QUESTIONS = parseInt(process.env.DAILY_QUESTIONS || "15", 10);
const DAILY_LISTS = parseInt(process.env.DAILY_LISTS || "3", 10);
const DAILY_GLOBAL = parseInt(process.env.DAILY_GLOBAL || "1500", 10);
const RANKING_SIZES = (process.env.RANKING_SIZES || "25,50,100")
  .split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => [25, 50, 100].includes(n));
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ||
  "nusparklearnwow.com,nusparkpublishing.com,nusparkmarketing.com")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const DOORS = ["who", "what", "where", "when", "why", "how"];
const MODES = ["normal", "simplify", "deeper"];
const EXPERIENCES = [
  "Mr. Paul's Classroom", "The Lecture Hall", "Remember When", "How It Works",
  "What's the Difference?", "The AI Encyclopedias", "Debate Me", "The Guess Room",
  "The Puzzle Parlor",
];

// ---------- Mr. Paul's rules ----------
const BASE_RULES = `You are Mr. Paul, "The Answer Man" — a friendly, clear, trustworthy knowledge guide on the NuSpark Learn...Wow! site. You answer knowledge questions in plain language anyone can follow. No fluff, no filler, no sales talk.

RULES
1. Knowledge only. You are not a directory, store, or local guide. Never give maps, addresses, directions, phone numbers, hours, or "near me" results. Never use or ask for the person's location.
2. Companies: you may name a company only as fact or history (who founded it, when, what it invented or changed). Never recommend, rank, compare, review, or list companies, brands, products, apps, or services, and never point anyone to a business. Shopping-style questions ("best CRM", "which phone should I buy", "software companies near me") get type "redirect": explain kindly that Mr. Paul answers knowledge questions, and offer the knowledge version (for example, how CRM software works and what features matter).
3. Never rank. For "best / top / greatest / favorite / #1 / must-see" questions about things that are a matter of opinion (places, foods, movies, people...), do not pick a winner. Open with exactly: "I don't rank things like this, because 'best' depends on what you're looking for. Here's a list, in alphabetical order, with what makes each one stand out." Then return type "list" with items in A–Z order, each with a short neutral description. Never use the words best, most popular, can't-miss, my pick, or favorite in your own voice.
4. Measurable facts are not rankings. Tallest, largest, fastest, oldest, most populous and similar measurable questions get a straight answer.
5. "Best way to..." questions: explain the common methods and how each works; do not crown one.
6. Be neutral on contested political, religious, and social topics: explain the main positions fairly and plainly, take no side.
7. Health, legal, and money questions: give general educational information only, never personal advice, and say to check with a doctor, lawyer, or financial professional.
8. Keep everything family-friendly. If a question is inappropriate or unsafe, return type "redirect" with a gentle, kind reply and a better question to ask.
9. Accuracy first. If you are not sure, say so plainly. Use web search only when the answer depends on current or recent information.
10. Write like a warm, smart teacher talking to a curious person. Short paragraphs. No markdown symbols (no #, *, or **).

OUTPUT
Reply with ONLY one JSON object, nothing before or after it:
{
  "type": "answer" | "list" | "redirect",
  "title": "short title for the card",
  "answer": "the answer — 1 to 3 short paragraphs separated by \\n\\n (for a list: the one-line opening sentence)",
  "facts": ["2 to 4 short key facts or wow facts"] ,
  "items": [{"name": "...", "reason": "one line"}],
  "explore": "one name from this list that fits the question best, or empty string: ${EXPERIENCES.join(" | ")}"
}
Use "items" only for type "list" (otherwise an empty array). "facts" may be empty for redirects.`;

const DOOR_GUIDE = {
  who: "WHO door: answer about a person or group — who they are, what they're known for, and why it matters. Include one wow fact.",
  what: "WHAT door: give a plain definition, a simple everyday example, and why it matters.",
  where: "WHERE door: geography and places as knowledge — where it is, what it's like, why it matters. Describe it in words; never give maps, addresses, or directions.",
  when: "WHEN door: give the date or time period, plus a mini timeline in the facts: what came before, the moment itself, what came after.",
  why: "WHY door: explain cause and effect, step by step, in plain language.",
  how: "HOW door: explain how it works or how it's done as clear steps, written as short sentences in the answer.",
};

const MODE_GUIDE = {
  normal: "Give one clear, straight answer for a general audience.",
  simplify: "SIMPLIFY: explain the same answer so an 8-year-old would get it. Short sentences, an everyday comparison, no jargon.",
  deeper: "GO DEEPER: give a richer answer with more detail, the why behind it, and 4 to 6 extra facts. Up to 4 paragraphs.",
};

function rankingRules(size) {
  return `${BASE_RULES}

RANKING RESEARCH MODE
The person picked a topic and wants a list of ${size}. Mr. Paul never picks a #1. Instead, research what shows up most often across published rankings and lists for this topic (use web search), and return exactly ${size} items (or fewer if the topic truly has fewer) as type "list".
- "title": "Ranking Research: <topic>"
- "answer": "What shows up most across published rankings, listed A–Z. Mr. Paul doesn't pick a #1."
- "items": in A–Z order; each "reason" is ONE short line (about 12 words max) saying why it keeps making the lists. No numbers, no "#1", no superlatives in your own voice.
- "facts": 1 or 2 short notes on what kinds of sources were looked at (no links).
- Companies, brands, products, and businesses are NOT allowed as a list topic (rule 2). If the topic is one, return type "redirect" and suggest a knowledge topic instead.`;
}

// ---------- helpers ----------
async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${R_TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const j = await r.json();
    return j.result ?? null;
  } catch {
    return null;
  }
}

async function bump(key) {
  const n = await redis(["INCR", key]);
  if (n === 1) await redis(["EXPIRE", key, 90000]);
  return n;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function clientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.headers["x-real-ip"] || "unknown";
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  const selfHost = (req.headers.host || "").split(":")[0].toLowerCase();
  if (host === selfHost) return true;
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret, response: token, remoteip: ip });
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const j = await r.json();
    return !!j.success;
  } catch {
    return false;
  }
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function sortKey(name) {
  return String(name || "").replace(/^(the|a|an)\s+/i, "").toLowerCase();
}

async function askClaude({ model, system, user, maxTokens, maxSearches }) {
  const messages = [{ role: "user", content: user }];
  let data;
  for (let turn = 0; turn < 4; turn++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
      }),
    });
    data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `API error ${r.status}`);
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    break;
  }
  // Use only the text written after the last search result
  const blocks = data.content || [];
  let lastTool = -1;
  blocks.forEach((b, i) => { if (b.type === "web_search_tool_result") lastTool = i; });
  const text = blocks.slice(lastTool + 1).filter((b) => b.type === "text").map((b) => b.text).join("");
  return text;
}

function unescapeJson(s) {
  s = s.replace(/\\+$/, "");
  try { return JSON.parse('"' + s + '"'); } catch { return s.replace(/\\n/g, "\n").replace(/\\"/g, '"'); }
}

// Pull readable parts out of a reply that isn't clean JSON (for example, cut off mid-way)
function salvage(text) {
  const str = (key) => {
    const m = text.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
    return m ? unescapeJson(m[1]) : "";
  };
  const done = (block) => {
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)"\s*[,\]]/g;
    let m;
    while ((m = re.exec(block))) out.push(unescapeJson(m[1]));
    return out;
  };
  const type = str("type");
  const title = str("title");
  const answer = str("answer");
  let facts = [];
  const fi = text.indexOf('"facts"');
  if (fi !== -1) {
    const after = text.slice(text.indexOf("[", fi) + 1);
    facts = done(after.split("]")[0] + (after.includes("]") ? "]" : ""));
  }
  const items = [];
  const itemRe = /\{\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let im;
  while ((im = itemRe.exec(text))) items.push({ name: unescapeJson(im[1]), reason: unescapeJson(im[2]) });
  if (!answer && !items.length) {
    const plain = text.replace(/[{}\[\]"]/g, " ").replace(/\s+/g, " ").trim();
    return { type: "answer", title: "Here's your answer", answer: plain, facts: [], items: [], explore: "", partial: true };
  }
  return { type: type || (items.length ? "list" : "answer"), title, answer, facts, items, explore: str("explore"), partial: true };
}

function parseCard(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let card = null;
  if (start !== -1 && end > start) {
    try { card = JSON.parse(text.slice(start, end + 1)); } catch { card = null; }
  }
  if (!card) card = salvage(start !== -1 ? text.slice(start) : text);
  card.type = ["answer", "list", "redirect"].includes(card.type) ? card.type : "answer";
  card.title = String(card.title || "Here's your answer");
  card.answer = String(card.answer || "");
  card.facts = Array.isArray(card.facts) ? card.facts.map(String).filter(Boolean).slice(0, 8) : [];
  card.items = Array.isArray(card.items)
    ? card.items.filter((i) => i && i.name).map((i) => ({ name: String(i.name), reason: String(i.reason || "") }))
    : [];
  // Enforce the no-ranking rule: lists are always A–Z
  card.items.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
  card.explore = EXPERIENCES.includes(card.explore) ? card.explore : "";
  return card;
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "",
      rankingSizes: RANKING_SIZES.length ? RANKING_SIZES : [25],
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!originAllowed(req)) return res.status(403).json({ error: "Not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Mr. Paul isn't set up yet." });

  const body = req.body || {};
  const kind = body.kind === "ranking" ? "ranking" : "question";
  const question = String(body.question || "").trim().slice(0, 300);
  const door = DOORS.includes(body.door) ? body.door : "what";
  const mode = MODES.includes(body.mode) ? body.mode : "normal";
  let size = parseInt(body.size, 10);
  if (!RANKING_SIZES.includes(size)) size = RANKING_SIZES[0] || 25;
  const visitor = String(body.visitor || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  const ip = clientIp(req);

  if (question.length < 2) return res.status(400).json({ error: "Please type a question." });

  // 1) Cached answers are instant and cost nothing
  const cacheKey = kind === "ranking"
    ? `amp:cache:v2:rank:${size}:${normalize(question)}`
    : `amp:cache:v2:q:${door}:${mode}:${normalize(question)}`;
  const cached = await redis(["GET", cacheKey]);
  if (cached) {
    try { return res.status(200).json({ card: JSON.parse(cached), cached: true }); } catch { /* fall through */ }
  }

  // 2) Human check
  if (!(await verifyTurnstile(body.turnstileToken, ip))) {
    return res.status(403).json({ error: "Quick check failed. Please refresh the page and try again." });
  }

  // 3) Limits
  const day = today();
  const limit = kind === "ranking" ? DAILY_LISTS : DAILY_QUESTIONS;
  const tag = kind === "ranking" ? "r" : "q";
  const ipKey = `amp:${tag}:ip:${ip}:${day}`;
  const visKey = visitor ? `amp:${tag}:v:${visitor}:${day}` : null;
  const globalKey = `amp:global:${day}`;
  const [ipCount, visCount, globalCount] = await Promise.all([
    redis(["GET", ipKey]),
    visKey ? redis(["GET", visKey]) : null,
    redis(["GET", globalKey]),
  ]);
  if (Number(globalCount || 0) >= DAILY_GLOBAL) {
    return res.status(429).json({ error: "Mr. Paul has answered a lot of questions today! Come back tomorrow for more." });
  }
  if (Math.max(Number(ipCount || 0), Number(visCount || 0)) >= limit) {
    return res.status(429).json({
      error: kind === "ranking"
        ? "That's all the Ranking Research for today. Come back tomorrow for more lists!"
        : "Mr. Paul needs a break! Come back tomorrow for more answers.",
    });
  }

  // 4) Ask Mr. Paul
  try {
    let text;
    if (kind === "ranking") {
      text = await askClaude({
        model: RANKING_MODEL,
        system: rankingRules(size),
        user: `Topic: ${question}\nList size: ${size}`,
        maxTokens: size <= 25 ? 4000 : size <= 50 ? 6500 : 12000,
        maxSearches: 4,
      });
    } else {
      const prev = String(body.previous || "").slice(0, 2000);
      const user = [
        `Door: ${door.toUpperCase()}`,
        `Question: ${question}`,
        mode !== "normal" && prev ? `The answer already shown was:\n${prev}` : "",
      ].filter(Boolean).join("\n\n");
      text = await askClaude({
        model: MODEL,
        system: `${BASE_RULES}\n\n${DOOR_GUIDE[door]}\n${MODE_GUIDE[mode]}`,
        user,
        maxTokens: mode === "deeper" ? 3200 : 2200,
        maxSearches: 2,
      });
    }
    const card = parseCard(text);

    await Promise.all([bump(ipKey), visKey ? bump(visKey) : null, bump(globalKey)]);
    const partial = !!card.partial;
    delete card.partial;
    if (card.type !== "redirect" && !partial) {
      await redis(["SET", cacheKey, JSON.stringify(card), "EX", kind === "ranking" ? 604800 : 1209600]);
    }
    return res.status(200).json({ card });
  } catch (e) {
    return res.status(502).json({ error: "Mr. Paul couldn't get that one. Please try again in a moment." });
  }
}
