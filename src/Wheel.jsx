function slicePath(index, count, cx = 50, cy = 50, r = 48) {
  const a0 = (index / count) * 2 * Math.PI - Math.PI / 2;
  const a1 = ((index + 1) / count) * 2 * Math.PI - Math.PI / 2;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = count === 1 || 2 * Math.PI / count > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`;
}

function labelStyle(index, count) {
  const mid = ((index + 0.5) / count) * 2 * Math.PI - Math.PI / 2;
  const d = 30;
  return {
    left: `${50 + d * Math.cos(mid)}%`,
    top: `${50 + d * Math.sin(mid)}%`,
  };
}

export default function Wheel({ items, selected, onChoose, hubLabel, onHub }) {
  const count = Math.max(items.length, 1);

  return (
    <div className="wheel" role="listbox" aria-label="Reply wheel">
      <svg viewBox="0 0 100 100" className="wheel-svg" aria-hidden="true">
        {items.map((item, i) => (
          <path
            key={item.id}
            d={slicePath(i, count)}
            className={`slice ${i === selected ? "on" : ""}`}
          />
        ))}
        <circle cx="50" cy="50" r="14" className="hub-ring" />
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
      <button type="button" className="hub" onClick={onHub}>
        {hubLabel}
      </button>
    </div>
  );
}
