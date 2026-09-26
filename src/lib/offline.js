const OR_QUESTION = /(.+?)\s+or\s+(.+?)\??$/i;

export const CATEGORY_NAMES = ["Food", "Feelings", "People", "Help", "Chat"];

export function normalizeCategory(value) {
  const raw = String(value || "").trim().toLowerCase();
  const hit = CATEGORY_NAMES.find((name) => name.toLowerCase() === raw);
  return hit || "Chat";
}

export function guessCategory(heard) {
  const lower = (heard || "").toLowerCase();
  if (/hungry|eat|food|lunch|dinner|breakfast|coffee|tea|water|drink|thirsty/.test(lower)) {
    return "Food";
  }
  if (/how are you|feel|tired|pain|sad|happy|mood|hurt/.test(lower)) return "Feelings";
  if (/mom|dad|sister|brother|family|nurse|friend|visit|who is/.test(lower)) return "People";
  if (/\bhelp\b|bathroom|emergency|position|loud|stop|wait/.test(lower)) return "Help";
  return "Chat";
}

export function offlineReplies(heard) {
  const text = (heard || "").trim();
  const lower = text.toLowerCase();

  const orMatch = text.match(OR_QUESTION);
  if (orMatch) {
    const a = orMatch[1].replace(/^(do you want|would you like|is it|are you)\s+/i, "").trim();
    const b = orMatch[2].trim().replace(/\?$/, "");
    return [`I'd like ${a}.`, `I'd like ${b}.`, "Neither of those."];
  }

  if (/how are you|how're you|how do you feel/.test(lower)) {
    return ["I'm doing okay.", "I'm tired today.", "Pretty good, thanks."];
  }

  if (/hungry|eat|food|lunch|dinner|breakfast/.test(lower)) {
    return ["Yes, I'm hungry.", "Not hungry yet.", "What is there to eat?"];
  }

  if (/\bhelp\b|hurt|pain|emergency/.test(lower)) {
    return ["Yes, I need help.", "I'm okay for now.", "Please stay with me."];
  }

  return ["Yes, that works.", "No, not that.", "Can you say that again?"];
}

export function offlineSuggest(heard) {
  return {
    replies: offlineReplies(heard),
    category: guessCategory(heard),
    source: "offline",
  };
}
