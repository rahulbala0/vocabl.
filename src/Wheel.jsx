// Offset so index-0 midpoint is at 12 o'clock (UP), giving the diamond orientation.
// Standard formula: mid = (i+0.5)/n * 2π + offset = -π/2  →  offset = -3π/4
const ANGLE_OFFSET = (-3 * Math.PI) / 4;

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

export default function Wheel({ items, selected, onChoose, onYes, onNo, busy, speaking, listening }) {
  const count = Math.max(items.length, 1);

  const wheelClass = ["wheel", listening && "is-listening", busy && "is-busy", speaking && "is-speaking"]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wheelClass} role="listbox" aria-label="Reply wheel">
      <svg viewBox="0 0 100 100" className="wheel-svg" aria-hidden="true">
        {items.map((item, i) => (
          <path
            key={item.id}
            d={slicePath(i, count)}
            className={`slice slice-${i} ${i === selected ? "on" : ""}`}
          />
        ))}
        {/* Hub: top half = Yes (green), bottom half = No (red), clipped by border-radius on wrapper */}
        <path d="M 36 50 A 14 14 0 0 1 64 50 Z" className="hub-yes-bg" />
        <path d="M 64 50 A 14 14 0 0 1 36 50 Z" className="hub-no-bg" />
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
        >
          {item.label}
        </button>
      ))}

      {/* Yes/No hub — wrapper clips both halves to a circle */}
      <div className="hub-wrapper">
        <button type="button" className="hub hub-yes" onClick={onYes} aria-label="Say Yes">
          Yes
        </button>
        <button type="button" className="hub hub-no" onClick={onNo} aria-label="Say No">
          No
        </button>
      </div>
    </div>
  );
}
