# neopixel — tests assert (BT63): eight WS2812 pixels on GP2 through MicroPython's neopixel
# module: pixel 0 steps red → green → blue every 500 ms, pixels 1–3 hold green, blue and dim
# white; "shown <n>" after each write.
import time
import neopixel
from machine import Pin

np = neopixel.NeoPixel(Pin(2), 8)
colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255)]
n = 0
while True:
    np[0] = colors[n % 3]
    np[1] = (0, 255, 0)
    np[2] = (0, 0, 255)
    np[3] = (16, 16, 16)
    np.write()
    print("shown", n)
    n += 1
    time.sleep_ms(500)
