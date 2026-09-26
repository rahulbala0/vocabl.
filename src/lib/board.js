export const QUICK = ["Yes", "No", "Help", "Wait"];
export const CONTROLS = [
  { id: "listen", label: "Listen" },
  { id: "refresh", label: "New replies" },
  { id: "repeat", label: "Repeat last" },
  { id: "thanks", label: "Thank you" },
];

export const CATEGORIES = {
  Food: ["I'm hungry.", "I'd like water.", "That looks good.", "I'm full."],
  Feelings: ["I'm happy.", "I'm tired.", "I'm in pain.", "I'm okay."],
  People: ["I want my family.", "Please call the nurse.", "Come here, please.", "I'd like some quiet."],
  Help: ["I need help.", "Bathroom, please.", "Please adjust my position.", "That's too loud."],
};

export function buildTiles({ suggestions, custom, listening, view }) {
  if (view === "categories") {
    return Object.keys(CATEGORIES).map((name, i) => ({
      id: `cat-${name}`,
      label: name,
      kind: "category",
      row: 0,
      col: i,
    }));
  }

  const row0 = suggestions.map((label, i) => ({
    id: `ai-${i}`,
    label,
    kind: "speak",
    row: 0,
    col: i,
  }));
  const row1 = QUICK.map((label, i) => ({
    id: `quick-${label}`,
    label,
    kind: "speak",
    row: 1,
    col: i,
  }));
  const row2 = CONTROLS.map((item, i) => ({
    id: item.id,
    label: item.id === "listen" ? (listening ? "Stop listening" : "Listen") : item.label,
    kind: "control",
    row: 2,
    col: i,
  }));
  const row3 = (custom.length ? custom : ["", "", "", ""]).slice(0, 4).map((label, i) => ({
    id: `custom-${i}`,
    label: label || "Set in Settings",
    kind: label ? "speak" : "empty",
    row: 3,
    col: i,
  }));
  return [...row0, ...row1, ...row2, ...row3];
}

export function moveIndex(index, dir, count, cols = 4) {
  const rows = Math.ceil(count / cols);
  const row = Math.floor(index / cols);
  const col = index % cols;
  let nextRow = row;
  let nextCol = col;
  if (dir === "LEFT") nextCol = (col + cols - 1) % cols;
  if (dir === "RIGHT") nextCol = (col + 1) % cols;
  if (dir === "UP") nextRow = (row + rows - 1) % rows;
  if (dir === "DOWN") nextRow = (row + 1) % rows;
  const next = nextRow * cols + nextCol;
  return next < count ? next : col;
}
