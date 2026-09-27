import { correct, defaultCalibration, directionFromAngle, OPPOSITE } from "./calibration";

export { DIRECTIONS } from "./calibration";

const REST_DEFAULT = 2900;
export const ENGAGE_FRAC = 0.45;
const RELEASE_FRAC = 0.3;
const STEADY_SAMPLES = 3;
const STEADY_DELTA = 0.08;
const REBOUND_MS = 150;
const PRESS_LOCK_MS = 300;
const DOUBLE_CLICK_MS = 400;
const HOLD_MS = 700;
const AUTO_CENTER_SAMPLES = 40;

const QUADRANT_INDEX = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };

const TOKEN_TO_QUADRANT = {
  UP: "UP",
  RIGHT: "RIGHT",
  DOWN: "DOWN",
  LEFT: "LEFT",
  NE: "UP",
  SE: "RIGHT",
  SW: "DOWN",
  NW: "LEFT",
};

export function quadrantToIndex(quadrant, count) {
  if (!count) return 0;
  const key = TOKEN_TO_QUADRANT[String(quadrant || "").toUpperCase()];
  if (!key) return null;
  return QUADRANT_INDEX[key] % count;
}

export function parseJoystickLine(text) {
  const line = String(text || "").trim();
  if (!line) return null;
  const parts = line.split(",");
  if (parts.length < 3 || parts.length > 5) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const sw = Number(parts.length === 5 ? parts[2] : 0);
  const btn = Number(parts.length === 5 ? parts[3] : parts[2]);
  const alt = Number(parts.length >= 4 ? parts[parts.length === 5 ? 4 : 3] : 0);
  if (![x, y, sw, btn, alt].every(Number.isFinite)) return null;
  return { x, y, sw: sw ? 1 : 0, btn: btn ? 1 : 0, alt: alt ? 1 : 0 };
}

/**
 * Turns corrected stick positions into direction commands, one movement at a time.
 * A movement runs from leaving the center (past `engage`) to coming back (below `release`).
 * It commits early if the stick is held steady in one zone; otherwise it commits the zone of
 * the strongest push when the stick returns, so readings taken mid-flick or during the
 * spring-back don't count. Right after a movement ends, the opposite direction is ignored
 * for `reboundMs` so the spring overshooting center doesn't register.
 */
export function createDirectionDetector({
  engage = ENGAGE_FRAC,
  release = RELEASE_FRAC,
  steadySamples = STEADY_SAMPLES,
  steadyDelta = STEADY_DELTA,
  reboundMs = REBOUND_MS,
} = {}) {
  let moving = false;
  let startedAt = 0;
  let peak = null;
  let committed = null;
  let count = 0;
  let recent = [];
  let rebound = null;

  const isRebound = (dir, time) => rebound && dir === rebound.dir && time < rebound.until;

  return {
    reset() {
      moving = false;
      peak = null;
      committed = null;
      recent = [];
    },

    feed({ mag, angle }, now) {
      if (!moving) {
        if (mag <= engage) return null;
        moving = true;
        startedAt = now;
        peak = { mag, angle };
        committed = null;
        count = 0;
        recent = [];
      }

      if (mag < release) {
        moving = false;
        let out = null;
        if (!committed && count >= 2) {
          const dir = directionFromAngle(peak.angle);
          if (!isRebound(dir, startedAt)) {
            committed = dir;
            out = dir;
          }
        }
        if (committed) rebound = { dir: OPPOSITE[committed], until: now + reboundMs };
        return out;
      }

      count += 1;
      if (mag > peak.mag) peak = { mag, angle };
      recent.push({ mag, dir: directionFromAngle(angle) });
      if (recent.length > steadySamples) recent.shift();

      if (recent.length === steadySamples && mag > engage) {
        const dir = recent[0].dir;
        const mags = recent.map((s) => s.mag);
        const steady = recent.every((s) => s.dir === dir) && Math.max(...mags) - Math.min(...mags) <= steadyDelta;
        if (steady && dir !== committed && !isRebound(dir, now)) {
          committed = dir;
          return dir;
        }
      }
      return null;
    },
  };
}

/**
 * Raw `x,y,btn` samples -> commands. Uses the saved calibration when there is one; otherwise
 * measures the resting position from the first samples after connecting.
 */
export function createJoystickMapper({ calibration = null, pressLockMs = PRESS_LOCK_MS } = {}) {
  let cal = calibration;
  let autoN = 0;
  let autoSx = 0;
  let autoSy = 0;
  const detector = createDirectionDetector();
  let lastBtn = 0;
  let pressAt = 0;
  let releaseAt = 0;
  let holdSent = false;

  function map(x, y, btn, now = Date.now()) {
    const pressed = btn ? 1 : 0;
    const commands = [];

    if (!cal) {
      autoN += 1;
      autoSx += x;
      autoSy += y;
      if (autoN >= AUTO_CENTER_SAMPLES) cal = defaultCalibration(autoSx / autoN, autoSy / autoN);
      lastBtn = pressed;
      return { commands, corrected: null };
    }

    if (pressed && !lastBtn) {
      pressAt = now;
      holdSent = false;
    }
    if (!pressed && lastBtn) releaseAt = now;

    const corrected = correct(cal, x, y);
    // Pressing the stick wobbles it, so ignore movement while the button is down and just after.
    if (pressed || now - releaseAt < pressLockMs) {
      detector.reset();
    } else {
      const dir = detector.feed(corrected, now);
      if (dir) commands.push(dir);
    }

    if (pressed && lastBtn && !holdSent && now - pressAt >= HOLD_MS) {
      commands.push("HOLD");
      holdSent = true;
    }
    if (!pressed && lastBtn && !holdSent) commands.push("CLICK");
    lastBtn = pressed;

    return { commands, corrected };
  }

  return {
    map,
    getCalibration: () => cal,
    setCalibration(next) {
      cal = next || null;
      autoN = 0;
      autoSx = 0;
      autoSy = 0;
      detector.reset();
    },
  };
}

/**
 * Turns CLICKs into SELECT or DOUBLE. A lone click becomes SELECT once the double-click
 * window passes; other commands arriving meanwhile are held so SELECT still applies to the
 * slice that was highlighted when the button was clicked.
 */
export function createClickCombiner(onCommand, windowMs = DOUBLE_CLICK_MS) {
  let timer = null;
  let queued = [];

  function resolve(cmd) {
    clearTimeout(timer);
    timer = null;
    onCommand(cmd);
    const held = queued;
    queued = [];
    held.forEach(onCommand);
  }

  return function push(cmd) {
    if (cmd === "CLICK" || cmd === "SELECT") {
      if (timer) resolve("DOUBLE");
      else timer = setTimeout(() => resolve("SELECT"), windowMs);
      return;
    }
    if (timer) {
      queued.push(cmd);
      return;
    }
    onCommand(cmd);
  };
}

/**
 * Parses the BLE text stream. `onSample` receives every raw reading (with the mapper's
 * corrected position and active calibration) for the live view and calibration wizard.
 */
export function createJoystickCommandParser(onRawCommand, { calibration = null, onSample } = {}) {
  const mapper = createJoystickMapper({ calibration });
  const onCommand = createClickCombiner(onRawCommand);
  let lastBtn = 0;
  let lastAlt = 0;
  let buf = "";

  function emitLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    const sample = parseJoystickLine(trimmed);
    if (sample) {
      const { commands, corrected } = mapper.map(sample.x, sample.y, sample.sw);
      onSample?.({ ...sample, corrected, calibration: mapper.getCalibration() });
      commands.forEach(onCommand);
      if (sample.btn && !lastBtn) onRawCommand("SELECT");
      if (sample.alt && !lastAlt) onRawCommand("MIC");
      lastBtn = sample.btn;
      lastAlt = sample.alt;
      return;
    }

    const token = trimmed.toUpperCase();
    if (token === "SELECT" || token === "HOLD" || token === "MIC" || TOKEN_TO_QUADRANT[token]) onCommand(token);
  }

  function push(chunk) {
    const raw = String(chunk || "");
    if (!raw) return;
    buf += raw;
    buf = buf.replace(/\r/g, "");

    let newline = buf.indexOf("\n");
    while (newline !== -1) {
      emitLine(buf.slice(0, newline));
      buf = buf.slice(newline + 1);
      newline = buf.indexOf("\n");
    }

    if (buf.length > 64) {
      emitLine(buf);
      buf = "";
      return;
    }

    const pending = buf.trim().toUpperCase();
    if (pending === "SELECT" || pending === "HOLD" || pending === "MIC" || TOKEN_TO_QUADRANT[pending]) {
      emitLine(buf);
      buf = "";
    }
  }

  return { push, setCalibration: mapper.setCalibration };
}
