import { guessCategory, normalizeCategory, offlineReplies, offlineSuggest } from "./offline";

async function requestSuggestions(body) {
  const t0 = performance.now();
  const res = await fetch("/api/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const ms = performance.now() - t0;
  if (!res.ok) {
    throw Object.assign(new Error(data.detail || data.error || `suggest failed (${res.status})`), { ms });
  }
  if (Array.isArray(data.replies) && data.replies.length >= 4) {
    return {
      replies: data.replies.slice(0, 4),
      category: normalizeCategory(data.category || guessCategory(body.heard)),
      source: data.source || "ai",
      facts: Array.isArray(data.facts) ? data.facts : [],
      ms,
    };
  }
  throw Object.assign(new Error("bad payload"), { ms });
}

function memoryFields(body) {
  return {
    facts: body.facts,
    summaries: body.summaries,
    lowConfidence: body.lowConfidence,
  };
}

export async function fetchSuggestions({ profile, heard, history, provider, customPrompt, ...memory }) {
  try {
    return await requestSuggestions({
      profile,
      heard,
      history: (history || []).slice(-6),
      provider,
      customPrompt,
      ...memoryFields(memory),
    });
  } catch (err) {
    console.error("AI suggest failed", err);
    return { ...offlineSuggest(heard), error: String(err.message || err), ms: err.ms || 0 };
  }
}

const replyKey = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Asks for 4 replies that differ from `avoid`. Resolves to null when 4 new replies can't be
 * found, so the caller can keep what is already on the wheel.
 */
export async function fetchNewSuggestions({
  profile,
  heard,
  history,
  provider,
  customPrompt,
  avoid,
  facts,
  summaries,
  lowConfidence,
}) {
  const seen = new Set(avoid.map(replyKey));
  const fresh = [];
  const take = (lines) => {
    for (const line of lines) {
      const key = replyKey(line);
      if (!key || seen.has(key) || fresh.length >= 4) continue;
      seen.add(key);
      fresh.push(line);
    }
  };

  let category = normalizeCategory(guessCategory(heard));
  let source = "offline";
  let error = "";
  let extraFacts = [];
  let suggestMs = 0;
  try {
    const result = await requestSuggestions({
      profile,
      heard,
      history: (history || []).slice(-6),
      provider,
      customPrompt,
      avoid,
      ...memoryFields({ facts, summaries, lowConfidence }),
    });
    suggestMs = result.ms;
    take(result.replies);
    category = result.category;
    source = result.source;
    extraFacts = result.facts;
  } catch (err) {
    console.error("AI refresh failed", err);
    error = String(err.message || err);
    suggestMs = err.ms || 0;
  }
  take(offlineReplies(heard));

  if (fresh.length < 4) return { replies: null, error: error || "no different replies found", ms: suggestMs };
  return { replies: fresh, category, source, error, facts: extraFacts, ms: suggestMs };
}

export async function fetchSummary({ profile, history, facts }) {
  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, history, facts }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || `summarize failed (${res.status})`);
    return {
      summary: String(data.summary || "").trim(),
      facts: Array.isArray(data.facts) ? data.facts : [],
    };
  } catch (err) {
    console.error("AI summarize failed", err);
    return { summary: "", facts: [], error: String(err.message || err) };
  }
}
