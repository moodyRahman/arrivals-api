#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <Fonts/Org_01.h>

const char* WIFI_SSID = "moodfi";
const char* WIFI_PASSWORD = "afnan921";


#define PANEL_RES_X 32
#define PANEL_RES_Y 16
#define PANEL_CHAIN 1
#define PIXEL_COUNT (PANEL_RES_X * PANEL_RES_Y)

const char* PIXELS_URL = "http://192.168.1.161:3000/api/pixels";
const uint32_t POLL_INTERVAL_MS = 100;

HUB75_I2S_CFG::i2s_pins HUB75_PINS = {
  18, 17, 19,          // R1, G1, B1
  21, 23, 27,         // R2, G2, B2
  26, 16, 25, 4, -1, // A, B, C, D, E
  2,                // LAT
  32,              // OE
  33              // CLK
};

MatrixPanel_I2S_DMA* dma_display = nullptr;

void setup() {

  Serial.begin(115200);

  HUB75_I2S_CFG mxconfig(
    PANEL_RES_X,
    PANEL_RES_Y,
    PANEL_CHAIN,
    HUB75_PINS
  );

  dma_display = new MatrixPanel_I2S_DMA(mxconfig);

  if (!dma_display->begin()) {
    while (1);
  }

  dma_display->setBrightness8(90);
  dma_display->setTextWrap(false);
  dma_display->setFont(&Org_01);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(30);
  }

}

static inline uint8_t hexNibble(char c) {
  return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10;
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(500);
    return;
  }

  static HTTPClient http;
  static bool started = false;
  if (!started) {
    http.begin(PIXELS_URL);
    http.setReuse(true);
    http.setTimeout(2000);
    started = true;
  }

  if (http.GET() != HTTP_CODE_OK) {
    http.end();
    started = false;
  } else {
    String body = http.getString();
    if (body.length() >= PIXEL_COUNT * 6) {
      const char* p = body.c_str();
      for (int i = 0; i < PIXEL_COUNT; i++, p += 6) {
        uint8_t r = (hexNibble(p[0]) << 4) | hexNibble(p[1]);
        uint8_t g = (hexNibble(p[2]) << 4) | hexNibble(p[3]);
        uint8_t b = (hexNibble(p[4]) << 4) | hexNibble(p[5]);
        dma_display->drawPixelRGB888(i % PANEL_RES_X, i / PANEL_RES_X, r, g, b);
      }
    }
  }

  delay(POLL_INTERVAL_MS);
}
