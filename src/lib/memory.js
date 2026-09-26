export const MAX_FACTS = 40;
export const MAX_SUMMARIES = 8;
export const SILENCE_MS = 3 * 60 * 1000;
export const LOW_CONFIDENCE = 0.55;
export const ASK_AGAIN = "Can you say that again?";

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

export function applyAskAgain(replies, lowConfidence) {
  const cleaned = (replies || []).map((line) => String(line || "").trim()).filter(Boolean);
  if (!lowConfidence) return cleaned.slice(0, 4);
  const next = cleaned.filter((line) => !/can you say that again/i.test(line)).slice(0, 3);
  while (next.length < 3) next.push(cleaned[next.length] || "Tell me more.");
  next.push(ASK_AGAIN);
  return next.slice(0, 4);
}

/** Chrome sometimes reports 0 when it has no score; treat that as unknown, not low. */
export function isLowConfidence(confidence) {
  if (!Number.isFinite(confidence) || confidence === 0) return false;
  return confidence > 0 && confidence < LOW_CONFIDENCE;
}
