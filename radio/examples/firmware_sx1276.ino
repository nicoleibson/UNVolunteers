// Project Lifeline Core — Etapa 0
// Firmware mínimo de referencia para transceptor LoRa SX1276/SX1262.
// Objetivo: que la GUI (radio_driver.js vía Web Serial) controle el radio.
// Placa típica: ESP32 + módulo LoRa (T-Beam, Heltec, TTGO LoRa32...).
// Librería: https://github.com/sandeepmistry/arduino-LoRa
//
// Protocolo (líneas \n, 115200 baud, host -> radio):
//   RESET                  RESET CONFIG {"freq":915000000,"sf":12,"bw":125000,"txPower":20}
//   TX <hex>               RX ON / RX OFF
// Eventos (radio -> host):
//   OK / ERROR <code>
//   EVT READY {"radio":"SX1276","freq":<f>}
//   EVT RX <hex> <rssi> <snr>
//
// ADVERTENCIA: ajusta la frecuencia (433/868/915) a la normativa local y a tu
// hardware. En 868/915 necesitas las constantes de la librería LoRa_868/915.

#include <LoRa.h>

static String radioName = "SX1276";
static long freq = 915000000L;
static int sf = 12;
static long bw = 125000L;
static int txPower = 20;
static String rxBuf = "";

static void sendEvent(const char* kind, const String& extra) {
  Serial.print("EVT "); Serial.print(kind);
  if (extra.length()) { Serial.print(" "); Serial.print(extra); }
  Serial.println();
}

static void applyConfig() {
  LoRa.setSpreadingFactor(sf);
  LoRa.setSignalBandwidth(bw);
  LoRa.setTxPower(txPower);
  LoRa.setFrequency(freq);
}

static void radioReset() {
  LoRa.end();
  delay(100);
  if (!LoRa.begin(freq)) {
    Serial.println("ERROR RADIO_NO_INIT");
    return;
  }
  applyConfig();
  String ready = String("{\"radio\":\"") + radioName + "\",\"freq\":" + freq + "}";
  sendEvent("READY", ready);
  Serial.println("OK");
}

static String hexOfBytes(byte* b, int n) {
  String s = "";
  static const char* h = "0123456789abcdef";
  for (int i = 0; i < n; i++) {
    s += h[(b[i] >> 4) & 0xF];
    s += h[b[i] & 0xF];
  }
  return s;
}

static void transmitHex(const String& hex) {
  int n = hex.length() / 2;
  if (hex.length() % 2 || n == 0) { Serial.println("ERROR TX_HEX_INVALIDO"); return; }
  byte buf[128];
  for (int i = 0; i < n && i < 128; i++) {
    char c = hex[2 * i];
    buf[i] = (byte)strtol(hex.substring(2 * i, 2 * i + 2).c_str(), NULL, 16);
  }
  LoRa.beginPacket();
  LoRa.write(buf, n);
  LoRa.endPacket();
  Serial.println("OK");
}

static void onReceive(int packetSize) {
  if (packetSize <= 0 || packetSize > 128) return;
  byte buf[128];
  for (int i = 0; i < packetSize; i++) buf[i] = (byte)LoRa.read();
  String line = String("EVT RX ") + hexOfBytes(buf, packetSize) + " "
              + LoRa.packetRssi() + " " + LoRa.packetSnr();
  Serial.println(line);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  radioReset();
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      String line = rxBuf; rxBuf = "";
      line.trim();
      if (line == "RESET") { radioReset(); }
      else if (line.startsWith("CONFIG ")) {
        // parseo mínimo: {"freq":...,"sf":...,"bw":...,"txPower":...}
        int i = line.indexOf("freq"); int f = 0;
        if (i >= 0) f = atol(line.substring(line.indexOf(':', i) + 1).c_str());
        if (f > 0) freq = f;
        int j = line.indexOf("sf"); if (j >= 0) sf = atoi(line.substring(line.indexOf(':', j) + 1).c_str());
        int k = line.indexOf("bw"); if (k >= 0) bw = atol(line.substring(line.indexOf(':', k) + 1).c_str());
        int p = line.indexOf("txPower"); if (p >= 0) txPower = atoi(line.substring(line.indexOf(':', p) + 1).c_str());
        applyConfig();
        Serial.println("OK");
      }
      else if (line.startsWith("TX ")) { transmitHex(line.substring(3)); }
      else if (line == "RX ON")  { LoRa.onReceive(onReceive); LoRa.receive(); Serial.println("OK"); }
      else if (line == "RX OFF") { LoRa.idle(); Serial.println("OK"); }
      else { Serial.println("ERROR COMANDO_DESCONOCIDO"); }
    }
    else rxBuf += c;
  }
}
