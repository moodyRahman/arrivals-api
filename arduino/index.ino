#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <Fonts/Org_01.h>

#define PANEL_RES_X 32
#define PANEL_RES_Y 16
#define PANEL_CHAIN 1
#define PIXEL_COUNT (PANEL_RES_X * PANEL_RES_Y)

const char* PIXELS_URL = "https://arrival.moodyrahman.com/api/pixels";
const uint32_t POLL_INTERVAL_MS = 45000;
const uint32_t RETRY_INTERVAL_MS = 3000;
const uint16_t HTTP_TIMEOUT_MS = 5000; // TLS handshake can exceed 2s

// Wi-Fi provisioning
const char* AP_SSID = "Arrivals-Setup";          // open access point for the setup page
const uint32_t BOOT_CONNECT_TIMEOUT_MS = 15000;  // saved credentials at boot
const uint32_t TEST_CONNECT_TIMEOUT_MS = 15000;  // credentials submitted via the page
const uint32_t AP_LINGER_MS = 4000;              // keep the AP up after success so the page can see "ok"

// Hold the BOOT button (GPIO0) this long while running to forget the saved Wi-Fi
const uint8_t RESET_BUTTON_PIN = 0;
const uint32_t RESET_HOLD_MS = 3000;

HUB75_I2S_CFG::i2s_pins HUB75_PINS = {
  18, 17, 19,          // R1, G1, B1
  21, 23, 27,         // R2, G2, B2
  26, 16, 25, 4, -1, // A, B, C, D, E
  2,                // LAT
  32,              // OE
  33              // CLK
};

MatrixPanel_I2S_DMA* dma_display = nullptr;

// Survives a software restart; set to ask the next boot to start the setup portal
const uint32_t PORTAL_MAGIC = 0xA11CE5E7;
RTC_NOINIT_ATTR uint32_t portalRequest;

Preferences prefs;
WebServer server(80);
DNSServer dns;

enum PortalState { PORTAL_IDLE, PORTAL_CONNECTING, PORTAL_CONNECTED, PORTAL_FAILED };
bool portalActive = false;
PortalState portalState = PORTAL_IDLE;
String pendingSsid, pendingPass;
uint32_t connectStartedAt = 0;
uint32_t connectedAt = 0;

const char SETUP_PAGE[] PROGMEM = R"HTML(<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arrivals Wi-Fi setup</title>
<style>
body{font-family:sans-serif;max-width:22em;margin:2em auto;padding:0 1em}
input,button{width:100%;box-sizing:border-box;font-size:1em;padding:.6em;margin:.3em 0}
#msg{margin-top:1em;min-height:1.5em}
</style></head><body>
<h2>Wi-Fi setup</h2>
<form id="f">
<input name="ssid" placeholder="Network name" autocapitalize="none" autocorrect="off" required>
<input name="pass" type="password" placeholder="Password">
<button>Connect</button>
</form>
<div id="msg"></div>
<script>
const msg=document.getElementById('msg');
document.getElementById('f').onsubmit=async e=>{
  e.preventDefault();
  msg.textContent='Connecting...';
  try{await fetch('/save',{method:'POST',body:new URLSearchParams(new FormData(e.target))});}catch(_){}
  poll();
};
async function poll(){
  try{
    const s=(await (await fetch('/status')).text()).trim();
    if(s==='ok'){msg.textContent='Connected! The device is switching to your network.';return;}
    if(s==='failed'){msg.textContent='Could not connect. Check the name and password and try again.';return;}
  }catch(_){}
  setTimeout(poll,1500);
}
</script></body></html>)HTML";

static inline uint8_t hexNibble(char c) {
  return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10;
}

bool loadCredentials(String& ssid, String& pass) {
  prefs.begin("wifi", true);
  ssid = prefs.getString("ssid", "");
  pass = prefs.getString("pass", "");
  prefs.end();
  return ssid.length() > 0;
}

void saveCredentials(const String& ssid, const String& pass) {
  prefs.begin("wifi", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
}

void clearCredentials() {
  prefs.begin("wifi", false);
  prefs.clear();
  prefs.end();
}

void beginWifi(const String& ssid, const String& pass) {
  WiFi.begin(ssid.c_str(), pass.length() ? pass.c_str() : nullptr);
}

// Blocking connect, used at boot with saved credentials
bool connectBlocking(const String& ssid, const String& pass, uint32_t timeoutMs) {
  beginWifi(ssid, pass);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > timeoutMs) {
      WiFi.disconnect();
      return false;
    }
    checkResetButton();
    delay(30);
  }
  return true;
}

void showMessage(const char* text) {
  dma_display->clearScreen();
  dma_display->setTextColor(dma_display->color565(255, 255, 255));
  dma_display->setCursor(1, 8);
  dma_display->print(text);
}

// If BOOT has been held for RESET_HOLD_MS, forget the saved Wi-Fi and restart
// into the setup portal. Call this often.
void checkResetButton() {
  static uint32_t pressedAt = 0;

  if (digitalRead(RESET_BUTTON_PIN) != LOW) {
    pressedAt = 0;
    return;
  }
  if (pressedAt == 0) {
    pressedAt = millis();
    return;
  }
  if (millis() - pressedAt < RESET_HOLD_MS) return;

  clearCredentials();
  showMessage("RESET");
  // GPIO0 low at reset selects download mode, so wait for release before restarting
  while (digitalRead(RESET_BUTTON_PIN) == LOW) delay(10);
  ESP.restart();
}

// delay() that keeps watching the reset button
void delayWithResetCheck(uint32_t ms) {
  uint32_t start = millis();
  while (millis() - start < ms) {
    checkResetButton();
    delay(20);
  }
}

void handleSave() {
  String ssid = server.arg("ssid");
  if (ssid.length() == 0) {
    server.send(400, "text/plain", "ssid required");
    return;
  }
  pendingSsid = ssid;
  pendingPass = server.arg("pass");
  Serial.printf("[portal] trying ssid \"%s\" (%u chars), password %u chars\n",
                pendingSsid.c_str(), (unsigned)pendingSsid.length(), (unsigned)pendingPass.length());

  // The AP has to stay up (dual mode) while the station connection is tried.
  // Reply right away; the page polls /status for the result, because the AP
  // channel can change while the station joins the router.
  portalState = PORTAL_CONNECTING;
  connectStartedAt = millis();
  WiFi.disconnect();
  beginWifi(pendingSsid, pendingPass);
  server.send(200, "text/plain", "connecting");
}

void handleStatus() {
  const char* s = "idle";
  if (portalState == PORTAL_CONNECTING) s = "connecting";
  else if (portalState == PORTAL_CONNECTED) s = "ok";
  else if (portalState == PORTAL_FAILED) s = "failed";
  server.send(200, "text/plain", s);
}

// Radio half of the portal. Must run before the display is started: switching
// the Wi-Fi mode while the HUB75 DMA is running crashed the board (watchdog reset).
void startAccessPoint() {
  Serial.println("[portal] mode AP_STA");
  WiFi.mode(WIFI_AP_STA);
  Serial.println("[portal] softAP");
  WiFi.softAP(AP_SSID);
  dns.start(53, "*", WiFi.softAPIP());  // captive portal: every hostname resolves to us
  Serial.printf("[portal] AP \"%s\" up at %s\n", AP_SSID, WiFi.softAPIP().toString().c_str());
}

// Web server half of the portal; needs the display for the "SETUP" message
void startPortalServer() {
  portalActive = true;
  portalState = PORTAL_IDLE;

  server.on("/", HTTP_GET, []() { server.send_P(200, "text/html", SETUP_PAGE); });
  server.on("/save", HTTP_POST, handleSave);
  server.on("/status", HTTP_GET, handleStatus);
  server.onNotFound([]() {
    server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/");
    server.send(302, "text/plain", "");
  });
  server.begin();

  showMessage("SETUP");
  Serial.println("[portal] ready");
}

void portalLoop() {
  dns.processNextRequest();
  server.handleClient();

  if (portalState == PORTAL_CONNECTING) {
    if (WiFi.status() == WL_CONNECTED) {
      saveCredentials(pendingSsid, pendingPass);
      portalState = PORTAL_CONNECTED;
      connectedAt = millis();
    } else if (millis() - connectStartedAt > TEST_CONNECT_TIMEOUT_MS) {
      Serial.printf("[portal] connect timed out, wifi status %d\n", (int)WiFi.status());
      WiFi.disconnect();
      portalState = PORTAL_FAILED;
    }
  } else if (portalState == PORTAL_CONNECTED && millis() - connectedAt > AP_LINGER_MS) {
    // Credentials are saved; reboot so the board comes up in plain STA mode
    // (changing Wi-Fi mode at runtime while the display runs is what crashes)
    Serial.println("[portal] credentials saved, restarting");
    ESP.restart();
  }

  delay(2);
}

void setup() {

  Serial.begin(115200);
  Serial.println("\n[boot] start");
  // Log why the station side drops or fails to join (reason codes: see esp_wifi_types.h,
  // e.g. 2 auth expired, 15 4-way handshake timeout = wrong password, 201 no AP found)
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    Serial.printf("[wifi] station disconnected, reason %d\n", info.wifi_sta_disconnected.reason);
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
  WiFi.persistent(false);  // credentials live in Preferences, not the Wi-Fi driver's NVS

  // Decide the Wi-Fi mode now, before the display starts (see startAccessPoint)
  bool forcePortal = esp_reset_reason() == ESP_RST_SW && portalRequest == PORTAL_MAGIC;
  portalRequest = 0;
  String ssid, pass;
  bool haveCreds = loadCredentials(ssid, pass);
  Serial.printf("[boot] saved ssid: \"%s\"\n", haveCreds ? ssid.c_str() : "(none)");
  bool needPortal = forcePortal || !haveCreds;
  if (needPortal) {
    startAccessPoint();
  } else {
    WiFi.mode(WIFI_STA);
  }

  HUB75_I2S_CFG mxconfig(
    PANEL_RES_X,
    PANEL_RES_Y,
    PANEL_CHAIN,
    HUB75_PINS
  );

  dma_display = new MatrixPanel_I2S_DMA(mxconfig);

  if (!dma_display->begin()) {
    Serial.println("[boot] display begin() FAILED");
    while (1) delay(1000);
  }
  Serial.println("[boot] display ok");

  dma_display->setBrightness8(90);
  dma_display->setTextWrap(false);
  dma_display->setFont(&Org_01);

  if (needPortal) {
    startPortalServer();
    return;
  }

  if (connectBlocking(ssid, pass, BOOT_CONNECT_TIMEOUT_MS)) {
    Serial.printf("[boot] connected, ip %s\n", WiFi.localIP().toString().c_str());
    return;
  }

  // Saved network unreachable: reboot into the setup portal (the radio mode
  // can only be changed safely before the display starts)
  Serial.println("[boot] connect failed, restarting into setup portal");
  portalRequest = PORTAL_MAGIC;
  ESP.restart();
}

void loop() {
  if (portalActive) {
    portalLoop();
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delayWithResetCheck(500);
    return;
  }

  // Polls are far apart, so any kept-alive connection would be dead by the
  // next one. Use a fresh connection each time instead.
  HTTPClient http;
  http.begin(PIXELS_URL);
  http.setTimeout(HTTP_TIMEOUT_MS);

  bool ok = false;
  if (http.GET() == HTTP_CODE_OK) {
    String body = http.getString();
    if (body.length() >= PIXEL_COUNT * 6) {
      const char* p = body.c_str();
      for (int i = 0; i < PIXEL_COUNT; i++, p += 6) {
        uint8_t r = (hexNibble(p[0]) << 4) | hexNibble(p[1]);
        uint8_t g = (hexNibble(p[2]) << 4) | hexNibble(p[3]);
        uint8_t b = (hexNibble(p[4]) << 4) | hexNibble(p[5]);
        dma_display->drawPixelRGB888(i % PANEL_RES_X, i / PANEL_RES_X, r, g, b);
      }
      ok = true;
    }
  }
  http.end();

  // On failure retry soon instead of waiting a full poll interval
  delayWithResetCheck(ok ? POLL_INTERVAL_MS : RETRY_INTERVAL_MS);
}
