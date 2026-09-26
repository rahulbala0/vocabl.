import { useEffect, useRef, useState } from "react";
import JoystickView from "./JoystickView.jsx";
import Wheel from "./Wheel.jsx";
import {
  axisScaled,
  buildRangeCalibration,
  correct,
  DEFAULT_SIDE_LABELS,
  detectOrientation,
  directionFromAngle,
  findWeakSides,
  formatWeakWarning,
  IDENTITY_ORIENTATION,
  SECTORS,
  sectorOf,
  sideLabels,
} from "./lib/calibration";
import { createDirectionDetector, DIRECTIONS, ENGAGE_FRAC } from "./lib/joystick";

const ADC_MAX = 4095;
const CENTER_MS = 1500;
const CENTER_MIN_SAMPLES = 15;
const CENTER_MAX_SPREAD = 120;
const RANGE_TURNS = 3;
const RANGE_GATE = 0.35;
const RANGE_MAX_SAMPLES = 6000;
const HOLD_SAMPLES = 20;
const HOLD_MIN_MAG = 0.7;
const HOLD_MAX_SPREAD_DEG = 20;
const REST_MAG = 0.2;
const REST_SAMPLES = 5;
const PAUSE_MS = 3000;
const STALE_MS = 2000;

const STEPS = [
  { id: "center", title: "Center" },
  { id: "range", title: "Range" },
  { id: "orient", title: "Orientation" },
  { id: "test", title: "Test" },
];
const STEP_OF = { center: "center", range: "range", up: "orient", right: "orient", test: "test" };
const INSTRUCTIONS = {
  center: "Let go of the joystick.",
  range: "Slowly rotate the joystick around its outer edge 3 times.",
  up: "Push the joystick all the way up and hold it there until the bar fills. Don't flick it.",
  right: "Push the joystick all the way right and hold it there until the bar fills. Don't flick it.",
  test: "Push each direction and check that the matching slice lights up.",
};
const TEST_ITEMS = DIRECTIONS.map((dir) => ({ id: `test-${dir}`, label: dir[0] + dir.slice(1).toLowerCase(), kind: "speak" }));

const toDeg = (rad) => (rad * 180) / Math.PI;
const angleGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

export default function CalibrationWizard({ subscribeSamples, announce, onSave, onCancel }) {
  const [phase, setPhase] = useState("center");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [coverage, setCoverage] = useState(0);
  const [view, setView] = useState({ raw: null, corrected: null, outline: [], active: null });
  const [testSelected, setTestSelected] = useState(-1);
  const [testSeen, setTestSeen] = useState([]);
  const [stale, setStale] = useState(false);
  const [pauseNext, setPauseNext] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [warning, setWarning] = useState("");
  const [labels, setLabels] = useState(DEFAULT_SIDE_LABELS);
  const [readings, setReadings] = useState({ x: 0, y: 0, rest: null, reach: null });

  const phaseRef = useRef(phase);
  const work = useRef({ step: {} });
  const lastSampleAt = useRef(Date.now());

  function goTo(next, note = "") {
    phaseRef.current = next;
    work.current.step = {};
    setPhase(next);
    setMessage(note);
    setProgress(0);
    setCoverage(0);
    setCountdown(null);
  }

  /** Between steps: wait for the stick to be released, then count down before `next` starts. */
  function pauseThen(next) {
    work.current.pauseNext = next;
    setPauseNext(next);
    goTo("pause");
  }

  function redo() {
    work.current = { step: {}, guess: work.current.guess };
    setTestSelected(-1);
    setTestSeen([]);
    setWarning("");
    setLabels(DEFAULT_SIDE_LABELS);
    setReadings((r) => ({ ...r, rest: null, reach: null }));
    goTo("center");
  }

  useEffect(() => {
    announce?.(phase === "pause" ? `Let go of the joystick. Next: ${INSTRUCTIONS[pauseNext]}` : INSTRUCTIONS[phase]);
  }, [phase, pauseNext, announce]);

  useEffect(() => {
    if (message) announce?.(message);
  }, [message, announce]);

  useEffect(() => {
    if (warning) announce?.(warning);
  }, [warning, announce]);

  useEffect(() => {
    const id = setInterval(() => setStale(Date.now() - lastSampleAt.current > STALE_MS), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function handleCenter(s, d, now) {
      if (!d.samples) Object.assign(d, { samples: [], start: now, minX: s.x, maxX: s.x, minY: s.y, maxY: s.y });
      d.samples.push(s);
      d.minX = Math.min(d.minX, s.x);
      d.maxX = Math.max(d.maxX, s.x);
      d.minY = Math.min(d.minY, s.y);
      d.maxY = Math.max(d.maxY, s.y);
      if (d.maxX - d.minX > CENTER_MAX_SPREAD || d.maxY - d.minY > CENTER_MAX_SPREAD) {
        Object.assign(d, { samples: [s], start: now, minX: s.x, maxX: s.x, minY: s.y, maxY: s.y });
        setMessage("The stick moved. Let go and keep it still.");
      }
      setProgress(Math.min(1, (now - d.start) / CENTER_MS));
      if (now - d.start >= CENTER_MS && d.samples.length >= CENTER_MIN_SAMPLES) {
        const n = d.samples.length;
        work.current.center = {
          x: d.samples.reduce((sum, p) => sum + p.x, 0) / n,
          y: d.samples.reduce((sum, p) => sum + p.y, 0) / n,
        };
        pauseThen("range");
      }
    }

    function growReach(reach, dx, dy) {
      if (dx > 0) reach.xPos = Math.max(reach.xPos, dx);
      if (dx < 0) reach.xNeg = Math.max(reach.xNeg, -dx);
      if (dy > 0) reach.yPos = Math.max(reach.yPos, dy);
      if (dy < 0) reach.yNeg = Math.max(reach.yNeg, -dy);
    }

    function handleRange(s, d) {
      const c = work.current.center;
      if (!d.samples) Object.assign(d, { samples: [], turns: 0, last: null, best: Array(SECTORS).fill(null), reach: { xPos: 0, xNeg: 0, yPos: 0, yNeg: 0 } });
      const dx = s.x - c.x;
      const dy = s.y - c.y;
      growReach(d.reach, dx, dy);
      work.current.reach = d.reach;
      const rx = dx / (dx >= 0 ? ADC_MAX - c.x : c.x);
      const ry = dy / (dy >= 0 ? ADC_MAX - c.y : c.y);
      const r = Math.hypot(rx, ry);

      if (r > RANGE_GATE) {
        if (d.samples.length < RANGE_MAX_SAMPLES) d.samples.push({ x: s.x, y: s.y });
        const a = Math.atan2(ry, rx);
        const sector = sectorOf(a);
        if (!d.best[sector] || r > d.best[sector].r) d.best[sector] = { r, dx, dy };
        if (d.last !== null) {
          let delta = a - d.last;
          if (delta > Math.PI) delta -= 2 * Math.PI;
          if (delta < -Math.PI) delta += 2 * Math.PI;
          d.turns += delta;
        }
        d.last = a;
      } else {
        d.last = null;
      }

      const covered = d.best.filter(Boolean).length;
      const turns = Math.abs(d.turns) / (2 * Math.PI);
      setProgress(Math.min(1, turns / RANGE_TURNS));
      setCoverage(covered);

      if (turns >= RANGE_TURNS) {
        if (covered < SECTORS) {
          if (!d.warned) setMessage("Keep going and reach every part of the edge.");
          d.warned = true;
          return;
        }
        const built = buildRangeCalibration(c, d.samples);
        if (built.error) {
          goTo("range", built.error);
          return;
        }
        work.current.partial = { center: c, ...built, orientation: IDENTITY_ORIENTATION };
        work.current.reach = built.range;
        const weak = findWeakSides(built.range);
        work.current.weakSides = weak;
        if (weak.length) setWarning(formatWeakWarning(weak, DEFAULT_SIDE_LABELS));
        pauseThen("up");
      }
    }

    function handleHold(scaled, d, which) {
      if (!d.hold) d.hold = [];
      if (scaled.mag >= HOLD_MIN_MAG) d.hold.push(scaled);
      else d.hold = [];
      if (d.hold.length > HOLD_SAMPLES) d.hold.shift();
      setProgress(d.hold.length / HOLD_SAMPLES);
      if (d.hold.length < HOLD_SAMPLES) return;

      const x = d.hold.reduce((sum, p) => sum + p.x, 0) / HOLD_SAMPLES;
      const y = d.hold.reduce((sum, p) => sum + p.y, 0) / HOLD_SAMPLES;
      const mean = toDeg(Math.atan2(y, x));
      const steady = d.hold.every((p) => angleGap(toDeg(Math.atan2(p.y, p.x)), mean) <= HOLD_MAX_SPREAD_DEG);
      if (!steady) return;

      announce?.("Got it.");
      if (which === "up") {
        work.current.up = { x, y };
        pauseThen("right");
        return;
      }
      const orientation = detectOrientation(work.current.up, { x, y });
      if (orientation.error) {
        const extra = work.current.weakSides?.length
          ? " The uneven reach shown below is the likely cause."
          : " Let's try those two again.";
        goTo("up", orientation.error + extra);
        return;
      }
      const nextLabels = sideLabels(orientation);
      work.current.labels = nextLabels;
      setLabels(nextLabels);
      if (work.current.weakSides?.length) {
        setWarning(formatWeakWarning(work.current.weakSides, nextLabels));
      }
      work.current.cal = {
        ...work.current.partial,
        orientation,
        version: 1,
        auto: false,
        calibratedAt: new Date().toISOString(),
      };
      work.current.detector = createDirectionDetector();
      pauseThen("test");
    }

    /** How far the stick is from rest, using the best calibration measured so far. */
    function distanceFromRest(s) {
      const w = work.current;
      if (w.partial) return correct(w.partial, s.x, s.y).mag;
      const c = w.center;
      const dx = s.x - c.x;
      const dy = s.y - c.y;
      return Math.hypot(dx / (dx >= 0 ? ADC_MAX - c.x : c.x), dy / (dy >= 0 ? ADC_MAX - c.y : c.y));
    }

    function handlePause(s, d, now) {
      if (distanceFromRest(s) >= REST_MAG) {
        d.still = 0;
        d.readyAt = null;
        setCountdown(null);
        setProgress(0);
        return;
      }
      d.still = (d.still || 0) + 1;
      if (d.still < REST_SAMPLES) return;
      if (!d.readyAt) d.readyAt = now + PAUSE_MS;
      const left = d.readyAt - now;
      setCountdown(Math.max(1, Math.ceil(left / 1000)));
      setProgress(Math.min(1, 1 - left / PAUSE_MS));
      if (left <= 0) goTo(work.current.pauseNext);
    }

    function handleSample(s) {
      const now = Date.now();
      lastSampleAt.current = now;
      const w = work.current;
      if (!w.guess) w.guess = { x: s.x, y: s.y };
      const center = w.center || w.guess;
      const raw = { dx: s.x - center.x, dy: s.y - center.y };
      const current = phaseRef.current;
      const d = w.step;
      let corrected = null;
      let active = null;
      let outline = w.partial?.outline || [];

      if (current === "center") {
        handleCenter(s, d, now);
      } else if (current === "range") {
        handleRange(s, d);
        outline = (d.best || []).filter(Boolean).map((p) => [p.dx, p.dy]);
      } else if (current === "pause") {
        if (w.partial) corrected = correct(w.cal || w.partial, s.x, s.y);
        handlePause(s, d, now);
      } else if (current === "up" || current === "right") {
        corrected = correct(w.partial, s.x, s.y);
        handleHold(axisScaled(w.partial, s.x, s.y), d, current);
      } else if (current === "test") {
        corrected = correct(w.cal, s.x, s.y);
        active = corrected.mag > ENGAGE_FRAC ? directionFromAngle(corrected.angle) : null;
        const dir = w.detector.feed(corrected, now);
        if (dir) {
          setTestSelected(DIRECTIONS.indexOf(dir));
          setTestSeen((seen) => (seen.includes(dir) ? seen : [...seen, dir]));
        }
      }

      setView({ raw, corrected, outline, active });
      setReadings({
        x: s.x,
        y: s.y,
        rest: w.center || null,
        reach: w.reach || d.reach || null,
      });
    }

    return subscribeSamples(handleSample);
  }, [subscribeSamples, announce]);

  const stepIndex = STEPS.findIndex((s) => s.id === STEP_OF[phase === "pause" ? pauseNext : phase]);

  return (
    <div className="panel calib">
      <div className="calib-head">
        <h2>Joystick calibration</h2>
        <ol className="calib-steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={i < stepIndex ? "done" : i === stepIndex ? "on" : ""}>
              {i < stepIndex ? "✓" : i + 1}. {s.title}
            </li>
          ))}
        </ol>
      </div>

      <div className="calib-body">
        <div className="calib-text">
          {phase === "pause" ? (
            <>
              <p className="calib-instruction">
                {countdown ? `Get ready… ${countdown}` : "Let go of the joystick."}
              </p>
              <p className="calib-next">Next: {INSTRUCTIONS[pauseNext]}</p>
            </>
          ) : (
            <p className="calib-instruction">{INSTRUCTIONS[phase]}</p>
          )}
          {phase === "range" && (
            <p className="hint">
              Turns: {(progress * RANGE_TURNS).toFixed(1)} / {RANGE_TURNS} · edge covered: {coverage} / {SECTORS}
            </p>
          )}
          {(phase === "up" || phase === "right") && (
            <p className="hint">Keep holding until it says Got it.</p>
          )}
          {phase !== "test" && (
            <div className="calib-progress"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          )}
          {message && <p className="calib-message">{message}</p>}
          {warning && <p className="calib-warning">{warning}</p>}
          {stale && <p className="calib-message">No joystick data. Check that the joystick is connected.</p>}

          {phase === "test" && (
            <>
              <div className="calib-test-wheel">
                <Wheel items={TEST_ITEMS} selected={testSelected} onChoose={() => {}} />
              </div>
              <p className="hint">
                Confirmed:{" "}
                {DIRECTIONS.map((dir) => (
                  <span key={dir} className={`calib-seen ${testSeen.includes(dir) ? "ok" : ""}`}>
                    {dir[0] + dir.slice(1).toLowerCase()}
                  </span>
                ))}
              </p>
            </>
          )}
        </div>

        <div className="calib-side">
          <JoystickView
            raw={view.raw}
            corrected={view.corrected}
            outline={view.outline}
            engage={ENGAGE_FRAC}
            active={view.active}
          />
          <dl className="calib-readings">
            <dt>Raw</dt>
            <dd>X {Math.round(readings.x)} · Y {Math.round(readings.y)}</dd>
            <dt>Rest</dt>
            <dd>
              {readings.rest
                ? `X ${Math.round(readings.rest.x)} · Y ${Math.round(readings.rest.y)}`
                : "measuring…"}
            </dd>
            <dt>Reach</dt>
            <dd>
              {readings.reach ? (
                <ul>
                  {[
                    ["xPos", "X+"],
                    ["xNeg", "X−"],
                    ["yPos", "Y+"],
                    ["yNeg", "Y−"],
                  ].map(([side, raw]) => (
                    <li key={side}>
                      {labels[side]} ({raw}) {Math.round(readings.reach[side] || 0)}
                    </li>
                  ))}
                </ul>
              ) : (
                "after range step"
              )}
            </dd>
          </dl>
        </div>
      </div>

      <div className="actions">
        {phase === "test" && (
          <button type="button" className="primary" onClick={() => onSave(work.current.cal)}>
            Save calibration
          </button>
        )}
        {phase === "pause" && (
          <button type="button" onClick={() => goTo(pauseNext)}>Start now</button>
        )}
        {phase !== "center" && <button type="button" onClick={redo}>Start over</button>}
        {phase !== "test" && phase !== "pause" && (
          <button type="button" onClick={() => goTo(phase === "right" ? "up" : phase)}>
            Restart this step
          </button>
        )}
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
