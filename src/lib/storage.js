const KEY = "speakeasy-settings-v1";

export const DEFAULT_SETTINGS = {
  profile:
    "My name is Alex. I like music, basketball, and strong coffee. I live with my sister Maya and my dog Bean. I get tired in the afternoon.",
  provider: "race",
  voice: "grok",
  scanning: false,
  scanMs: 1100,
  readOptions: false,
  joystickCalibration: null,
  custom: ["I love you.", "Please wait a moment.", "That made me laugh.", "I need a break."],
  customPrompt:
    "Keep replies warm and direct. Prefer everyday words. If they offer a choice, answer the choice.",
  facts: [],
  summaries: [],
  replyPanePx: 320,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next) {
  localStorage.setItem(KEY, JSON.stringify(next));
}
