export const CATEGORIES = {
  Food: ["I'm hungry.", "I'd like water.", "I'm full."],
  Feelings: ["I'm happy.", "I'm tired.", "I'm okay."],
  People: ["I want my family.", "Please call the nurse.", "I'd like some quiet."],
  Help: ["I need help.", "Bathroom, please.", "That's too loud."],
};

export function buildTiles({ suggestions, view }) {
  if (view === "categories") {
    return Object.keys(CATEGORIES).map((name) => ({
      id: `cat-${name}`,
      label: name,
      kind: "category",
    }));
  }

  return suggestions.slice(0, 3).map((label, i) => ({
    id: `ai-${i}`,
    label,
    kind: "speak",
  }));
}

export function moveIndex(index, dir, count) {
  if (!count) return 0;
  if (dir === "LEFT" || dir === "UP") return (index + count - 1) % count;
  if (dir === "RIGHT" || dir === "DOWN") return (index + 1) % count;
  return index;
}
