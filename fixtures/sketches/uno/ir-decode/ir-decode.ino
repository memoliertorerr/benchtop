// ir-decode — tests assert (BT52): an IR receiver's DAT on D2 (INPUT_PULLUP), decoded by a
// sketch-local NEC decoder that times edges with micros() in a CHANGE interrupt. Each frame
// prints "key <name> 0x<command>" at 115200 baud (the remote's key names; "?" for other
// commands), each repeat code "repeat", and a frame whose command doesn't match its inverse "bad".
const uint8_t IR_PIN = 2;

const uint8_t CODES[] = {0xa2, 0xe2, 0x22, 0x02, 0xc2, 0xe0, 0xa8, 0x90, 0x68, 0x98, 0xb0,
                         0x30, 0x18, 0x7a, 0x10, 0x38, 0x5a, 0x42, 0x4a, 0x52};
const char *const NAMES[] = {"power", "menu", "test", "plus", "back", "prev", "play", "next", "0", "minus", "c",
                             "1", "2", "3", "4", "5", "6", "7", "8", "9"};

enum State : uint8_t { IDLE, LEADER, BITS };
volatile State state = IDLE;
volatile uint32_t lastEdge = 0;
volatile uint32_t bits = 0;
volatile uint8_t count = 0;
volatile bool frameReady = false;
volatile bool repeatReady = false;
volatile uint32_t frame = 0;

void onEdge() {
  uint32_t now = micros();
  uint32_t length = now - lastEdge; // how long the level before this edge lasted
  lastEdge = now;
  bool high = digitalRead(IR_PIN);
  if (high) {
    // A mark (low) just ended.
    if (state == IDLE) {
      if (length > 8000 && length < 10000) state = LEADER;
    } else if (state == BITS && (length < 400 || length > 750)) {
      state = IDLE;
    }
  } else {
    // A space (high) just ended.
    if (state == LEADER) {
      if (length > 4000 && length < 5000) {
        state = BITS;
        bits = 0;
        count = 0;
      } else {
        if (length > 2000 && length < 2600) repeatReady = true;
        state = IDLE;
      }
    } else if (state == BITS) {
      if (length > 1300 && length < 2000) bits |= (uint32_t)1 << count;
      else if (length < 400 || length > 750) {
        state = IDLE;
        return;
      }
      if (++count == 32) {
        frame = bits;
        frameReady = true;
        state = IDLE;
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(IR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(IR_PIN), onEdge, CHANGE);
  Serial.println("ready");
}

void loop() {
  if (frameReady) {
    noInterrupts();
    uint32_t f = frame;
    frameReady = false;
    interrupts();
    uint8_t command = (f >> 16) & 0xff;
    uint8_t inverse = f >> 24;
    if ((uint8_t)(command ^ inverse) != 0xff) {
      Serial.println("bad");
    } else {
      const char *name = "?";
      for (uint8_t i = 0; i < sizeof CODES; i++)
        if (CODES[i] == command) name = NAMES[i];
      Serial.print("key ");
      Serial.print(name);
      Serial.print(" 0x");
      if (command < 0x10) Serial.print('0');
      Serial.println(command, HEX);
    }
  }
  if (repeatReady) {
    repeatReady = false;
    Serial.println("repeat");
  }
}
