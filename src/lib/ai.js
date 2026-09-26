import { guessCategory, normalizeCategory, offlineSuggest } from "./offline";

export async function fetchSuggestions({ profile, heard, history, provider, customPrompt }) {
  try {
    const res = await fetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, heard, history, provider, customPrompt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || data.error || `suggest failed (${res.status})`);
    }
    if (Array.isArray(data.replies) && data.replies.length >= 4) {
      return {
        replies: data.replies.slice(0, 4),
        category: normalizeCategory(data.category || guessCategory(heard)),
        source: data.source || "ai",
      };
    }
    throw new Error("bad payload");
  } catch (err) {
    console.error("AI suggest failed", err);
    return { ...offlineSuggest(heard), error: String(err.message || err) };
  }
}
