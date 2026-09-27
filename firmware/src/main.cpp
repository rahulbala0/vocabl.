// Analog joystick over BLE Nordic UART so Chrome Web Bluetooth can read it.
// Notify lines: "x,y,sw,btn,alt\n" (ADC 0-4095, buttons 0 or 1, pressed = 1).
//
// Wiring:
//   Joystick VRx -> GPIO14
//   Joystick VRy -> GPIO12
//   Joystick SW  -> GPIO13 (INPUT_PULLUP, pressed = LOW)  // Select hovered reply
//   Button A     -> GPIO33 (INPUT_PULLUP, pressed = LOW)  // Select hovered reply
//   Button B     -> GPIO25 (INPUT_PULLUP, pressed = LOW)  // Mute / unmute mic
//   Joystick VCC -> 3.3V, GND -> GND
//   Buttons      -> pin and GND (idle = HIGH)
//   Status LED   -> GPIO2 (blinks when the tablet writes SELECT)

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

static const char *DEVICE_NAME = "SpeakEasy";
static const char *SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char *CHAR_WRITE_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
static const char *CHAR_NOTIFY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

static const int PIN_JOY_X = 14;
static const int PIN_JOY_Y = 12;
static const int PIN_JOY_SW = 13;
static const int PIN_BTN_A = 33;
static const int PIN_BTN_B = 25;
static const int PIN_LED = 2;

static const unsigned long SEND_INTERVAL_MS = 30;

BLECharacteristic *notifyChar = nullptr;
volatile bool deviceConnected = false;
volatile bool blinkSelect = false;

class ServerCallbacks : public BLEServerCallbacks
{
    void onConnect(BLEServer *) override
    {
        deviceConnected = true;
    }

    void onDisconnect(BLEServer *server) override
    {
        deviceConnected = false;
        server->startAdvertising();
    }
};

class WriteCallbacks : public BLECharacteristicCallbacks
{
    void onWrite(BLECharacteristic *characteristic) override
    {
        auto value = characteristic->getValue();
        String raw = value.c_str();
        raw.toUpperCase();
        raw.trim();
        if (raw == "SELECT")
        {
            blinkSelect = true;
        }
    }
};

void setup()
{
    Serial.begin(115200);
    pinMode(PIN_JOY_SW, INPUT_PULLUP);
    pinMode(PIN_BTN_A, INPUT_PULLUP);
    pinMode(PIN_BTN_B, INPUT_PULLUP);
    pinMode(PIN_LED, OUTPUT);
    digitalWrite(PIN_LED, LOW);
    analogReadResolution(12);
    analogSetPinAttenuation(PIN_JOY_X, ADC_11db);
    analogSetPinAttenuation(PIN_JOY_Y, ADC_11db);

    BLEDevice::init(DEVICE_NAME);
    BLEServer *server = BLEDevice::createServer();
    server->setCallbacks(new ServerCallbacks());

    BLEService *service = server->createService(SERVICE_UUID);

    notifyChar = service->createCharacteristic(
        CHAR_NOTIFY_UUID,
        BLECharacteristic::PROPERTY_NOTIFY);
    notifyChar->addDescriptor(new BLE2902());

    BLECharacteristic *writeChar = service->createCharacteristic(
        CHAR_WRITE_UUID,
        BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
    writeChar->setCallbacks(new WriteCallbacks());

    service->start();

    // Put the short name in the primary adv packet and the 128-bit Nordic
    // UART UUID in the scan response. Advertising both in one packet is too
    // large, so Chrome's name filter otherwise sees "no compatible devices".
    BLEAdvertising *advertising = BLEDevice::getAdvertising();
    BLEAdvertisementData adv;
    adv.setFlags(0x06); // general discoverable, BR/EDR not supported
    adv.setName(DEVICE_NAME);
    advertising->setAdvertisementData(adv);

    BLEAdvertisementData scan;
    scan.setCompleteServices(BLEUUID(SERVICE_UUID));
    advertising->setScanResponseData(scan);
    advertising->start();

    Serial.println("BLE started. Connect to SpeakEasy from Chrome.");
}

void loop()
{
    if (blinkSelect)
    {
        blinkSelect = false;
        digitalWrite(PIN_LED, HIGH);
        delay(80);
        digitalWrite(PIN_LED, LOW);
        delay(80);
        digitalWrite(PIN_LED, HIGH);
        delay(80);
        digitalWrite(PIN_LED, LOW);
    }

    static unsigned long lastSendTime = 0;
    unsigned long now = millis();
    if (now - lastSendTime < SEND_INTERVAL_MS)
    {
        return;
    }
    lastSendTime = now;

    int x = analogRead(PIN_JOY_X);
    int y = analogRead(PIN_JOY_Y);
    int sw = digitalRead(PIN_JOY_SW) == LOW ? 1 : 0;
    int btn = digitalRead(PIN_BTN_A) == LOW ? 1 : 0;
    int alt = digitalRead(PIN_BTN_B) == LOW ? 1 : 0;

    Serial.printf("x=%d y=%d sw=%d btn=%d alt=%d\n", x, y, sw, btn, alt);

    if (!deviceConnected || notifyChar == nullptr)
    {
        return;
    }

    char line[40];
    int n = snprintf(line, sizeof(line), "%d,%d,%d,%d,%d\n", x, y, sw, btn, alt);
    if (n > 0)
    {
        notifyChar->setValue((uint8_t *)line, (size_t)n);
        notifyChar->notify();
    }
}
