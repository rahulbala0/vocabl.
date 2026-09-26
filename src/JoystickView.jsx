const R = 92;
const UNIT = 70;
const MAX_DRAW = 1.3;
const ZONES = [
  { dir: "UP", from: -45, className: "zone-0" },
  { dir: "RIGHT", from: 45, className: "zone-1" },
  { dir: "DOWN", from: 135, className: "zone-2" },
  { dir: "LEFT", from: 225, className: "zone-3" },
];

/** Compass bearing (0 = up, clockwise) -> SVG point. */
function point(bearing, radius) {
  const a = (bearing * Math.PI) / 180;
  return [Math.sin(a) * radius, -Math.cos(a) * radius];
}

function zonePath(from) {
  const [x0, y0] = point(from, R);
  const [x1, y1] = point(from + 90, R);
  return `M 0 0 L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

function clampLength(x, y, max) {
  const len = Math.hypot(x, y);
  return len > max ? [(x / len) * max, (y / len) * max] : [x, y];
}

/**
 * Live stick diagram. The grey dot and dashed outline are raw ADC offsets from center, drawn
 * as the sensor reports them (no scaling or rotation), sized so the recorded outline fills
 * the 100% ring. The blue dot is the corrected position; the colored zones and rings apply to it.
 */
export default function JoystickView({ raw, corrected, outline = [], engage, active }) {
  const reach = Math.max(1, ...outline.map(([dx, dy]) => Math.hypot(dx, dy)));
  const rawScale = outline.length ? UNIT / reach : UNIT / 2048;
  const outlinePoints = outline.map(([dx, dy]) => `${(dx * rawScale).toFixed(1)},${(dy * rawScale).toFixed(1)}`).join(" ");
  const rawDot = raw ? clampLength(raw.dx * rawScale, raw.dy * rawScale, UNIT * MAX_DRAW) : null;
  const fixedDot = corrected ? clampLength(corrected.ux * UNIT, -corrected.uy * UNIT, UNIT * MAX_DRAW) : null;

  return (
    <figure className="joy-view">
      <svg viewBox="-100 -100 200 200" role="img" aria-label="Joystick position">
        {ZONES.map((zone) => (
          <path key={zone.dir} d={zonePath(zone.from)} className={`joy-zone ${zone.className} ${active === zone.dir ? "on" : ""}`} />
        ))}
        <circle r={UNIT} className="joy-ring" />
        <circle r={UNIT * engage} className="joy-engage" />
        {outlinePoints && <polygon points={outlinePoints} className="joy-outline" />}
        {rawDot && <circle cx={rawDot[0]} cy={rawDot[1]} r="5" className="joy-dot-raw" />}
        {fixedDot && <circle cx={fixedDot[0]} cy={fixedDot[1]} r="6" className="joy-dot-fixed" />}
        <text x="0" y={-R + 12} className="joy-label">Up</text>
        <text x={R - 14} y="4" className="joy-label">Right</text>
        <text x="0" y={R - 5} className="joy-label">Down</text>
        <text x={-R + 12} y="4" className="joy-label">Left</text>
      </svg>
      <figcaption>
        <span><i className="swatch raw" /> raw</span>
        <span><i className="swatch fixed" /> corrected</span>
        {outlinePoints && <span><i className="swatch outline" /> recorded range</span>}
      </figcaption>
    </figure>
  );
}
