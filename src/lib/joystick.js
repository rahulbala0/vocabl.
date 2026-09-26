const ADC_MAX = 4095;
const REST_DEFAULT = 2900;
const DEADZONE_FRAC = 0.18;
const CALIB_SAMPLES = 40;

export const QUADRANTS = ["NE", "SE", "SW", "NW"];

/** Wheel slices start at north and go clockwise: NE, SE, SW, NW. */
const QUADRANT_INDEX = { NE: 0, SE: 1, SW: 2, NW: 3 };

const TOKEN_TO_QUADRANT = {
  NE: "NE",
  SE: "SE",
  SW: "SW",
  NW: "NW",
  UP: "NE",
  RIGHT: "SE",
  DOWN: "SW",
  LEFT: "NW",
};

export function quadrantToIndex(quadrant, count) {
  if (!count) return 0;
  const key = TOKEN_TO_QUADRANT[String(quadrant || "").toUpperCase()];
  if (!key) return null;
  return QUADRANT_INDEX[key] % count;
}

function axisNorm(raw, rest) {
  const delta = raw - rest;
  const span = delta >= 0 ? ADC_MAX - rest : rest;
  if (span <= 0) return 0;
  const n = delta / span;
  if (n > 1) return 1;
  if (n < -1) return -1;
  return n;
}

function quadrantFromAxes(nx, ny) {
  if (nx === 0 && ny === 0) return null;
  let ang = (Math.atan2(nx, -ny) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  return QUADRANTS[Math.floor(ang / 90) % 4];
}

export function parseJoystickLine(text) {
  const line = String(text || "").trim();
  if (!line) return null;
  const parts = line.split(",");
  if (parts.length !== 3) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const btn = Number(parts[2]);
  if (![x, y, btn].every(Number.isFinite)) return null;
  return { x, y, btn: btn ? 1 : 0 };
}

export function createJoystickMapper({
  restDefault = REST_DEFAULT,
  deadzone = DEADZONE_FRAC,
  calibSamples = CALIB_SAMPLES,
} = {}) {
  let restX = restDefault;
  let restY = restDefault;
  let calibN = 0;
  let calibSx = 0;
  let calibSy = 0;
  let calibrated = false;
  let lastQuad = null;
  let lastBtn = 0;
  let pressAt = 0;
  let holdSent = false;
  const HOLD_MS = 700;

  return function mapSample(x, y, btn) {
    const pressed = btn ? 1 : 0;

    if (!calibrated) {
      calibN += 1;
      calibSx += x;
      calibSy += y;
      if (calibN >= calibSamples) {
        restX = calibSx / calibN;
        restY = calibSy / calibN;
        calibrated = true;
      }
      lastBtn = pressed;
      return null;
    }

    let nx = axisNorm(x, restX);
    let ny = axisNorm(y, restY);
    const mag = Math.hypot(nx, ny);
    if (mag <= deadzone) {
      nx = 0;
      ny = 0;
    }

    const quad = quadrantFromAxes(nx, ny);
    const commands = [];

    if (quad && quad !== lastQuad) {
      commands.push(quad);
    }
    lastQuad = quad;

    if (pressed && !lastBtn) {
      pressAt = Date.now();
      holdSent = false;
    }
    if (pressed && lastBtn && !holdSent && Date.now() - pressAt >= HOLD_MS) {
      commands.push("HOLD");
      holdSent = true;
    }
    if (!pressed && lastBtn && !holdSent) {
      commands.push("SELECT");
    }
    lastBtn = pressed;

    return commands.length ? commands : null;
  };
}

export function createJoystickCommandParser(onCommand) {
  const mapSample = createJoystickMapper();
  let buf = "";

  return function push(chunk) {
    const raw = String(chunk || "");
    if (!raw) return;
    buf += raw;
    buf = buf.replace(/\r/g, "");

    let newline = buf.indexOf("\n");
    while (newline !== -1) {
      const line = buf.slice(0, newline);
      buf = buf.slice(newline + 1);
      emitLine(line, mapSample, onCommand);
      newline = buf.indexOf("\n");
    }

    if (buf.length > 64) {
      emitLine(buf, mapSample, onCommand);
      buf = "";
      return;
    }

    const pending = buf.trim().toUpperCase();
    if (pending === "SELECT" || pending === "HOLD" || TOKEN_TO_QUADRANT[pending]) {
      emitLine(buf, mapSample, onCommand);
      buf = "";
    }
  };
}

function emitLine(line, mapSample, onCommand) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const sample = parseJoystickLine(trimmed);
  if (sample) {
    const commands = mapSample(sample.x, sample.y, sample.btn);
    if (commands) commands.forEach(onCommand);
    return;
  }

  const token = trimmed.toUpperCase();
  if (token === "SELECT" || token === "HOLD" || TOKEN_TO_QUADRANT[token]) {
    onCommand(token);
  }
}
