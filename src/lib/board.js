// Diamond order: UP=Help, RIGHT=Food, DOWN=Feelings, LEFT=People
const CATEGORY_ORDER = ["Help", "Food", "Feelings", "People"];

export const CATEGORIES = {
  Food: ["I'm hungry.", "I'd like water.", "I'm full.", "Something light, please."],
  Feelings: ["I'm happy.", "I'm tired.", "I'm okay.", "I'm a bit uncomfortable."],
  People: ["I want my family.", "Please call the nurse.", "I'd like some quiet.", "Can someone sit with me?"],
  Help: ["I need help.", "Bathroom, please.", "That's too loud.", "Please adjust my position."],
};

export function buildTiles({ suggestions, view, custom = [] }) {
  if (view === "categories") {
    return CATEGORY_ORDER.map((name) => ({
      id: `cat-${name}`,
      label: name,
      kind: "category",
    }));
  }

  if (view === "custom") {
    const phrases = (custom.length ? custom : ["Please wait a moment."]).slice(0, 4);
    return phrases.map((label, i) => ({
      id: `custom-${i}`,
      label: label || `Phrase ${i + 1}`,
      kind: "speak",
    }));
  }

  return suggestions.slice(0, 4).map((label, i) => ({
    id: `ai-${i}`,
    label,
    kind: "speak",
  }));
}

export function moveIndex(index, dir, count) {
  if (!count) return 0;
  // Diamond: each direction maps directly to a fixed tile
  if (count === 4) {
    if (dir === "UP") return 0;
    if (dir === "RIGHT") return 1;
    if (dir === "DOWN") return 2;
    if (dir === "LEFT") return 3;
    return index;
  }
  if (dir === "LEFT" || dir === "UP") return (index + count - 1) % count;
  if (dir === "RIGHT" || dir === "DOWN") return (index + 1) % count;
  return index;
}
