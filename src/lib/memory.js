export const MAX_FACTS = 40;
export const MAX_SUMMARIES = 8;
export const SILENCE_MS = 3 * 60 * 1000;
export const LOW_CONFIDENCE = 0.4;
export const ASK_AGAIN = "Can you say that again?";

function isAskAgain(line) {
  return /can you say (that|it) again/i.test(line);
}

const STOP = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "to", "of", "and", "or", "in", "on",
  "for", "you", "i", "me", "my", "your", "that", "this", "it", "do", "did", "does", "what",
  "whats", "who", "how", "when", "where", "why", "with", "from", "at", "as", "so", "if",
]);

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((word) => word && word.length > 1 && !STOP.has(word));
}

function relevanceScore(reply, heard, background, index, count) {
  const replyTokens = tokens(reply);
  const heardTokens = new Set(tokens(heard));
  const backgroundTokens = new Set(tokens(background));
  let heardHits = 0;
  let backgroundHits = 0;
  for (const word of replyTokens) {
    if (heardTokens.has(word)) heardHits += 1;
    else if (backgroundTokens.has(word)) backgroundHits += 1;
  }
  let score = heardHits * 2 - backgroundHits;
  if (/i don'?t know|i'?m not sure|i think|maybe later|not sure/i.test(reply)) score += 3;
  score += (count - 1 - index) * 0.01;
  return score;
}

function factKey(line) {
  const text = String(line || "").trim();
  const colon = text.indexOf(":");
  return (colon === -1 ? text : text.slice(0, colon)).toLowerCase().replace(/\s+/g, " ");
}

/** Incoming facts replace an existing one with the same label (text before the colon). */
export function mergeFacts(existing, incoming) {
  const next = (existing || []).map((line) => String(line || "").trim()).filter(Boolean);
  for (const raw of incoming || []) {
    const line = String(raw || "").trim().slice(0, 160);
    if (!line) continue;
    const key = factKey(line);
    if (!key) continue;
    const index = next.findIndex((item) => factKey(item) === key);
    if (index === -1) next.push(line);
    else next[index] = line;
  }
  return next.slice(-MAX_FACTS);
}

export function fallbackSummary(history) {
  const lines = (history || []).map((line) => String(line || "").trim()).filter(Boolean);
  if (!lines.length) return "";
  const other = lines.filter((line) => /^other:/i.test(line)).map((line) => line.replace(/^other:\s*/i, "")).slice(-2);
  const me = lines.filter((line) => /^me:/i.test(line)).map((line) => line.replace(/^me:\s*/i, "")).slice(-2);
  const parts = [];
  if (other.length) parts.push(`They said ${other.join("; ")}`);
  if (me.length) parts.push(`I replied ${me.join("; ")}`);
  return parts.join(". ").slice(0, 220);
}

export function applyAskAgain(replies, lowConfidence, heard = "", background = "") {
  const cleaned = (replies || []).map((line) => String(line || "").trim()).filter(Boolean);
  const withoutAsk = cleaned.filter((line) => !isAskAgain(line));
  if (!lowConfidence) return withoutAsk.slice(0, 4);
  const pool = withoutAsk.slice(0, 4);
  if (!pool.length) return [ASK_AGAIN];
  let worst = 0;
  let worstScore = Infinity;
  for (let i = 0; i < pool.length; i += 1) {
    const score = relevanceScore(pool[i], heard, background, i, pool.length);
    if (score < worstScore) {
      worstScore = score;
      worst = i;
    }
  }
  const next = [...pool];
  if (next.length >= 4 || worstScore < 0) next.splice(worst, 1);
  next.push(ASK_AGAIN);
  return next.slice(0, 4);
}

/** Chrome sometimes reports 0 when it has no score; treat that as unknown, not low. */
export function isLowConfidence(confidence) {
  if (!Number.isFinite(confidence) || confidence === 0) return false;
  return confidence > 0 && confidence < LOW_CONFIDENCE;
}
