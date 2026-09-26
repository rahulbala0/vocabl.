# joystick_bt_viewer.py
# Companion viewer for main.cpp. Parses raw ADC lines from the ESP32
# ("x,y,btn\n", 0-4095) and maps them onto a plot.
#
# Pair the ESP32 ("ESP32_Joystick") over Bluetooth first, note which
# serial port it created (e.g. COM5 on Windows, /dev/tty.ESP32_Joystick
# or /dev/rfcomm0 on macOS/Linux), then run:
#
#   pip install pyserial
#   python joystick_bt_viewer.py COM5
#
# Expected line format from the ESP32: "x,y,btn\n"
#   x, y : raw 12-bit ADC, 0-4095 (typical rest ~2900, not 2048)
#   btn  : 0 or 1
import math
import sys
import tkinter as tk
import serial

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM5"
BAUD = 115200

WINDOW = 420
MARGIN = 30
DOT_R = 12
GRID_STEP = 30

ADC_MAX = 4095
# Typical rest for this joystick (not the 12-bit midpoint).
REST_DEFAULT = 2900
# Fraction of the stick-map radius treated as deadzone. Inside this
# circle the cursor snaps to exact center so ADC noise doesn't jitter.
DEADZONE_FRAC = 0.18
CALIB_SAMPLES = 40

DIR_NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
DIR_ANGLE_DEG = [0, 45, 90, 135, 180, 225, 270, 315]  # clockwise from north

ser = serial.Serial(PORT, BAUD, timeout=0.1)

root = tk.Tk()
root.title("ESP32 Joystick Position")
canvas = tk.Canvas(root, width=WINDOW, height=WINDOW, bg="white")
canvas.pack()

cx, cy = WINDOW // 2, WINDOW // 2
plot_r = WINDOW // 2 - MARGIN
dead_r = plot_r * DEADZONE_FRAC

# --- Background grid ---------------------------------------------------
for gx in range(0, WINDOW, GRID_STEP):
    canvas.create_line(gx, 0, gx, WINDOW, fill="#eee")
for gy in range(0, WINDOW, GRID_STEP):
    canvas.create_line(0, gy, WINDOW, gy, fill="#eee")
canvas.create_line(cx, 0, cx, WINDOW, fill="#bbb")
canvas.create_line(0, cy, WINDOW, cy, fill="#bbb")
canvas.create_oval(cx - plot_r, cy - plot_r, cx + plot_r, cy + plot_r, outline="#ccc")
canvas.create_oval(
    cx - dead_r, cy - dead_r, cx + dead_r, cy + dead_r, outline="#cde", dash=(3, 3)
)

# --- 8-direction compass labels -----------------------------------------
label_r = plot_r + 16
dir_labels = {}
for name, ang in zip(DIR_NAMES, DIR_ANGLE_DEG):
    rad = math.radians(ang)
    lx = cx + label_r * math.sin(rad)
    ly = cy - label_r * math.cos(rad)
    dir_labels[name] = canvas.create_text(
        lx, ly, text=name, fill="#999", font=("Segoe UI", 10, "bold")
    )

dot = canvas.create_oval(
    cx - DOT_R, cy - DOT_R, cx + DOT_R, cy + DOT_R, fill="tomato", outline=""
)
status = canvas.create_text(8, 8, anchor="nw", text="calibrating rest...", fill="#333")
big_dir = canvas.create_text(cx, WINDOW - 14, text="Neutral", fill="#333", font=("Segoe UI", 14, "bold"))

buf = ""
rest_x = REST_DEFAULT
rest_y = REST_DEFAULT
calib_n = 0
calib_sx = 0
calib_sy = 0
calibrated = False


def octant(nx, ny):
    """Map normalized coords to an octant. +ny is down, +nx is right.
    North is -ny. Returns -1 at center."""
    if nx == 0 and ny == 0:
        return -1
    ang = math.degrees(math.atan2(nx, -ny))
    if ang < 0:
        ang += 360
    return int((ang + 22.5) // 45) % 8


def axis_norm(raw, rest):
    """Map one ADC axis to -1..1 using rest as 0, with independent
    travel toward 0 and toward ADC_MAX so an off-center rest still
    reaches the map edge."""
    delta = raw - rest
    span = (ADC_MAX - rest) if delta >= 0 else rest
    if span <= 0:
        return 0.0
    n = delta / span
    if n > 1.0:
        return 1.0
    if n < -1.0:
        return -1.0
    return n


def poll():
    global buf, rest_x, rest_y, calib_n, calib_sx, calib_sy, calibrated
    data = ser.read(256).decode(errors="ignore")
    if data:
        buf += data
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            line = line.strip()
            parts = line.split(",")
            if len(parts) != 3:
                continue
            try:
                x, y, btn = (int(v) for v in parts)
            except ValueError:
                continue

            if not calibrated:
                calib_n += 1
                calib_sx += x
                calib_sy += y
                canvas.itemconfig(
                    status, text=f"calibrating rest... {calib_n}/{CALIB_SAMPLES}  x={x} y={y}"
                )
                if calib_n >= CALIB_SAMPLES:
                    rest_x = calib_sx / calib_n
                    rest_y = calib_sy / calib_n
                    calibrated = True
                continue

            nx = axis_norm(x, rest_x)
            ny = axis_norm(y, rest_y)
            mag = math.hypot(nx, ny)
            if mag <= DEADZONE_FRAC:
                nx = 0.0
                ny = 0.0
                mag = 0.0

            px = cx + nx * plot_r
            py = cy + ny * plot_r

            color = "royalblue" if btn else "tomato"
            canvas.coords(dot, px - DOT_R, py - DOT_R, px + DOT_R, py + DOT_R)
            canvas.itemconfig(dot, fill=color)

            d = octant(nx, ny)
            d_name = DIR_NAMES[d] if 0 <= d < 8 else None
            for name, item in dir_labels.items():
                canvas.itemconfig(item, fill=("#e05" if name == d_name else "#999"))
            canvas.itemconfig(big_dir, text=d_name if d_name else "Neutral")
            canvas.itemconfig(
                status,
                text=(
                    f"x={x} y={y}  rest=({rest_x:.0f},{rest_y:.0f})  "
                    f"nx={nx:.2f} ny={ny:.2f}  mag={mag:.2f}  dir={d} btn={btn}"
                ),
            )
    root.after(15, poll)


poll()
root.mainloop()
