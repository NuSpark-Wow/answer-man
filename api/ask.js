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

const DOORS = ["who", "what", "where", "when", "why", "how", "evolution", "future"];
const MODES = ["normal", "simplify", "extended", "followup"];
const MODE_ALIAS = { full: "normal", deeper: "extended", double: "extended" }; // older buttons
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
10. Write like a warm, smart teacher talking to a curious person. Short paragraphs. No markdown symbols (no #, *, or **), except the "## " subheadline lines that Full Answer and Extended answers require.
11. Spelling: people type fast. Silently read past typos, misspellings, and grammar slips, and answer what they meant. Never point out or comment on their mistakes.
12. Unclear questions: if a question could reasonably mean very different things (for example "Mercury" could be the planet, the element, the Roman god, or Freddie Mercury), answer the most likely meaning and list up to 3 other meanings in "alternatives", each written as a full question. For clear questions, leave "alternatives" empty. Don't use it for small variations.

OUTPUT
Reply with ONLY one JSON object, nothing before or after it:
{
  "type": "answer" | "list" | "redirect",
  "question": "the person's question (or follow-up) restated with spelling and grammar quietly fixed",
  "title": "short title for the card",
  "answer": "the answer — paragraphs separated by \\n\\n, at the length the mode asks for (for a list: the one-line opening sentence)",
  "facts": ["short highlight or interesting fact — how many depends on the length asked for"] ,
  "items": [{"name": "...", "reason": "one line"}],
  "alternatives": ["up to 3 other meanings as full questions, only when the question is truly unclear; otherwise empty"],
  "explore": "one name from this list that fits the question best, or empty string: ${EXPERIENCES.join(" | ")}"
}
SUBHEADLINES (Full Answer and Extended): inside "answer", start with a 2-sentence opening paragraph, then write each section as its own line "## Subheadline" followed by that section's paragraphs, all separated by \\n\\n. Example: "Opening sentence one. Opening sentence two.\\n\\n## How It Works\\n\\nParagraph...\\n\\n## Why It Matters\\n\\nParagraph..." Summary and Simplify answers have no subheadlines.
Use "items" only for type "list" (otherwise an empty array). "facts" may be empty for redirects.`;

const DOOR_GUIDE = {
  who: "WHO door: answer about a person or group — who they are, what they're known for, and why it matters. Include one wow fact.",
  what: "WHAT door: give a plain definition, a simple everyday example, and why it matters.",
  where: "WHERE door: geography and places as knowledge — where it is, what it's like, why it matters. Describe it in words; never give maps, addresses, or directions.",
  when: "WHEN door: give the date or time period, plus a mini timeline in the facts: what came before, the moment itself, what came after.",
  why: "WHY door: explain cause and effect, step by step, in plain language.",
  how: "HOW door: explain how it works or how it's done as clear steps, written as short sentences in the answer.",
  evolution: "EVOLUTION door: tell the history of how the topic came to be and changed over time — anything from the cotton gin to the telephone to sneakers. Open the answer with a short 2-sentence overview, then walk through the story in time order: the original idea and its beginnings, the key people, the big turning points, the companies that got involved (as history only, never recommended), and how it expanded and spread to where it is today. Put the timeline in \"facts\" as 4 to 6 short milestones, oldest first, each starting with the year or era (for example \"1876 — Bell patents the telephone\").",
  future: "FUTURE door: explain where the topic is heading — what experts predict and what is actually being planned, tested, or built (for example AI, healthcare, space travel, energy, transportation). Use web search for current plans, research, and announcements. Clearly separate what is already underway from what is only predicted, say roughly when things are expected, and present forecasts as possibilities, never certainties. Companies and organizations may be named only as fact (what they have announced or are building), never recommended. Put 3 to 5 short \"what to watch\" points in \"facts\". End the answer with one plain sentence reminding that predictions can change.",
};

// Subheadlines that fit each door, for Full Page and Extended answers
const SECTION_GUIDE = {
  who: "Good subheadlines: early life or beginnings, the big work or achievements, how they did it, challenges and turning points, influence and legacy, lesser-known facts.",
  what: "Good subheadlines: what it is, how it works, where you see it in everyday life, its parts or types, why it matters, common misunderstandings.",
  where: "Good subheadlines: where it is, what it's like (land, climate, look), history of the place, people and culture, what makes it notable, interesting details.",
  when: "Good subheadlines: the date and setting, what led up to it, the moment itself, what happened next, why the timing mattered, how it's remembered.",
  why: "Good subheadlines: the short answer, the main causes, how one thing led to another, the evidence, what it affects, common myths.",
  how: "Good subheadlines: the big picture, then the steps or stages in order, the key parts or people involved, what makes it work, common problems, how it's done today.",
  evolution: "Good subheadlines: the eras in time order — the original idea, the early versions, key people and turning points, the companies involved (history only), how it spread, where it is today.",
  future: "Good subheadlines: where things stand today, what is being built or tested now, what experts predict, who is working on it (fact only), the challenges, a rough timeline.",
};

const MODE_GUIDE = {
  normal: "FULL ANSWER: a complete, go-to reference answer of 600 to 800 words. \"answer\" opens with a 2-sentence summary, then 3 to 5 \"## \" subheadlines, each followed by 1 or 2 paragraphs. Use real specifics: names, dates, numbers, how it worked, causes and effects. Give 3 facts as highlight bullets: interesting facts that are not just repeats of the text. Never pad or invent details.",
  simplify: "SIMPLIFY: explain it so an 8-year-old would get it, about 150 to 250 words. Short sentences, an everyday comparison, no jargon. No subheadlines. Give 2 to 3 facts.",
  extended: "EXTENDED: an in-depth reference answer of 1,200 to 1,600 words. \"answer\" opens with a 2-sentence summary, then 6 to 9 \"## \" subheadlines, each followed by 1 to 3 paragraphs. Cover the topic fully, with real specifics: names, dates, numbers, how it worked, causes and effects, lesser-known details. Give 6 facts as highlight bullets: interesting facts that are not just repeats of the text. Never repeat yourself or invent details to fill space.",
  followup: "FOLLOW-UP: the person is asking a clarification or follow-up about the answer already shown. Answer it directly and briefly. If they say the answer was wrong, unclear, or missed the point, correct or clarify it plainly and without fuss. All the rules still apply.",
};

// Turn "Last 50 years", "past 25 years", "since 1990", "the 1980s", "1970-1985" into [from, to] years
function parseRange(range) {
  const Y = new Date().getFullYear();
  const r = String(range || "").toLowerCase();
  if (!r || r === "all time") return null;
  let m;
  if ((m = r.match(/(?:last|past|previous)\s+(\d{1,3})\s+years?/))) return [Y - parseInt(m[1], 10), Y];
  if ((m = r.match(/(?:last|past|previous)\s+(decade|century)/))) return [Y - (m[1] === "decade" ? 10 : 100), Y];
  if ((m = r.match(/(\d{4})\s*(?:-|–|to|through|and)\s*(\d{4})/))) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  if ((m = r.match(/(?:since|after|from)\s+(\d{4})/))) return [parseInt(m[1], 10), Y];
  if ((m = r.match(/(?:before|until|up to)\s+(\d{4})/))) return [0, parseInt(m[1], 10)];
  if ((m = r.match(/(\d{4})s/))) { const d = parseInt(m[1], 10); return [d, d + 9]; }
  if ((m = r.match(/'(\d0)s/))) { const d = 1900 + parseInt(m[1], 10); return [d, d + 9]; }
  if ((m = r.match(/\b(\d{4})\b/))) return [parseInt(m[1], 10), parseInt(m[1], 10)];
  return null;
}

function rankingRules(size, range, bounds) {
  return `${BASE_RULES}

RANKING RESEARCH MODE
The person picked a topic and wants a list of ${size}.
Time range: ${range}${bounds ? ` (that means ${bounds[0]} to ${bounds[1]})` : ""}.
TIME RANGE RULES — the person's time range always wins over your own idea of the topic:
- Only include items released, made, founded, or active within that range. For people, their career or active years must overlap it.
- Never drop the range because the topic suggests an era. Example: "classic rock songs" with "past 25 years" means classic-rock-style songs released in that window, not the 1960s and 70s classics.
- Aim for the full ${size}. Before including an item, check its years really fall inside the range, so none get dropped later. If few items truly fit, return fewer and say so in one short sentence at the start of "answer".
- Only ignore the range for timeless things with no date, like beaches, mountains, or national parks.
- For every item, include "from" and "to" years (numbers): release year for songs, films, books, inventions (from = to); first and last active year for people, teams, and bands. Use null only for timeless things.
Ignore words in the topic like "top", "best", "greatest" or a number; treat the topic as the subject only. Mr. Paul never picks a #1. Instead, research what shows up most often across published rankings and lists for this topic (use web search), and return exactly ${size} items (or fewer if the topic truly has fewer) as type "list".
- "title": "Ranking Research: <topic>" — add the time range in parentheses unless it's all time or doesn't apply
- "order": "alpha" or "chronological". Default is "alpha". Use "chronological" only when time order makes the list more useful: the topic is about history or change over time (inventions, discoveries, events, milestones, presidents, eras, "history of" or "evolution of" topics, generations of a technology) AND nearly every item has a clear year. Opinion topics like songs, albums, films, beaches, foods or places stay "alpha" even though they have years.
- "answer": for alpha: "What shows up most across published rankings, listed A–Z. Mr. Paul doesn't pick a #1." For chronological: "What shows up most across published rankings, listed in time order, oldest first. Mr. Paul doesn't pick a #1."
- "items": [{"name": "...", "reason": "...", "from": 1999, "to": 2005}] in A–Z order (or oldest first for chronological); each "reason" is ONE short line (about 12 words max) saying why it keeps making the lists. No numbers, no "#1", no superlatives in your own voice.
- "facts": 1 or 2 short notes on what kinds of sources were looked at (no links).
- Companies, brands, products, and businesses are NOT allowed as a list topic (rule 2). If the topic is one, return type "redirect" and suggest a knowledge topic instead.

INFOGRAPHIC SAFETY (copyright screen) — people may turn this list into a picture with an AI image tool, so also return:
- "art": "blocked" if the topic is mainly about copyrighted or trademarked characters or designs: cartoon, comic, anime, movie, TV, toy or video game characters, mascots, logos, or cover art. Otherwise "ok".
- For every item add "visual": a short description (about 10 words) of an ORIGINAL, GENERIC picture for that tile. Never describe a logo, brand mark, sponsor decal, team colors, character, real person's face, or a specific album, book, movie or game cover. For real people, describe a symbolic object tied to their work, not their face. For creative works (songs, albums, films, books), describe a generic symbol of the theme or genre. For vehicles and products, describe a generic style with no logos, text or numbers.
- Item shape: {"name": "...", "reason": "...", "from": 1999, "to": 2005, "visual": "..."}`;
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
  const sections = [];
  const secRe = /\{\s*"heading"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let sm;
  while ((sm = secRe.exec(text))) sections.push({ heading: unescapeJson(sm[1]), text: unescapeJson(sm[2]) });
  const items = [];
  const itemRe = /\{\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"from"\s*:\s*(null|-?\d+)\s*)?(?:,\s*"to"\s*:\s*(null|-?\d+)\s*)?(?:,\s*"visual"\s*:\s*"((?:[^"\\]|\\.)*)"\s*)?\}/g;
  let im;
  while ((im = itemRe.exec(text))) items.push({ name: unescapeJson(im[1]), reason: unescapeJson(im[2]), from: im[3] && im[3] !== "null" ? +im[3] : null, to: im[4] && im[4] !== "null" ? +im[4] : null, visual: im[5] ? unescapeJson(im[5]) : "" });
  if (!answer && !items.length) {
    const plain = text.replace(/[{}\[\]"]/g, " ").replace(/\s+/g, " ").trim();
    return { type: "answer", title: "Here's your answer", answer: plain, facts: [], items: [], explore: "", partial: true };
  }
  return { type: type || (items.length ? "list" : "answer"), question: str("question"), title, answer, sections, facts, items, art: str("art"), order: str("order"), explore: str("explore"), partial: true };
}

// Safety net: if an answer came back without subheadlines, write one for each paragraph after the opening
async function addHeadings(card) {
  const paras = String(card.answer || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length < 3) return;
  try {
    const reply = await askClaude({
      model: MODEL,
      system: "You write short, clear subheadlines (2 to 6 words, title case, no punctuation at the end) for paragraphs of a reference article. Reply with ONLY a JSON object.",
      user: `Article title: ${card.title}\n\n` + paras.slice(1).map((p, i) => `Paragraph ${i + 1}:\n${p}`).join("\n\n") +
        `\n\nReply with {"headings": [...]} containing exactly ${paras.length - 1} subheadlines, one per paragraph, in order.`,
      maxTokens: 600,
      maxSearches: 1,
    });
    const m = reply.match(/\{[\s\S]*\}/);
    const heads = m ? JSON.parse(m[0]).headings : null;
    if (!Array.isArray(heads) || !heads.length) return;
    card.sections = paras.slice(1).map((p, i) => ({ heading: String(heads[i] || "").replace(/^#+\s*/, "").slice(0, 120), text: p }));
    card.answer = paras[0];
  } catch { /* keep the answer as it is */ }
}

// Turn "## Subheadline" lines inside the answer into sections
function splitHeadings(card) {
  const lines = String(card.answer || "").split(/\n/);
  if (!lines.some((l) => /^\s*#{2,4}\s+\S/.test(l))) return [];
  const lead = [], out = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^\s*#{2,4}\s+(.+?)\s*#*\s*$/);
    if (m) { cur = { heading: m[1].replace(/\*\*/g, ""), text: "" }; out.push(cur); continue; }
    if (cur) cur.text += l + "\n"; else lead.push(l);
  }
  out.forEach((x) => { x.text = x.text.replace(/\n{3,}/g, "\n\n").trim(); });
  card.answer = lead.join("\n").trim();
  return out.filter((x) => x.heading);
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
  card.question = String(card.question || "").slice(0, 300);
  card.answer = String(card.answer || "");
  card.facts = Array.isArray(card.facts) ? card.facts.map(String).filter(Boolean).slice(0, 8) : [];
  card.sections = Array.isArray(card.sections) && card.sections.length ? card.sections : splitHeadings(card);
  card.sections = Array.isArray(card.sections)
    ? card.sections.filter((x) => x && (x.heading || x.text)).map((x) => ({ heading: String(x.heading || "").slice(0, 120), text: String(x.text || "") })).slice(0, 10)
    : [];
  card.items = Array.isArray(card.items)
    ? card.items.filter((i) => i && i.name).map((i) => ({
        name: String(i.name), reason: String(i.reason || ""),
        from: Number.isFinite(+i.from) && i.from !== null ? +i.from : null,
        to: Number.isFinite(+i.to) && i.to !== null ? +i.to : null,
        visual: String(i.visual || "").slice(0, 160),
      }))
    : [];
  card.art = card.art === "blocked" ? "blocked" : "ok";
  // Enforce the no-ranking rule: lists are A–Z, or oldest-first when the topic is about time
  const dated = card.items.filter((i) => i.from !== null || i.to !== null).length;
  card.order = card.order === "chronological" && card.items.length && dated >= card.items.length * 0.8 ? "chronological" : "alpha";
  if (card.order === "chronological") {
    const yr = (i) => (i.from ?? i.to ?? 99999);
    card.items.sort((a, b) => yr(a) - yr(b) || sortKey(a.name).localeCompare(sortKey(b.name)));
    card.answer = card.answer.replace(/listed A[–-]Z/g, "listed in time order, oldest first");
  } else {
    card.items.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
    card.answer = card.answer.replace(/listed in time order, oldest first/g, "listed A–Z");
  }
  card.explore = EXPERIENCES.includes(card.explore) ? card.explore : "";
  card.alternatives = Array.isArray(card.alternatives)
    ? card.alternatives.map((x) => String(x).trim()).filter((x) => x.length > 2).slice(0, 3)
    : [];
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
  const reqMode = MODE_ALIAS[body.mode] || body.mode;
  const mode = MODES.includes(reqMode) ? reqMode : "normal";
  let size = parseInt(body.size, 10);
  if (!RANKING_SIZES.includes(size)) size = RANKING_SIZES[0] || 25;
  const range = String(body.range || "All time").replace(/[^\w\s,.'’()\-–]/g, "").trim().slice(0, 60) || "All time";
  const visitor = String(body.visitor || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  const ip = clientIp(req);

  if (question.length < 2) return res.status(400).json({ error: "Please type a question." });

  const followup = String(body.followup || "").trim().slice(0, 300);
  if (mode === "followup" && followup.length < 2) return res.status(400).json({ error: "Please type your follow-up." });
  const keyFor = (q) => kind === "ranking"
    ? `amp:cache:v6:rank:${size}:${normalize(range)}:${normalize(q)}`
    : `amp:cache:v6:q:${door}:${mode}:${normalize(q)}`;

  // 1) Cached answers are instant and cost nothing (follow-ups depend on the conversation, so they're never cached)
  const cacheKey = (mode === "followup" || body.noCache) ? null : keyFor(question);
  const cached = cacheKey ? await redis(["GET", cacheKey]) : null;
  if (cached) {
    try {
      const c = JSON.parse(cached);
      // never serve a saved Full Page / Extended answer that is missing its subheadlines
      if (!((mode === "normal" || mode === "extended") && !(c.sections && c.sections.length))) return res.status(200).json({ card: c, cached: true });
    } catch { /* fall through */ }
  }

  // 2) Human check
  if (!(await verifyTurnstile(body.turnstileToken, ip))) {
    return res.status(403).json({ error: "Quick check failed. Please refresh the page and try again." });
  }

  // 3) Limits
  const day = today();
  const isList = kind === "ranking" && mode !== "followup";
  const limit = isList ? DAILY_LISTS : DAILY_QUESTIONS;
  const tag = isList ? "r" : "q";
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
      error: isList
        ? "That's all the Ranking Research for today. Come back tomorrow for more lists!"
        : "Mr. Paul needs a break! Come back tomorrow for more answers.",
    });
  }

  // 4) Ask Mr. Paul
  try {
    let text;
    const prev = String(body.previous || "").slice(0, 6000);
    if (mode === "followup") {
      const user = [
        kind === "ranking" ? `Original Ranking Research topic: ${question} (time range: ${range})` : `Original question (${door.toUpperCase()} door): ${question}`,
        prev ? `The answer already shown was:\n${prev}` : "",
        `Follow-up or clarification: ${followup}`,
      ].filter(Boolean).join("\n\n");
      text = await askClaude({
        model: MODEL,
        system: `${BASE_RULES}\n\n${MODE_GUIDE.followup}`,
        user,
        maxTokens: 2200,
        maxSearches: 2,
      });
    } else if (kind === "ranking") {
      text = await askClaude({
        model: RANKING_MODEL,
        system: rankingRules(size, range, parseRange(range)),
        user: `Topic: ${question}\nList size: ${size}\nTime range: ${range}`,
        maxTokens: size <= 25 ? 4000 : size <= 50 ? 6500 : 12000,
        maxSearches: 4,
      });
    } else {
      const user = [
        `Door: ${door.toUpperCase()}`,
        door === "future" ? `Today's date: ${new Date().toISOString().slice(0, 10)}. Search for current plans and forecasts before answering.` : "",
        `Question: ${question}`,
        mode === "simplify" && prev ? `The answer already shown was:\n${prev}` : "",
      ].filter(Boolean).join("\n\n");
      text = await askClaude({
        model: MODEL,
        system: `${BASE_RULES}\n\n${DOOR_GUIDE[door]}\n${MODE_GUIDE[mode]}${(mode === "normal" || mode === "extended") ? "\n" + SECTION_GUIDE[door] + "\nIMPORTANT: this is a " + (mode === "normal" ? "Full Answer" : "Extended") + " answer, so the \"## \" subheadline lines in \"answer\" are REQUIRED. The door's points above become separate sections, each with its own \"## \" subheadline." : ""}`,
        user,
        maxTokens: mode === "extended" ? 8000 : mode === "normal" ? 4800 : 2600,
        maxSearches: door === "future" ? 4 : 2,
      });
    }
    let card = parseCard(text);
    if ((mode === "normal" || mode === "extended") && kind === "question" && card.type === "answer" && !card.sections.length) {
      // The writer skipped the subheadlines: add them with a quick, cheap second step
      await addHeadings(card);
    }

    // Double-check the time range: drop any list item dated outside it
    const bounds = kind === "ranking" && mode !== "followup" ? parseRange(range) : null;
    if (bounds && card.items.length) {
      const [lo, hi] = bounds;
      const before = card.items.length;
      card.items = card.items.filter((i) => {
        const f = i.from ?? i.to, tt = i.to ?? i.from;
        if (f === null || f === undefined) return true;
        return tt >= lo && f <= hi;
      });
      const dropped = before - card.items.length;
      void dropped;
      if (!/\(/.test(card.title)) card.title += ` (${range.toLowerCase()})`;
    }
    if (kind === "ranking" && mode !== "followup" && card.type === "list" && card.items.length && card.items.length < size && !/^(Only|Found)\s+\d+/.test(card.answer)) {
      const span = bounds ? ` for ${bounds[0] || "the start"}–${bounds[1]}` : "";
      card.answer = `Found ${card.items.length} strong matches${span}, so this list has ${card.items.length} instead of ${size}. ` + card.answer;
    }
    const chrono = card.order === "chronological";
    card.items = card.items.map(({ name, reason, visual, from, to }) => {
      const it = { name, reason };
      if (visual) it.visual = visual;
      if (chrono && (from !== null || to !== null)) {
        const f = from ?? to, t = to ?? from;
        it.year = f === t ? String(f) : f + "–" + t;
      }
      return it;
    });

    await Promise.all([bump(ipKey), visKey ? bump(visKey) : null, bump(globalKey)]);
    if (mode === "extended") await Promise.all([bump(ipKey), visKey ? bump(visKey) : null, bump(globalKey)]); // two-page answers count as 2
    const partial = !!card.partial;
    delete card.partial;
    const missingSections = (mode === "normal" || mode === "extended") && kind === "question" && card.type === "answer" && !card.sections.length;
    if (cacheKey && card.type !== "redirect" && !partial && !missingSections) {
      const ttl = kind === "ranking" ? 604800 : door === "future" ? 259200 : 1209600; // Future answers refresh every 3 days
      const saves = [redis(["SET", cacheKey, JSON.stringify(card), "EX", ttl])];
      // Also save under the corrected spelling, so the clean version of the question is instant next time
      const fixedKey = card.question ? keyFor(card.question) : null;
      if (fixedKey && fixedKey !== cacheKey) saves.push(redis(["SET", fixedKey, JSON.stringify(card), "EX", ttl]));
      await Promise.all(saves);
    }
    return res.status(200).json({ card });
  } catch (e) {
    return res.status(502).json({ error: "Mr. Paul couldn't get that one. Please try again in a moment." });
  }
}
