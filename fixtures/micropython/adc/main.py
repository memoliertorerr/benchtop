# adc — tests assert (BT63): a potentiometer on GP26 (ADC0) read with read_u16 ten times a
# second, printed as 12 bits ("adc=<0–4095>").
import time
from machine import ADC

pot = ADC(26)
while True:
    print("adc=%d" % (pot.read_u16() >> 4))
    time.sleep_ms(100)
