/*
  SpeakEasy Board — ESP32 joystick firmware
  Click (SW / Z) = SELECT. Hold ~700ms = HOLD (custom wheel).
*/

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define DEVICE_NAME "SpeakEasy"
#define SERVICE_UUID        "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define CHAR_UUID_WRITE     "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define CHAR_UUID_NOTIFY    "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

#define PIN_VRX 34
#define PIN_VRY 35
#define PIN_SW  32
#define PIN_LED 2

#define ADC_LOW  1000
#define ADC_HIGH 3000
#define ADC_MID  2048
#define REPEAT_MS 450
#define DEBOUNCE_MS 40
#define HOLD_MS 700

#define INVERT_X false
#define INVERT_Y false

BLEServer *bleServer = nullptr;
BLECharacteristic *notifyChar = nullptr;
bool deviceConnected = false;
bool oldConnected = false;
volatile bool ledBlinkQueued = false;

unsigned long lastSentMs = 0;
String heldDir = "";
int lastSw = HIGH;
unsigned long lastSwChange = 0;
unsigned long pressStart = 0;
bool holdSent = false;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) { deviceConnected = true; }
  void onDisconnect(BLEServer *pServer) { deviceConnected = false; }
};

class WriteCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) { ledBlinkQueued = true; }
};

void blinkLedTwice() {
  digitalWrite(PIN_LED, HIGH);
  delay(80);
  digitalWrite(PIN_LED, LOW);
  delay(80);
  digitalWrite(PIN_LED, HIGH);
  delay(80);
  digitalWrite(PIN_LED, LOW);
}

void sendCommand(const char *cmd) {
  if (!deviceConnected || notifyChar == nullptr) {
    Serial.println(cmd);
    return;
  }
  notifyChar->setValue(cmd);
  notifyChar->notify();
  Serial.println(cmd);
}

String readDirection() {
  int x = analogRead(PIN_VRX);
  int y = analogRead(PIN_VRY);
  if (INVERT_X) x = 4095 - x;
  if (INVERT_Y) y = 4095 - y;
  int dx = x - ADC_MID;
  int dy = y - ADC_MID;
  bool xPush = x < ADC_LOW || x > ADC_HIGH;
  bool yPush = y < ADC_LOW || y > ADC_HIGH;
  if (!xPush && !yPush) return "";
  if (abs(dx) >= abs(dy)) return x < ADC_MID ? "LEFT" : "RIGHT";
  return y < ADC_MID ? "UP" : "DOWN";
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_SW, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  analogSetPinAttenuation(PIN_VRX, ADC_11db);
  analogSetPinAttenuation(PIN_VRY, ADC_11db);

  BLEDevice::init(DEVICE_NAME);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());
  BLEService *service = bleServer->createService(SERVICE_UUID);
  notifyChar = service->createCharacteristic(CHAR_UUID_NOTIFY, BLECharacteristic::PROPERTY_NOTIFY);
  notifyChar->addDescriptor(new BLE2902());
  BLECharacteristic *writeChar = service->createCharacteristic(
      CHAR_UUID_WRITE,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  writeChar->setCallbacks(new WriteCallbacks());
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
}

void loop() {
  if (ledBlinkQueued) {
    ledBlinkQueued = false;
    blinkLedTwice();
  }

  if (!deviceConnected && oldConnected) {
    delay(300);
    bleServer->startAdvertising();
    oldConnected = deviceConnected;
  }
  if (deviceConnected && !oldConnected) oldConnected = deviceConnected;

  int sw = digitalRead(PIN_SW);
  unsigned long now = millis();
  if (sw != lastSw && (now - lastSwChange) > DEBOUNCE_MS) {
    lastSwChange = now;
    lastSw = sw;
    if (sw == LOW) {
      pressStart = now;
      holdSent = false;
    } else {
      if (!holdSent) sendCommand("SELECT");
      holdSent = false;
    }
  }
  if (lastSw == LOW && !holdSent && (now - pressStart) >= HOLD_MS) {
    holdSent = true;
    sendCommand("HOLD");
  }

  String dir = readDirection();
  if (dir.length() == 0) {
    heldDir = "";
  } else if (dir != heldDir) {
    heldDir = dir;
    lastSentMs = now;
    sendCommand(dir.c_str());
  } else if (now - lastSentMs >= REPEAT_MS) {
    lastSentMs = now;
    sendCommand(dir.c_str());
  }

  delay(15);
}
