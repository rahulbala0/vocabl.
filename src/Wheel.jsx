import { useRef } from "react";

const ANGLE_OFFSET = (-3 * Math.PI) / 4;
const HOLD_MS = 700;

function slicePath(index, count, cx = 50, cy = 50, r = 48) {
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
  const d = 30;
  return {
    left: `${50 + d * Math.cos(mid)}%`,
    top: `${50 + d * Math.sin(mid)}%`,
    animationDelay: `${index * 0.07}s`,
  };
}

export default function Wheel({ items, selected, onChoose, onHover, onHubSelect, onHubHold, busy, speaking, listening }) {
  const count = Math.max(items.length, 1);
  const pressAt = useRef(0);

  function hoverProps(index) {
    if (!onHover) return {};
    return {
      onPointerEnter: (event) => {
        if (event.pointerType === "mouse") onHover(index);
      },
    };
  }

  const wheelClass = ["wheel", listening && "is-listening", busy && "is-busy", speaking && "is-speaking"]
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
    <div className={wheelClass} role="listbox" aria-label="Reply wheel">
      <svg viewBox="0 0 100 100" className="wheel-svg" aria-hidden="true">
        {items.map((item, i) => (
          <path
            key={item.id}
            d={slicePath(i, count)}
            className={`slice slice-${i} ${i === selected ? "on" : ""}`}
            {...hoverProps(i)}
          />
        ))}
        <circle cx="50" cy="50" r="14" className={`hub-select-bg ${selected < 0 ? "on" : ""}`} />
      </svg>

      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === selected}
          className={`spoke ${i === selected ? "on" : ""} ${item.kind}`}
          style={labelStyle(i, count)}
          onClick={() => onChoose(i)}
          {...hoverProps(i)}
        >
          {item.label}
        </button>
      ))}

      <button
        type="button"
        className={`hub-select ${selected < 0 ? "on" : ""}`}
        aria-label="Click to speak the highlighted reply. Hold for custom phrases."
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          pressAt.current = 0;
        }}
      >
        OK
      </button>
    </div>
  );
}
