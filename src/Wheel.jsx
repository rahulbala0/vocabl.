import { useEffect, useLayoutEffect, useRef } from "react";
import { ENGAGE_FRAC } from "./lib/joystick";

const ANGLE_OFFSET = (-3 * Math.PI) / 4;
const HOLD_MS = 700;
const LABEL_MIN_PX = 13;
const WHEEL_CX = 50;
const WHEEL_CY = 50;
const WHEEL_R = 46.5;
const STICK_DOT_R = 1.7;
const STICK_DEADZONE = ENGAGE_FRAC;

function slicePath(index, count, cx = 50, cy = 50, r = 46.5) {
  const a0 = (index / count) * 2 * Math.PI + ANGLE_OFFSET;
  const a1 = ((index + 1) / count) * 2 * Math.PI + ANGLE_OFFSET;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = count === 1 || (2 * Math.PI) / count > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`;
}

function labelStyle(index, count) {
  const mid = ((index + 0.5) / count) * 2 * Math.PI + ANGLE_OFFSET;
  const d = 28;
  return {
    left: `${50 + d * Math.cos(mid)}%`,
    top: `${50 + d * Math.sin(mid)}%`,
  };
}

function clampLength(x, y, max) {
  const len = Math.hypot(x, y);
  return len > max ? [(x / len) * max, (y / len) * max] : [x, y];
}

function stickDotPoint(corrected) {
  const max = WHEEL_R - STICK_DOT_R;
  if (!corrected) return [WHEEL_CX, WHEEL_CY];
  const mag = Number.isFinite(corrected.mag)
    ? corrected.mag
    : Math.hypot(corrected.ux, corrected.uy);
  if (mag < STICK_DEADZONE) return [WHEEL_CX, WHEEL_CY];
  const t = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  const ux = (corrected.ux / mag) * t;
  const uy = (corrected.uy / mag) * t;
  const [dx, dy] = clampLength(ux * WHEEL_R, -uy * WHEEL_R, max);
  return [WHEEL_CX + dx, WHEEL_CY + dy];
}

function fitSpokeLabels(root) {
  if (!root) return;
  root.querySelectorAll(".spoke-text").forEach((el) => {
    const box = el.parentElement;
    if (!box) return;
    el.style.fontSize = "";
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (
      size > LABEL_MIN_PX &&
      (el.scrollHeight > box.clientHeight - 2 || el.scrollWidth > box.clientWidth - 2)
    ) {
      size -= 0.5;
      el.style.fontSize = `${size}px`;
    }
  });
}

export default function Wheel({ items, selected, onChoose, onHover, onHubSelect, onHubHold, busy, speaking, listening, connected, subscribeSamples }) {
  const count = Math.max(items.length, 1);
  const pressAt = useRef(0);
  const rootRef = useRef(null);
  const stickRef = useRef(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const run = () => fitSpokeLabels(root);
    run();
    const observer = new ResizeObserver(run);
    observer.observe(root);
    return () => observer.disconnect();
  }, [items, selected, busy]);

  useEffect(() => {
    const dot = stickRef.current;
    if (!dot) return undefined;
    const place = (el, corrected) => {
      const [x, y] = stickDotPoint(corrected);
      el.style.left = `${((x + 3) / 106) * 100}%`;
      el.style.top = `${((y + 3) / 106) * 100}%`;
    };
    if (!connected || !subscribeSamples) {
      dot.hidden = true;
      return undefined;
    }
    dot.hidden = false;
    place(dot, null);
    return subscribeSamples((sample) => {
      const next = stickRef.current;
      if (!next) return;
      place(next, sample.corrected);
    });
  }, [connected, subscribeSamples]);

  function hoverProps(index) {
    if (!onHover) return {};
    return {
      onPointerEnter: (event) => {
        if (event.pointerType === "mouse") onHover(index);
      },
    };
  }

  const wheelClass = [
    "wheel",
    listening && "is-listening",
    busy && "is-busy",
    speaking && "is-speaking",
    selected >= 0 && "has-selection",
  ]
    .filter(Boolean)
    .join(" ");

  function onPointerDown(event) {
    event.preventDefault();
    pressAt.current = Date.now();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerUp() {
    const elapsed = Date.now() - pressAt.current;
    pressAt.current = 0;
    if (elapsed >= HOLD_MS) {
      onHubHold?.();
      return;
    }
    onHubSelect?.();
  }

  return (
    <div ref={rootRef} className={wheelClass} role="listbox" aria-label="Reply wheel" aria-busy={Boolean(busy)}>
      <svg viewBox="-3 -3 106 106" className="wheel-svg" aria-hidden="true">
        {items.map((item, i) => (
          i === selected ? null : (
            <path
              key={item.id}
              d={slicePath(i, count)}
              className={`slice slice-${i}`}
              {...hoverProps(i)}
            />
          )
        ))}
        {selected >= 0 && items[selected] && (
          <path
            d={slicePath(selected, count, 50, 50, 48.6)}
            className={`slice slice-${selected} on`}
            {...hoverProps(selected)}
          />
        )}
        <circle cx="50" cy="50" r="8" className={`hub-select-bg ${selected >= 0 ? `tone-${selected}` : "idle"}`} />
      </svg>

      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === selected}
          className={`spoke ${i === selected ? "on" : ""} ${item.kind}`}
          style={labelStyle(i, count)}
          disabled={busy}
          onClick={() => onChoose(i)}
          {...hoverProps(i)}
        >
          <span className="spoke-text">{item.label.replace(/\u00AD/g, "")}</span>
        </button>
      ))}

      <button
        type="button"
        className={`hub-select ${selected >= 0 ? `tone-${selected}` : "idle"}`}
        aria-label={busy ? "Thinking of replies" : "Click to speak the highlighted reply. Hold for custom phrases."}
        disabled={busy}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          pressAt.current = 0;
        }}
      >
        {busy ? "Thinking" : ""}
      </button>
      <div ref={stickRef} className="wheel-stick" hidden aria-hidden="true" />
    </div>
  );
}
