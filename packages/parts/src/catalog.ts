/**
 * The part catalog: every part type Benchtop knows, by `PartDefinition.type`. The bench gets
 * definitions through `benchEnvParts`; the editor lists them by category.
 */

import type { PartDefinition } from '@benchtop/core';
import { led } from './basic/led.ts';
import { potentiometer } from './basic/potentiometer.ts';
import { pushbutton } from './basic/pushbutton.ts';
import { resistor } from './basic/resistor.ts';
import { rgbLed } from './basic/rgb-led.ts';
import { slideSwitch } from './basic/slide-switch.ts';
import { arduinoMega } from './boards/arduino-mega.ts';
import { arduinoNano } from './boards/arduino-nano.ts';
import { arduinoUno } from './boards/arduino-uno.ts';
import { esp32DevkitV1 } from './boards/esp32-devkit-v1.ts';
import { raspberryPiPico, raspberryPiPico2 } from './boards/raspberry-pi-pico.ts';
import { buzzer } from './actuators/buzzer.ts';
import { neopixelMatrix, neopixelRing, neopixelStrip } from './actuators/neopixel.ts';
import { relayKs2e } from './actuators/relay.ts';
import { servo } from './actuators/servo.ts';
import { speaker } from './actuators/speaker.ts';
import { stepper28byj48, stepperBipolar } from './actuators/stepper.ts';
import { breadboards } from './breadboards/breadboard.ts';
import { lcd1602, lcd1602I2c, lcd2004, lcd2004I2c } from './displays/lcd.ts';
import { ledBarGraph } from './displays/led-bar-graph.ts';
import { sevenSegment, sevenSegment2, sevenSegment4 } from './displays/seven-segment.ts';
import { ili9341 } from './displays/ili9341.ts';
import { irReceiver } from './inputs/ir-receiver.ts';
import { irRemote } from './inputs/ir-remote.ts';
import { hx711 } from './sensors/hx711.ts';
import { flameSensor, gasSensor } from './sensors/flame-gas.ts';
import { a4988 } from './actuators/a4988.ts';
import { ssd1306 } from './displays/ssd1306.ts';
import { analogJoystick } from './inputs/analog-joystick.ts';
import { dipSwitch8 } from './inputs/dip-switch-8.ts';
import { ky040 } from './inputs/ky-040.ts';
import { membraneKeypad } from './inputs/membrane-keypad.ts';
import { slidePotentiometer } from './inputs/slide-potentiometer.ts';
import { tiltSwitch } from './inputs/tilt-switch.ts';
import { dht22 } from './sensors/dht22.ts';
import { ds1307 } from './sensors/ds1307.ts';
import { hcSr04 } from './sensors/hc-sr04.ts';
import { microphone } from './sensors/microphone.ts';
import { mpu6050 } from './sensors/mpu6050.ts';
import { ntcTemperatureSensor } from './sensors/ntc-temperature-sensor.ts';
import { photoresistorSensor } from './sensors/photoresistor-sensor.ts';
import { pirMotionSensor } from './sensors/pir-motion-sensor.ts';
import { bigSoundSensor, smallSoundSensor } from './sensors/sound-sensor.ts';
import { ENVIRONMENT_PARTS } from './environment/parts.ts';
import { POWER_REGULATORS } from './power/regulators.ts';
import { POWER_SOURCES } from './power/sources.ts';

const ALL: readonly PartDefinition[] = [
  arduinoUno,
  arduinoNano,
  arduinoMega,
  esp32DevkitV1,
  raspberryPiPico,
  raspberryPiPico2,
  ...breadboards,
  resistor,
  led,
  rgbLed,
  pushbutton,
  slideSwitch,
  potentiometer,
  buzzer,
  speaker,
  lcd1602,
  lcd2004,
  lcd1602I2c,
  lcd2004I2c,
  sevenSegment,
  sevenSegment2,
  sevenSegment4,
  ledBarGraph,
  ssd1306,
  ili9341,
  irReceiver,
  irRemote,
  hx711,
  flameSensor,
  gasSensor,
  a4988,
  slidePotentiometer,
  analogJoystick,
  ky040,
  membraneKeypad,
  dipSwitch8,
  tiltSwitch,
  pirMotionSensor,
  photoresistorSensor,
  ntcTemperatureSensor,
  smallSoundSensor,
  bigSoundSensor,
  microphone,
  dht22,
  hcSr04,
  ds1307,
  mpu6050,
  servo,
  stepper28byj48,
  stepperBipolar,
  neopixelStrip,
  neopixelRing,
  neopixelMatrix,
  relayKs2e,
  ...POWER_SOURCES,
  ...POWER_REGULATORS,
  ...ENVIRONMENT_PARTS,
];

export const CATALOG: ReadonlyMap<string, PartDefinition> = new Map(ALL.map((d) => [d.type, d]));

/** The `BenchEnv.part` lookup over the catalog. */
export function benchEnvParts(type: string): PartDefinition | undefined {
  return CATALOG.get(type);
}
