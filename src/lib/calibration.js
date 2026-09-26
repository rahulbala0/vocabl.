const ADC_MAX = 4095;
const TAU = 2 * Math.PI;
const MIN_AXIS_REACH = 300;
const MIN_SECTOR_RADIUS = 0.3;

export const SECTORS = 16;
const SECTOR_WIDTH = TAU / SECTORS;

/** Wheel slices are centered on up, right, down, left (clockwise from the top). */
export const DIRECTIONS = ["UP", "RIGHT", "DOWN", "LEFT"];
export const OPPOSITE = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };

export const IDENTITY_ORIENTATION = { mirror: false, rotation: 0 };

/**
 * Used until the wizard has been run: ADC limits as the range, a round outline, and the
 * wiring the app originally assumed (raw Y grows downward).
 */
export function defaultCalibration(cx, cy) {
  return {
    version: 1,
    auto: true,
    center: { x: cx, y: cy },
    range: { xPos: ADC_MAX - cx, xNeg: cx, yPos: ADC_MAX - cy, yNeg: cy },
    sectors: Array(SECTORS).fill(1),
    outline: [],
    orientation: { mirror: true, rotation: 0 },
  };
}

const wrap = (angle) => ((angle % TAU) + TAU) % TAU;

export function sectorOf(angle) {
  return Math.floor(wrap(angle) / SECTOR_WIDTH) % SECTORS;
}

function scaleAxes(range, dx, dy) {
  return [dx / (dx >= 0 ? range.xPos : range.xNeg), dy / (dy >= 0 ? range.yPos : range.yNeg)];
}

/** Recorded reach at `angle`, interpolated between the centers of neighbouring sectors. */
function sectorReach(sectors, angle) {
  const pos = wrap(angle) / SECTOR_WIDTH - 0.5;
  const base = Math.floor(pos);
  const t = pos - base;
  const a = sectors[(base + SECTORS) % SECTORS];
  const b = sectors[(base + 1 + SECTORS) % SECTORS];
  return a + (b - a) * t;
}

/**
 * Center + per-direction axis scaling only. Skips the 16-section outline so a weak side
 * with poor outline data can't distort the orientation check.
 */
export function axisScaled(cal, x, y) {
  const dx = x - cal.center.x;
  const dy = y - cal.center.y;
  const [sx, sy] = scaleAxes(cal.range, dx, dy);
  return { x: sx, y: sy, mag: Math.hypot(sx, sy) };
}

/**
 * Raw ADC reading -> corrected stick position. Order matters: center, per-direction axis
 * scaling, per-sector outline correction, then orientation. `ux`/`uy` use y-up, so a full
 * push in any direction has `mag` ~1; `angle` is a compass bearing (0 = up, clockwise).
 */
export function correct(cal, x, y) {
  const { x: sx, y: sy, mag: r } = axisScaled(cal, x, y);
  if (!r) return { ux: 0, uy: 0, mag: 0, angle: 0 };

  const a = Math.atan2(sy, sx);
  const mag = r / sectorReach(cal.sectors, a);
  const px = Math.cos(a) * mag;
  const py = Math.sin(a) * mag * (cal.orientation.mirror ? -1 : 1);
  const { rotation } = cal.orientation;
  const ux = px * Math.cos(rotation) - py * Math.sin(rotation);
  const uy = px * Math.sin(rotation) + py * Math.cos(rotation);

  let angle = (Math.atan2(ux, uy) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return { ux, uy, mag, angle };
}

export function directionFromAngle(angle) {
  return DIRECTIONS[Math.floor(((angle + 45) % 360) / 90)];
}

/** Largest value after dropping the top 1%, so one noisy spike can't stretch the range. */
function robustMax(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[Math.floor(sorted.length * 0.01)];
}

/** Builds range + outline from raw samples taken while the stick circled its outer edge. */
export function buildRangeCalibration(center, samples) {
  const deltas = samples.map((s) => [s.x - center.x, s.y - center.y]);
  const range = {
    xPos: robustMax(deltas.filter(([dx]) => dx > 0).map(([dx]) => dx)),
    xNeg: robustMax(deltas.filter(([dx]) => dx < 0).map(([dx]) => -dx)),
    yPos: robustMax(deltas.filter(([, dy]) => dy > 0).map(([, dy]) => dy)),
    yNeg: robustMax(deltas.filter(([, dy]) => dy < 0).map(([, dy]) => -dy)),
  };
  if (Object.values(range).some((v) => v < MIN_AXIS_REACH)) {
    return { error: "The stick didn't reach the edge in every direction. Push all the way out while rotating." };
  }

  const buckets = Array.from({ length: SECTORS }, () => []);
  for (const [dx, dy] of deltas) {
    const [sx, sy] = scaleAxes(range, dx, dy);
    const r = Math.hypot(sx, sy);
    if (r < MIN_SECTOR_RADIUS) continue;
    buckets[sectorOf(Math.atan2(sy, sx))].push({ r, dx, dy });
  }
  if (buckets.some((b) => !b.length)) {
    return { error: "Part of the circle was missed. Rotate all the way around the edge." };
  }

  const sectors = [];
  const outline = [];
  for (const bucket of buckets) {
    bucket.sort((p, q) => q.r - p.r);
    const pick = bucket[Math.floor(bucket.length * 0.02)];
    sectors.push(Math.max(pick.r, MIN_SECTOR_RADIUS));
    outline.push([Math.round(pick.dx), Math.round(pick.dy)]);
  }
  return { range, sectors, outline };
}

const RAW_AXES = {
  xPos: { x: 1, y: 0, family: "X" },
  xNeg: { x: -1, y: 0, family: "X" },
  yPos: { x: 0, y: 1, family: "Y" },
  yNeg: { x: 0, y: -1, family: "Y" },
};

function snapAxis(v) {
  if (Math.abs(v.x) >= Math.abs(v.y)) return v.x >= 0 ? "xPos" : "xNeg";
  return v.y >= 0 ? "yPos" : "yNeg";
}

/** Default wiring the firmware assumes: X+ right, X- left, Y+ down, Y- up. */
export const DEFAULT_SIDE_LABELS = { xPos: "Right", xNeg: "Left", yPos: "Down", yNeg: "Up" };

const titleCase = (dir) => dir[0] + dir.slice(1).toLowerCase();

/** Maps each raw ADC side to a wheel direction using a detected orientation. */
export function sideLabels(orientation) {
  if (!orientation) return { ...DEFAULT_SIDE_LABELS };
  const cal = {
    center: { x: 0, y: 0 },
    range: { xPos: 1, xNeg: 1, yPos: 1, yNeg: 1 },
    sectors: Array(SECTORS).fill(1),
    orientation,
  };
  const probes = { xPos: [1, 0], xNeg: [-1, 0], yPos: [0, 1], yNeg: [0, -1] };
  const labels = {};
  for (const [side, [x, y]] of Object.entries(probes)) {
    labels[side] = titleCase(directionFromAngle(correct(cal, x, y).angle));
  }
  return labels;
}

/**
 * Snaps each averaged push to its dominant scaled axis. Fails only when both land on the
 * same axis (X or Y). Rotation is a multiple of 90°.
 */
export function detectOrientation(up, right) {
  const upKey = snapAxis(up);
  const rightKey = snapAxis(right);
  if (RAW_AXES[upKey].family === RAW_AXES[rightKey].family) {
    return { error: `Up and right both moved the ${RAW_AXES[upKey].family} axis.` };
  }
  const uRaw = RAW_AXES[upKey];
  const rRaw = RAW_AXES[rightKey];
  const cross = uRaw.x * rRaw.y - uRaw.y * rRaw.x;
  const mirror = cross > 0;
  const u = { x: uRaw.x, y: mirror ? -uRaw.y : uRaw.y };
  const r = { x: rRaw.x, y: mirror ? -rRaw.y : rRaw.y };
  const fromUp = Math.PI / 2 - Math.atan2(u.y, u.x);
  const fromRight = -Math.atan2(r.y, r.x);
  const rawRot = Math.atan2(
    Math.sin(fromUp) + Math.sin(fromRight),
    Math.cos(fromUp) + Math.cos(fromRight)
  );
  const rotation = Math.round(rawRot / (Math.PI / 2)) * (Math.PI / 2);
  return { mirror, rotation };
}

/** Sides whose reach is less than half of the opposite side. */
export function findWeakSides(range) {
  const pairs = [
    ["xPos", "xNeg"],
    ["xNeg", "xPos"],
    ["yPos", "yNeg"],
    ["yNeg", "yPos"],
  ];
  return pairs
    .filter(([weak, other]) => range[other] > 0 && range[weak] < range[other] * 0.5)
    .map(([weak, other]) => ({
      side: weak,
      reach: range[weak],
      opposite: other,
      oppositeReach: range[other],
    }));
}

export function formatWeakWarning(weakSides, labels = DEFAULT_SIDE_LABELS) {
  if (!weakSides?.length) return "";
  return weakSides
    .map((w) => {
      const name = labels[w.side] || w.side;
      const opp = labels[w.opposite] || w.opposite;
      return `The ${name} side only reaches ${Math.round(w.reach)} (the ${opp} side reaches ${Math.round(w.oppositeReach)}). Check that the joystick's VCC is on 3.3V, not 5V, and that the VRx/VRy and GND wires are secure.`;
    })
    .join(" ");
}
