import { createJoystickCommandParser } from "./joystick";

const SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CHAR_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const CHAR_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

export function bluetoothSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
}

export async function connectSpeakEasy(onCommand) {
  if (!bluetoothSupported()) {
    throw new Error("Web Bluetooth needs Chrome (not iOS).");
  }
  // OR filters: ESP32 often omits the Complete Local Name when a 128-bit
  // service UUID fills the adv packet, so name-only matching fails in Chrome.
  const device = await navigator.bluetooth.requestDevice({
    filters: [
      { name: "SpeakEasy" },
      { namePrefix: "Speak" },
      { services: [SERVICE] },
    ],
    optionalServices: [SERVICE],
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE);
  const notify = await service.getCharacteristic(CHAR_NOTIFY);
  const write = await service.getCharacteristic(CHAR_WRITE);

  const decoder = new TextDecoder("utf-8");
  const parse = createJoystickCommandParser(onCommand);
  const handler = (event) => {
    const text = decoder.decode(event.target.value);
    if (text) parse(text);
  };
  await notify.startNotifications();
  notify.addEventListener("characteristicvaluechanged", handler);

  const disconnect = async () => {
    notify.removeEventListener("characteristicvaluechanged", handler);
    try {
      await notify.stopNotifications();
    } catch {
      /* ignore */
    }
    if (device.gatt.connected) device.gatt.disconnect();
  };

  device.addEventListener("gattserverdisconnected", () => {
    onCommand("DISCONNECTED");
  });

  return {
    device,
    pingLed: async () => {
      const payload = new TextEncoder().encode("SELECT");
      try {
        if (write.properties.writeWithoutResponse) {
          await write.writeValueWithoutResponse(payload);
        } else {
          await write.writeValue(payload);
        }
      } catch {
        /* LED feedback is optional */
      }
    },
    disconnect,
  };
}
