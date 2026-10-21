# blink — tests assert (BT63): the Pico's LED (GP25) toggles every 250 ms; each toggle's count
# goes to USB serial.
import time
from machine import Pin

led = Pin("LED", Pin.OUT)
n = 0
while True:
    led.toggle()
    print("blink", n)
    n += 1
    time.sleep_ms(250)
