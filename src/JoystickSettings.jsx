import { useEffect, useState } from "react";
import JoystickView from "./JoystickView.jsx";
import { directionFromAngle } from "./lib/calibration";
import { ENGAGE_FRAC } from "./lib/joystick";

export default function JoystickSettings({ connected, connecting, canConnect, onConnect, calibration, subscribeSamples, onCalibrate, onReset }) {
  const [view, setView] = useState(null);

  useEffect(() => {
    if (!connected) {
      setView(null);
      return undefined;
    }
    return subscribeSamples((s) => {
      const cal = s.calibration;
      const c = s.corrected;
      setView({
        raw: cal ? { dx: s.x - cal.center.x, dy: s.y - cal.center.y } : null,
        corrected: c,
        outline: cal?.outline || [],
        active: c && c.mag > ENGAGE_FRAC ? directionFromAngle(c.angle) : null,
      });
    });
  }, [connected, subscribeSamples]);

  const status = calibration
    ? `Calibrated ${new Date(calibration.calibratedAt).toLocaleString()}`
    : "Not calibrated. The resting position is measured each time the joystick connects.";

  return (
    <fieldset className="joy-settings">
      <legend>Joystick</legend>
      <p className="hint">{status}</p>
      {connected && view && (
        <JoystickView
          raw={view.raw}
          corrected={view.corrected}
          outline={view.outline}
          engage={ENGAGE_FRAC}
          active={view.active}
        />
      )}
      {connected && !view && <p className="hint">Waiting for joystick readings…</p>}
      <div className="actions">
        {!connected && (
          <button type="button" onClick={onConnect} disabled={!canConnect || connecting}>
            {connecting ? "Connecting…" : "Connect joystick"}
          </button>
        )}
        <button type="button" className="primary" onClick={onCalibrate} disabled={!connected}>
          Calibrate…
        </button>
        {calibration && <button type="button" onClick={onReset}>Reset calibration</button>}
      </div>
    </fieldset>
  );
}
