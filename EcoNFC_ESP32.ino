#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Adafruit_PN532.h>
#include <ArduinoJson.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <EEPROM.h>

// ========== NFC PINS ==========
#define SDA_PIN 21
#define SCL_PIN 22

// ========== SENSOR PINS ==========
#define MQ135_PIN 34
#define MQ7_PIN 35
#define MQ9_PIN 32
#define DHTPIN 33
#define DHTTYPE DHT22
#define CALIB_BUTTON_PIN 10
#define LED_PIN 18

// ========== EEPROM SETTINGS ==========
#define EEPROM_SIZE 1024
#define ADDR_RO_MQ135 0
#define ADDR_RO_MQ7 4
#define ADDR_RO_MQ9 8
#define ADDR_CALIB_FLAG 12
#define CALIB_MAGIC 0xAB

#define ADDR_CONFIG_FLAG 16
#define CONFIG_MAGIC 0xCD
#define ADDR_CONFIG_START 20
#define MAX_CONFIG_SIZE 1000

// ========== SENSOR CONSTANTS ==========
#define RL_VALUE 10.0
#define RO_CLEAN_AIR_FACTOR 9.83
#define CALIBRATION_SAMPLES 50

// Koefisien perhitungan - DIPERBAIKI untuk MQ135
#define MQ135_A 116.6020682
#define MQ135_B -2.769034857
#define MQ7_A 99.0418
#define MQ7_B -1.518
#define MQ9_A 1000.5
#define MQ9_B -2.186

// Minimum PPM threshold
#define MIN_PPM_THRESHOLD 0.1

Adafruit_PN532 nfc(SDA_PIN, SCL_PIN);
DHT dht(DHTPIN, DHTTYPE);

struct NFCConfig {
    String nfcId;
    String deviceName;
    String wifi;
    String wifiPassword;
    String serverUrl;
    int serverPort;
    String sensorType;
    int interval;
    String deviceStatus;
    String timestamp;
    String version;
    String protocol;
    String mqttTopic;
    String mqttUsername;
    String mqttPassword;
    String apiKey;
    String endpoint;
};

NFCConfig currentConfig;

float Ro_MQ135 = 10.0;
float Ro_MQ7 = 10.0;
float Ro_MQ9 = 10.0;

float lastValidTemp = 25.0;
float lastValidHumidity = 50.0;
int dhtErrorCount = 0;

String lastRawData = "";
String lastUID = "";
bool tagPresent = false;
bool wifiConnected = false;
bool configurationValid = false;
bool configLoadedFromEEPROM = false;

bool lastButtonState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;

WiFiClient wifiClient;
WiFiClientSecure secureClient;
PubSubClient mqttClient(wifiClient);

unsigned long lastCheckTime = 0;
unsigned long lastReleaseTime = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastSensorSend = 0;
unsigned long lastReconnectMQTT = 0;
unsigned long lastHeartbeat = 0;
unsigned long ledStartTime = 0;

const unsigned long CHECK_INTERVAL = 2000;
const unsigned long RELEASE_INTERVAL = 8000;
const unsigned long RELEASE_DURATION = 1500;
const unsigned long WIFI_CHECK_INTERVAL = 10000;
const unsigned long DEFAULT_SENSOR_INTERVAL = 5000;
const unsigned long WIFI_TIMEOUT = 20000;
const unsigned long MQTT_RECONNECT_INTERVAL = 5000;
const unsigned long HEARTBEAT_INTERVAL = 20000;
const unsigned long LED_DURATION = 1000;

bool ledActive = false;

// Debug flag untuk logging detail
bool debugMode = true;

// ============ EEPROM CONFIG FUNCTIONS ============

String configToJSON() {
    JsonDocument doc;
    
    doc["nfcId"] = currentConfig.nfcId;
    doc["deviceName"] = currentConfig.deviceName;
    doc["wifi"] = currentConfig.wifi;
    doc["wifiPassword"] = currentConfig.wifiPassword;
    doc["serverUrl"] = currentConfig.serverUrl;
    doc["serverPort"] = currentConfig.serverPort;
    doc["sensorType"] = currentConfig.sensorType;
    doc["interval"] = currentConfig.interval;
    doc["deviceStatus"] = currentConfig.deviceStatus;
    doc["timestamp"] = currentConfig.timestamp;
    doc["version"] = currentConfig.version;
    doc["protocol"] = currentConfig.protocol;
    doc["mqttTopic"] = currentConfig.mqttTopic;
    doc["mqttUsername"] = currentConfig.mqttUsername;
    doc["mqttPassword"] = currentConfig.mqttPassword;
    doc["apiKey"] = currentConfig.apiKey;
    doc["endpoint"] = currentConfig.endpoint;
    
    String jsonStr;
    serializeJson(doc, jsonStr);
    return jsonStr;
}

void saveConfigToEEPROM() {
    String configJSON = configToJSON();
    
    if (configJSON.length() > MAX_CONFIG_SIZE) {
        Serial.println("❌ Config terlalu besar untuk EEPROM!");
        return;
    }
    
    EEPROM.write(ADDR_CONFIG_FLAG, CONFIG_MAGIC);
    
    uint16_t len = configJSON.length();
    EEPROM.write(ADDR_CONFIG_START, len & 0xFF);
    EEPROM.write(ADDR_CONFIG_START + 1, (len >> 8) & 0xFF);
    
    for (uint16_t i = 0; i < len; i++) {
        EEPROM.write(ADDR_CONFIG_START + 2 + i, configJSON[i]);
    }
    
    EEPROM.commit();
    
    Serial.println("💾 Konfigurasi NFC disimpan ke EEPROM");
    Serial.println("📦 Size: " + String(len) + " bytes");
}

bool loadConfigFromEEPROM() {
    byte configFlag = EEPROM.read(ADDR_CONFIG_FLAG);
    
    if (configFlag != CONFIG_MAGIC) {
        Serial.println("ℹ️ Tidak ada konfigurasi tersimpan di EEPROM");
        return false;
    }
    
    uint16_t len = EEPROM.read(ADDR_CONFIG_START) | (EEPROM.read(ADDR_CONFIG_START + 1) << 8);
    
    if (len == 0 || len > MAX_CONFIG_SIZE) {
        Serial.println("❌ Ukuran konfigurasi tidak valid");
        return false;
    }
    
    String configJSON = "";
    for (uint16_t i = 0; i < len; i++) {
        configJSON += (char)EEPROM.read(ADDR_CONFIG_START + 2 + i);
    }
    
    Serial.println("\n📥 Loading config from EEPROM...");
    Serial.println("📦 Size: " + String(len) + " bytes");
    
    if (parseJSONConfig(configJSON.c_str())) {
        Serial.println("✅ Konfigurasi dimuat dari EEPROM");
        configLoadedFromEEPROM = true;
        return true;
    } else {
        Serial.println("❌ Gagal parse konfigurasi dari EEPROM");
        return false;
    }
}

void clearConfigFromEEPROM() {
    EEPROM.write(ADDR_CONFIG_FLAG, 0x00);
    EEPROM.commit();
    Serial.println("🗑️ Konfigurasi dihapus dari EEPROM");
    configurationValid = false;
    configLoadedFromEEPROM = false;
}

// ============ SENSOR GAS FUNCTIONS - DIPERBAIKI ============

float hitungRs(int adcValue) {
    if (adcValue == 0) return 999999.0;
    
    float voltage = (adcValue / 4095.0) * 3.3;
    float Rs = ((3.3 * RL_VALUE) / voltage) - RL_VALUE;
    
    if (Rs <= 0) Rs = 0.1;
    
    return Rs;
}

float hitungKonsentrasi(float Rs, float Ro, float a, float b, String sensorName) {
    if (Ro <= 0) {
        if (debugMode) {
            Serial.println("⚠️ " + sensorName + " Ro invalid: " + String(Ro, 3));
        }
        return -1;
    }
    
    float ratio = Rs / Ro;
    
    if (debugMode) {
        Serial.println("🔬 " + sensorName + " Debug:");
        Serial.println("   Rs = " + String(Rs, 3) + " kΩ");
        Serial.println("   Ro = " + String(Ro, 3) + " kΩ");
        Serial.println("   Ratio Rs/Ro = " + String(ratio, 3));
    }
    
    if (ratio <= 0) {
        if (debugMode) {
            Serial.println("   ❌ Ratio invalid");
        }
        return -1;
    }
    
    // Hitung PPM menggunakan power law
    float ppm = a * pow(ratio, b);
    
    if (debugMode) {
        Serial.println("   Formula: " + String(a, 2) + " * ratio^(" + String(b, 3) + ")");
        Serial.println("   PPM raw = " + String(ppm, 3));
    }
    
    // Jika ppm sangat kecil atau negatif (karena perhitungan floating point)
    if (ppm < MIN_PPM_THRESHOLD) {
        if (debugMode) {
            Serial.println("   ⚠️ PPM < threshold, set to " + String(MIN_PPM_THRESHOLD, 1));
        }
        ppm = MIN_PPM_THRESHOLD;
    }
    
    // Cap maksimum untuk menghindari nilai tidak masuk akal
    if (ppm > 10000) {
        if (debugMode) {
            Serial.println("   ⚠️ PPM too high, capped to 10000");
        }
        ppm = 10000;
    }
    
    return ppm;
}

float hitungAQI(float ppm_MQ135, float ppm_MQ7, float ppm_MQ9) {
    float aqi_MQ135 = ppm_MQ135 * 1.0;
    float aqi_MQ7 = ppm_MQ7 * 2.0;
    float aqi_MQ9 = ppm_MQ9 * 1.5;
    
    float aqi = (aqi_MQ135 * 0.4) + (aqi_MQ7 * 0.3) + (aqi_MQ9 * 0.3);
    
    return aqi > 500 ? 500 : aqi;
}

String getStatusUdara(float aqi) {
    if (aqi < 20) return "Baik";
    else if (aqi < 50) return "Sedang";
    else if (aqi < 100) return "Tidak Sehat";
    else if (aqi < 200) return "Sangat Tidak Sehat";
    else return "Berbahaya";
}

bool validasiADC(int adcValue, String sensorName) {
    if (adcValue > 4095) {
        Serial.println("⚠ Sensor " + sensorName + " nilai melebihi batas: " + String(adcValue));
        return false;
    }
    
    if (adcValue < 5) {
        Serial.println("ℹ Sensor " + sensorName + " ADC sangat rendah: " + String(adcValue));
    }
    
    return true;
}

// ============ DHT FUNCTIONS ============

bool bacaDHT(float &temp, float &humidity) {
    temp = dht.readTemperature();
    humidity = dht.readHumidity();
    
    if (isnan(temp) || isnan(humidity)) {
        return false;
    }
    
    if (temp < -40 || temp > 80 || humidity < 0 || humidity > 100) {
        return false;
    }
    
    return true;
}

// ============ CALIBRATION FUNCTIONS ============

void kalibrasiSensor() {
    Serial.println("\n========================================");
    Serial.println("       PROSES KALIBRASI SENSOR");
    Serial.println("========================================");
    Serial.println("⚠ Pastikan sensor berada di udara bersih!");
    Serial.println("⏳ Menunggu 3 detik...\n");
    delay(3000);
    
    float sum_MQ135 = 0, sum_MQ7 = 0, sum_MQ9 = 0;
    
    Serial.println("📊 Mengambil " + String(CALIBRATION_SAMPLES) + " sampel...");
    
    for (int i = 0; i < CALIBRATION_SAMPLES; i++) {
        int adc_MQ135 = analogRead(MQ135_PIN);
        int adc_MQ7 = analogRead(MQ7_PIN);
        int adc_MQ9 = analogRead(MQ9_PIN);
        
        float rs135 = hitungRs(adc_MQ135);
        float rs7 = hitungRs(adc_MQ7);
        float rs9 = hitungRs(adc_MQ9);
        
        sum_MQ135 += rs135;
        sum_MQ7 += rs7;
        sum_MQ9 += rs9;
        
        if ((i + 1) % 10 == 0) {
            Serial.print("   Sampel: ");
            Serial.print(i + 1);
            Serial.print("/");
            Serial.print(CALIBRATION_SAMPLES);
            Serial.print(" | Rs135=");
            Serial.print(rs135, 2);
            Serial.print(" Rs7=");
            Serial.print(rs7, 2);
            Serial.print(" Rs9=");
            Serial.println(rs9, 2);
        }
        
        delay(200);
    }
    
    Ro_MQ135 = (sum_MQ135 / CALIBRATION_SAMPLES) / RO_CLEAN_AIR_FACTOR;
    Ro_MQ7 = (sum_MQ7 / CALIBRATION_SAMPLES) / RO_CLEAN_AIR_FACTOR;
    Ro_MQ9 = (sum_MQ9 / CALIBRATION_SAMPLES) / RO_CLEAN_AIR_FACTOR;
    
    tulisEEPROM();
    
    Serial.println("\n✅ Kalibrasi selesai!");
    Serial.println("   Ro MQ135: " + String(Ro_MQ135, 3) + " kΩ");
    Serial.println("   Ro MQ7  : " + String(Ro_MQ7, 3) + " kΩ");
    Serial.println("   Ro MQ9  : " + String(Ro_MQ9, 3) + " kΩ");
    Serial.println("========================================\n");
    
    delay(2000);
}

void bacaEEPROM() {
    byte calibFlag = EEPROM.read(ADDR_CALIB_FLAG);
    
    if (calibFlag == CALIB_MAGIC) {
        EEPROM.get(ADDR_RO_MQ135, Ro_MQ135);
        EEPROM.get(ADDR_RO_MQ7, Ro_MQ7);
        EEPROM.get(ADDR_RO_MQ9, Ro_MQ9);
        
        Serial.println("✓ Kalibrasi dimuat dari EEPROM");
        Serial.println("   Ro MQ135: " + String(Ro_MQ135, 3) + " kΩ");
        Serial.println("   Ro MQ7  : " + String(Ro_MQ7, 3) + " kΩ");
        Serial.println("   Ro MQ9  : " + String(Ro_MQ9, 3) + " kΩ");
    } else {
        Serial.println("⚠ Belum ada data kalibrasi");
        Serial.println("  Menggunakan default Ro = 10.0 kΩ");
        Serial.println("  Tekan tombol untuk kalibrasi sensor");
    }
}

void tulisEEPROM() {
    EEPROM.put(ADDR_RO_MQ135, Ro_MQ135);
    EEPROM.put(ADDR_RO_MQ7, Ro_MQ7);
    EEPROM.put(ADDR_RO_MQ9, Ro_MQ9);
    EEPROM.write(ADDR_CALIB_FLAG, CALIB_MAGIC);
    EEPROM.commit();
    
    Serial.println("💾 Data kalibrasi disimpan ke EEPROM");
}

void cekTombolKalibrasi() {
    int reading = digitalRead(CALIB_BUTTON_PIN);
    
    if (reading != lastButtonState) {
        lastDebounceTime = millis();
    }
    
    if ((millis() - lastDebounceTime) > debounceDelay) {
        if (reading == LOW) {
            kalibrasiSensor();
        }
    }
    
    lastButtonState = reading;
}

// ============ SENSOR DATA FUNCTIONS ============

unsigned long getSensorInterval() {
    if (configurationValid && currentConfig.interval > 0) {
        return currentConfig.interval;
    }
    return DEFAULT_SENSOR_INTERVAL;
}

void readSensorData(float &temp, float &hum, float &aqi, 
                    float &ppm_135, float &ppm_7, float &ppm_9,
                    int &adc_135, int &adc_7, int &adc_9) {
    // Baca sensor gas
    adc_135 = analogRead(MQ135_PIN);
    adc_7 = analogRead(MQ7_PIN);
    adc_9 = analogRead(MQ9_PIN);
    
    // Validasi ADC
    if (!validasiADC(adc_135, "MQ135") || !validasiADC(adc_7, "MQ7") || !validasiADC(adc_9, "MQ9")) {
        aqi = -1;
        return;
    }
    
    Serial.println("\n🔬 === SENSOR CALCULATION DEBUG ===");
    Serial.println("📊 ADC Values:");
    Serial.println("   MQ135: " + String(adc_135));
    Serial.println("   MQ7: " + String(adc_7));
    Serial.println("   MQ9: " + String(adc_9));
    
    // Hitung Rs
    float Rs_MQ135 = hitungRs(adc_135);
    float Rs_MQ7 = hitungRs(adc_7);
    float Rs_MQ9 = hitungRs(adc_9);
    
    Serial.println("\n⚡ Rs Values:");
    Serial.println("   MQ135: " + String(Rs_MQ135, 3) + " kΩ");
    Serial.println("   MQ7: " + String(Rs_MQ7, 3) + " kΩ");
    Serial.println("   MQ9: " + String(Rs_MQ9, 3) + " kΩ");
    
    // Hitung konsentrasi gas (ppm)
    Serial.println("\n🧪 Calculating PPM:");
    ppm_135 = hitungKonsentrasi(Rs_MQ135, Ro_MQ135, MQ135_A, MQ135_B, "MQ135");
    ppm_7 = hitungKonsentrasi(Rs_MQ7, Ro_MQ7, MQ7_A, MQ7_B, "MQ7");
    ppm_9 = hitungKonsentrasi(Rs_MQ9, Ro_MQ9, MQ9_A, MQ9_B, "MQ9");
    
    Serial.println("\n✅ Final PPM Values:");
    Serial.println("   MQ135: " + String(ppm_135, 2) + " ppm");
    Serial.println("   MQ7: " + String(ppm_7, 2) + " ppm");
    Serial.println("   MQ9: " + String(ppm_9, 2) + " ppm");
    Serial.println("===================================\n");
    
    // Validasi konsentrasi
    if (ppm_135 < 0 || ppm_7 < 0 || ppm_9 < 0) {
        Serial.println("⚠️ Warning: Negative PPM detected, using minimum threshold");
        if (ppm_135 < 0) ppm_135 = MIN_PPM_THRESHOLD;
        if (ppm_7 < 0) ppm_7 = MIN_PPM_THRESHOLD;
        if (ppm_9 < 0) ppm_9 = MIN_PPM_THRESHOLD;
    }
    
    // Hitung AQI
    aqi = hitungAQI(ppm_135, ppm_7, ppm_9);
    
    // Baca DHT
    if (!bacaDHT(temp, hum)) {
        temp = lastValidTemp;
        hum = lastValidHumidity;
        dhtErrorCount++;
        
        if (dhtErrorCount > 3) {
            Serial.println("⚠ Sensor DHT error, menggunakan data terakhir");
        }
    } else {
        lastValidTemp = temp;
        lastValidHumidity = hum;
        dhtErrorCount = 0;
    }
}

String createSensorJSON(float temp, float hum, float aqi,
                       float ppm_135, float ppm_7, float ppm_9,
                       int adc_135, int adc_7, int adc_9) {
    JsonDocument jsonDoc;
    
    jsonDoc["temp"] = round(temp * 10) / 10.0;
    jsonDoc["humidity"] = round(hum * 10) / 10.0;
    jsonDoc["aqi"] = round(aqi * 10) / 10.0;
    jsonDoc["status"] = getStatusUdara(aqi);
    
    jsonDoc["ppm_MQ135"] = round(ppm_135 * 10) / 10.0;
    jsonDoc["ppm_MQ7"] = round(ppm_7 * 10) / 10.0;
    jsonDoc["ppm_MQ9"] = round(ppm_9 * 10) / 10.0;
    
    jsonDoc["adc_MQ135"] = adc_135;
    jsonDoc["adc_MQ7"] = adc_7;
    jsonDoc["adc_MQ9"] = adc_9;
    
    jsonDoc["ro_MQ135"] = round(Ro_MQ135 * 1000) / 1000.0;
    jsonDoc["ro_MQ7"] = round(Ro_MQ7 * 1000) / 1000.0;
    jsonDoc["ro_MQ9"] = round(Ro_MQ9 * 1000) / 1000.0;
    
    jsonDoc["deviceId"] = currentConfig.nfcId;
    jsonDoc["deviceName"] = currentConfig.deviceName;
    jsonDoc["sensorType"] = currentConfig.sensorType;
    jsonDoc["interval"] = currentConfig.interval;
    jsonDoc["protocol"] = currentConfig.protocol;
    jsonDoc["timestamp"] = millis() / 1000;
    jsonDoc["uptime"] = millis() / 1000;
    
    String json;
    serializeJson(jsonDoc, json);
    return json;
}

// ============ LED INDICATOR FUNCTIONS ============

void startLEDIndicator() {
    digitalWrite(LED_PIN, HIGH);
    ledActive = true;
    ledStartTime = millis();
    Serial.println("💡 LED ON - Persiapan kirim data...");
}

void stopLEDIndicator() {
    if (ledActive) {
        digitalWrite(LED_PIN, LOW);
        ledActive = false;
        Serial.println("💡 LED OFF");
    }
}

// ============ HTTP/HTTPS FUNCTIONS ============

bool sendDataViaHTTP(String jsonData, bool useHTTPS = false) {
    HTTPClient http;
    
    String fullUrl = currentConfig.serverUrl;
    
    if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
        fullUrl = String(useHTTPS ? "https://" : "http://") + fullUrl;
    }
    
    if (currentConfig.serverPort > 0) {
        if (fullUrl.indexOf("://") > 0) {
            int colonPos = fullUrl.lastIndexOf(":");
            int slashPos = fullUrl.indexOf("/", fullUrl.indexOf("://") + 3);
            
            if (colonPos < fullUrl.indexOf("://") || (slashPos > 0 && colonPos > slashPos)) {
                if (slashPos > 0) {
                    fullUrl = fullUrl.substring(0, slashPos) + ":" + String(currentConfig.serverPort) + fullUrl.substring(slashPos);
                } else {
                    fullUrl += ":" + String(currentConfig.serverPort);
                }
            }
        }
    }
    
    if (currentConfig.endpoint.length() > 0) {
        if (!fullUrl.endsWith("/") && !currentConfig.endpoint.startsWith("/")) {
            fullUrl += "/";
        }
        fullUrl += currentConfig.endpoint;
    } else {
        if (!fullUrl.endsWith("/")) fullUrl += "/";
        fullUrl += currentConfig.deviceName;
    }
    
    Serial.println("\n📡 Sending via " + String(useHTTPS ? "HTTPS" : "HTTP"));
    Serial.println("🔗 URL: " + fullUrl);
    
    bool success = false;
    
    if (useHTTPS) {
        secureClient.setInsecure();
        if (http.begin(secureClient, fullUrl)) {
            http.addHeader("Content-Type", "application/json");
            if (currentConfig.apiKey.length() > 0) {
                http.addHeader("Authorization", "Bearer " + currentConfig.apiKey);
            }
            http.setTimeout(10000);
            
            int httpResponseCode = http.POST(jsonData);
            
            if (httpResponseCode > 0) {
                Serial.println("✅ Response: " + String(httpResponseCode));
                Serial.println("📥 " + http.getString());
                success = true;
            } else {
                Serial.println("❌ Error: " + String(httpResponseCode));
            }
            http.end();
        }
    } else {
        if (http.begin(wifiClient, fullUrl)) {
            http.addHeader("Content-Type", "application/json");
            if (currentConfig.apiKey.length() > 0) {
                http.addHeader("Authorization", "Bearer " + currentConfig.apiKey);
            }
            http.setTimeout(10000);
            
            int httpResponseCode = http.POST(jsonData);
            
            if (httpResponseCode > 0) {
                Serial.println("✅ Response: " + String(httpResponseCode));
                Serial.println("📥 " + http.getString());
                success = true;
            } else {
                Serial.println("❌ Error: " + String(httpResponseCode));
            }
            http.end();
        }
    }
    
    return success;
}

// ============ MQTT FUNCTIONS ============

void mqttCallback(char* topic, byte* payload, unsigned int length) {
    Serial.print("📨 MQTT [");
    Serial.print(topic);
    Serial.print("]: ");
    
    String message = "";
    for (unsigned int i = 0; i < length; i++) {
        message += (char)payload[i];
    }
    Serial.println(message);
}

bool reconnectMQTT() {
    unsigned long now = millis();
    
    if (now - lastReconnectMQTT < MQTT_RECONNECT_INTERVAL) {
        return false;
    }
    lastReconnectMQTT = now;
    
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("❌ WiFi not connected for MQTT");
        return false;
    }
    
    if (mqttClient.connected()) {
        return true;
    }
    
    String broker = currentConfig.serverUrl;
    broker.replace("mqtt://", "");
    broker.replace("mqtts://", "");
    broker.replace("http://", "");
    broker.replace("https://", "");
    
    int colonPos = broker.indexOf(":");
    if (colonPos > 0) {
        broker = broker.substring(0, colonPos);
    }
    
    Serial.println("\n⚡ Connecting to MQTT...");
    Serial.println("🌐 Broker: " + broker + ":" + String(currentConfig.serverPort));
    
    mqttClient.setServer(broker.c_str(), currentConfig.serverPort);
    
    String clientId = "ESP32-AQI-" + currentConfig.nfcId + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    Serial.println("🆔 Client: " + clientId);
    
    String statusTopic = currentConfig.mqttTopic.length() > 0 ? 
                         currentConfig.mqttTopic + "/status" : 
                         "sensors/" + currentConfig.deviceName + "/status";
    
    String cmdTopic = currentConfig.mqttTopic.length() > 0 ? 
                      currentConfig.mqttTopic + "/cmd" : 
                      "sensors/" + currentConfig.deviceName + "/cmd";
    
    bool connected = false;
    
    if (currentConfig.mqttUsername.length() > 0 && currentConfig.mqttPassword.length() > 0) {
        Serial.println("👤 Auth: " + currentConfig.mqttUsername);
        connected = mqttClient.connect(
            clientId.c_str(),
            currentConfig.mqttUsername.c_str(),
            currentConfig.mqttPassword.c_str(),
            statusTopic.c_str(),
            1,
            true,
            "offline"
        );
    } else {
        Serial.println("🔓 No auth (Public broker)");
        connected = mqttClient.connect(
            clientId.c_str(),
            statusTopic.c_str(),
            1,
            true,
            "offline"
        );
    }
    
    if (connected) {
        Serial.println("✅ MQTT Connected!");
        
        mqttClient.publish(statusTopic.c_str(), "online", true);
        
        if (mqttClient.subscribe(cmdTopic.c_str())) {
            Serial.println("📬 Subscribed: " + cmdTopic);
        }
        
        JsonDocument doc;
        doc["device"] = currentConfig.deviceName;
        doc["id"] = currentConfig.nfcId;
        doc["sensor"] = "AQI Monitor (MQ135/MQ7/MQ9 + DHT22)";
        doc["interval"] = currentConfig.interval;
        doc["ip"] = WiFi.localIP().toString();
        
        char buffer[256];
        serializeJson(doc, buffer);
        
        String infoTopic = currentConfig.mqttTopic.length() > 0 ? 
                          currentConfig.mqttTopic + "/info" : 
                          "sensors/" + currentConfig.deviceName + "/info";
        
        mqttClient.publish(infoTopic.c_str(), buffer, true);
        
        return true;
    } else {
        int state = mqttClient.state();
        Serial.print("❌ Failed, rc=");
        Serial.print(state);
        Serial.print(" (");
        
        switch(state) {
            case -4: Serial.print("TIMEOUT"); break;
            case -3: Serial.print("CONNECTION_LOST"); break;
            case -2: Serial.print("CONNECT_FAILED"); break;
            case -1: Serial.print("DISCONNECTED"); break;
            case 1: Serial.print("BAD_PROTOCOL"); break;
            case 2: Serial.print("BAD_CLIENT_ID"); break;
            case 3: Serial.print("UNAVAILABLE"); break;
            case 4: Serial.print("BAD_CREDENTIALS"); break;
            case 5: Serial.print("UNAUTHORIZED"); break;
            default: Serial.print("UNKNOWN");
        }
        Serial.println(")");
        
        return false;
    }
}

bool sendDataViaMQTT(String jsonData) {
    if (!mqttClient.connected()) {
        Serial.println("⚠️ MQTT disconnected, reconnecting...");
        if (!reconnectMQTT()) {
            return false;
        }
    }
    
    String topic = currentConfig.mqttTopic.length() > 0 ? 
                   currentConfig.mqttTopic : 
                   "sensors/" + currentConfig.deviceName;
    
    Serial.println("\n📡 MQTT Publish");
    Serial.println("📬 Topic: " + topic);
    
    bool published = mqttClient.publish(topic.c_str(), jsonData.c_str(), true);
    
    if (published) {
        Serial.println("✅ Published");
        return true;
    } else {
        Serial.println("❌ Publish failed");
        return false;
    }
}

// ============ SERIAL OUTPUT ============

bool sendDataViaSerial(String jsonData) {
    Serial.println("\n📡 Serial Output");
    Serial.println("📦 " + jsonData);
    return true;
}

// ============ UNIFIED SEND FUNCTION ============

bool sendSensorData() {
    if (!wifiConnected && currentConfig.protocol != "SERIAL") {
        Serial.println("❌ WiFi not connected");
        return false;
    }
    
    startLEDIndicator();
    delay(LED_DURATION);
    
    float temp, hum, aqi;
    float ppm_135, ppm_7, ppm_9;
    int adc_135, adc_7, adc_9;
    
    readSensorData(temp, hum, aqi, ppm_135, ppm_7, ppm_9, adc_135, adc_7, adc_9);
    
    if (aqi < 0) {
        Serial.println("❌ Data sensor tidak valid, skip pengiriman");
        stopLEDIndicator();
        return false;
    }
    
    String jsonData = createSensorJSON(temp, hum, aqi, ppm_135, ppm_7, ppm_9, adc_135, adc_7, adc_9);
    
    Serial.println("\n📊 === AIR QUALITY DATA ===");
    Serial.println("🌡️ Temp: " + String(temp, 1) + "°C");
    Serial.println("💧 Humidity: " + String(hum, 1) + "%");
    Serial.println("🏭 AQI: " + String(aqi, 1) + " (" + getStatusUdara(aqi) + ")");
    Serial.println("📈 MQ135: " + String(ppm_135, 1) + " ppm (ADC:" + String(adc_135) + ")");
    Serial.println("☠️ MQ7: " + String(ppm_7, 1) + " ppm (ADC:" + String(adc_7) + ")");
    Serial.println("🔥 MQ9: " + String(ppm_9, 1) + " ppm (ADC:" + String(adc_9) + ")");
    Serial.println("📋 Protocol: " + currentConfig.protocol);
    
    bool success = false;
    String proto = currentConfig.protocol;
    proto.toUpperCase();
    
    if (proto == "HTTP") {
        success = sendDataViaHTTP(jsonData, false);
    } 
    else if (proto == "HTTPS") {
        success = sendDataViaHTTP(jsonData, true);
    }
    else if (proto == "MQTT" || proto == "MQTTS") {
        success = sendDataViaMQTT(jsonData);
    }
    else if (proto == "SERIAL") {
        success = sendDataViaSerial(jsonData);
    }
    else {
        Serial.println("⚠️ Unknown protocol: " + proto);
        Serial.println("💡 Valid: HTTP, HTTPS, MQTT, MQTTS, SERIAL");
    }
    
    stopLEDIndicator();
    
    if (success) {
        Serial.println("✅ Data sent via " + currentConfig.protocol);
    } else {
        Serial.println("❌ Failed via " + currentConfig.protocol);
    }
    
    return success;
}

// ============ MQTT HEARTBEAT ============

void publishHeartbeat() {
    if (!mqttClient.connected()) return;
    
    String statusTopic = currentConfig.mqttTopic.length() > 0 ? 
                         currentConfig.mqttTopic + "/status" : 
                         "sensors/" + currentConfig.deviceName + "/status";
    
    JsonDocument doc;
    doc["type"] = "heartbeat";
    doc["uptime"] = millis() / 1000;
    doc["rssi"] = WiFi.RSSI();
    doc["ip"] = WiFi.localIP().toString();
    doc["free_heap"] = ESP.getFreeHeap();
    doc["sensor_type"] = "AQI Monitor";
    doc["config_source"] = configLoadedFromEEPROM ? "EEPROM" : "NFC";
    
    char buffer[256];
    serializeJson(doc, buffer);
    
    if (mqttClient.publish(statusTopic.c_str(), buffer)) {
        Serial.println("💓 Heartbeat sent");
    }
}

// ============ NFC FUNCTIONS ============

bool parseJSONConfig(const char* jsonData) {
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, jsonData);

    if (error) {
        Serial.print(F("❌ JSON parse error: "));
        Serial.println(error.f_str());
        return false;
    }

    currentConfig.nfcId = doc["nfcId"] | "UNKNOWN";
    currentConfig.deviceName = doc["deviceName"] | "aqi-sensor";
    currentConfig.wifi = doc["wifi"] | "";
    currentConfig.wifiPassword = doc["wifiPassword"] | "";
    currentConfig.serverUrl = doc["serverUrl"] | "";
    currentConfig.serverPort = doc["serverPort"] | 0;
    currentConfig.sensorType = doc["sensorType"] | "AQI";
    currentConfig.interval = doc["interval"] | DEFAULT_SENSOR_INTERVAL;
    currentConfig.deviceStatus = doc["deviceStatus"] | "active";
    currentConfig.timestamp = doc["timestamp"] | "";
    currentConfig.version = doc["version"] | "1.0";
    currentConfig.protocol = doc["protocol"] | "HTTP";
    currentConfig.mqttTopic = doc["mqttTopic"] | "";
    currentConfig.mqttUsername = doc["mqttUsername"] | "";
    currentConfig.mqttPassword = doc["mqttPassword"] | "";
    currentConfig.apiKey = doc["apiKey"] | "";
    currentConfig.endpoint = doc["endpoint"] | "";

    if (currentConfig.protocol != "SERIAL") {
        if (currentConfig.wifi.length() == 0) {
            Serial.println("❌ WiFi SSID required for network protocols");
            return false;
        }
        if (currentConfig.serverUrl.length() == 0) {
            Serial.println("❌ Server URL required");
            return false;
        }
    }

    if (currentConfig.serverPort == 0) {
        if (currentConfig.protocol == "HTTP") currentConfig.serverPort = 80;
        else if (currentConfig.protocol == "HTTPS") currentConfig.serverPort = 443;
        else if (currentConfig.protocol == "MQTT") currentConfig.serverPort = 1883;
        else if (currentConfig.protocol == "MQTTS") currentConfig.serverPort = 8883;
    }

    Serial.println("\n=== 📋 CONFIG LOADED ===");
    Serial.println("🆔 ID: " + currentConfig.nfcId);
    Serial.println("📱 Device: " + currentConfig.deviceName);
    Serial.println("📡 WiFi: " + currentConfig.wifi);
    Serial.println("🌐 Server: " + currentConfig.serverUrl + ":" + String(currentConfig.serverPort));
    Serial.println("📊 Sensor: " + currentConfig.sensorType);
    Serial.println("⏱️ Interval: " + String(currentConfig.interval) + "ms");
    Serial.println("📡 Protocol: " + currentConfig.protocol);
    
    if (currentConfig.protocol == "MQTT" || currentConfig.protocol == "MQTTS") {
        Serial.println("📬 Topic: " + (currentConfig.mqttTopic.length() > 0 ? currentConfig.mqttTopic : "sensors/" + currentConfig.deviceName));
        if (currentConfig.mqttUsername.length() > 0) {
            Serial.println("👤 User: " + currentConfig.mqttUsername);
        } else {
            Serial.println("🔓 Public broker (no auth)");
        }
    }
    
    Serial.println("========================\n");

    return true;
}

String getUIDString(uint8_t uid[], uint8_t uidLength) {
    String uidStr = "";
    for (uint8_t i = 0; i < uidLength; i++) {
        if (uid[i] < 0x10) uidStr += "0";
        uidStr += String(uid[i], HEX);
        if (i < uidLength - 1) uidStr += ":";
    }
    uidStr.toUpperCase();
    return uidStr;
}

void releaseNFCField() {
    Serial.println("\n📱 RELEASE NFC FIELD");
    nfc.begin();
    delay(RELEASE_DURATION);
    nfc.SAMConfig();
    Serial.println("🔄 Field reactivated");
    lastReleaseTime = millis();
}

String readNTAGData() {
    String allData = "";
    uint8_t data[4];
    int consecutiveFailures = 0;
    int consecutiveZeros = 0;
    
    for (uint8_t page = 4; page < 231 && consecutiveFailures < 3; page++) {
        if (nfc.ntag2xx_ReadPage(page, data)) {
            consecutiveFailures = 0;
            
            bool allZero = true;
            for (int i = 0; i < 4; i++) {
                if (data[i] != 0x00) {
                    allZero = false;
                    break;
                }
            }
            
            if (allZero) {
                consecutiveZeros++;
                if (consecutiveZeros >= 3) break;
            } else {
                consecutiveZeros = 0;
                for (int i = 0; i < 4; i++) {
                    if (data[i] >= 0x20 && data[i] <= 0x7E) {
                        allData += (char)data[i];
                    } else if (data[i] == 0x00) {
                        break;
                    }
                }
            }
        } else {
            consecutiveFailures++;
        }
    }
    
    return allData;
}

String extractJSON(String rawData) {
    int jsonStart = rawData.indexOf('{');
    if (jsonStart == -1) return "";
    
    int braceCount = 0;
    int jsonEnd = -1;
    
    for (int i = jsonStart; i < rawData.length(); i++) {
        if (rawData[i] == '{') {
            braceCount++;
        } else if (rawData[i] == '}') {
            braceCount--;
            if (braceCount == 0) {
                jsonEnd = i;
                break;
            }
        }
    }
    
    if (jsonEnd > jsonStart) {
        return rawData.substring(jsonStart, jsonEnd + 1);
    }
    
    return "";
}

bool connectToWiFi() {
    if (currentConfig.wifi.length() == 0) {
        Serial.println("❌ No WiFi SSID");
        return false;
    }
    
    Serial.println("\n🔄 WiFi connecting...");
    Serial.println("📡 SSID: " + currentConfig.wifi);
    
    if (WiFi.status() == WL_CONNECTED) {
        WiFi.disconnect();
        delay(1000);
    }
    
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    
    if (currentConfig.wifiPassword.length() > 0) {
        WiFi.begin(currentConfig.wifi.c_str(), currentConfig.wifiPassword.c_str());
    } else {
        WiFi.begin(currentConfig.wifi.c_str());
    }
    
    unsigned long startTime = millis();
    int dots = 0;
    
    while (WiFi.status() != WL_CONNECTED && millis() - startTime < WIFI_TIMEOUT) {
        delay(500);
        Serial.print(".");
        dots++;
        if (dots % 10 == 0) Serial.println();
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\n✅ WiFi connected!");
        Serial.println("📶 IP: " + WiFi.localIP().toString());
        Serial.println("📡 RSSI: " + String(WiFi.RSSI()) + " dBm");
        wifiConnected = true;
        return true;
    } else {
        Serial.println("\n❌ WiFi failed!");
        wifiConnected = false;
        return false;
    }
}

void processNFCTag(String currentUID) {
    Serial.println("\n" + String('=', 50));
    Serial.println("🏷️ PROCESSING NFC TAG");
    Serial.println(String('=', 50));
    Serial.println("🆔 UID: " + currentUID);
    
    String rawData = readNTAGData();
    
    if (rawData.length() > 0) {
        Serial.println("📊 Data: " + String(rawData.length()) + " bytes");
        
        if (rawData != lastRawData) {
            Serial.println("🔄 New data!");
            lastRawData = rawData;
            
            String jsonData = extractJSON(rawData);
            
            if (jsonData.length() > 0) {
                Serial.println("🎉 JSON found!");
                Serial.println("📝 JSON: " + jsonData);
                
                if (parseJSONConfig(jsonData.c_str())) {
                    configurationValid = true;
                    configLoadedFromEEPROM = false;
                    
                    saveConfigToEEPROM();
                    
                    if (currentConfig.protocol != "SERIAL") {
                        if (connectToWiFi()) {
                            delay(1000);
                            
                            if (currentConfig.protocol == "MQTT" || currentConfig.protocol == "MQTTS") {
                                Serial.println("\n🔌 Initializing MQTT...");
                                reconnectMQTT();
                            }
                        }
                    } else {
                        Serial.println("📡 Serial mode - no WiFi needed");
                    }
                    
                    lastSensorSend = millis();
                } else {
                    Serial.println("❌ Config parse failed");
                    configurationValid = false;
                }
            } else {
                Serial.println("❌ No valid JSON found in NFC data");
                Serial.println("📄 Raw data: " + rawData);
                configurationValid = false;
            }
        } else {
            Serial.println("ℹ️ Same data as before");
        }
    } else {
        Serial.println("❌ No data read from NFC");
    }
}

// ============ SETUP ============

void setup() {
    Serial.begin(115200);
    while (!Serial) delay(10);
    
    Serial.println("\n🚀 ESP32 AQI Monitor NFC v3.2 (Fixed MQ135=0)");
    Serial.println("====================================");
    Serial.println("📊 Sensors:");
    Serial.println("   • MQ135 (Air Quality)");
    Serial.println("   • MQ7 (Carbon Monoxide)");
    Serial.println("   • MQ9 (CO & Flammable Gas)");
    Serial.println("   • DHT22 (Temp & Humidity)");
    Serial.println("✨ Protocols:");
    Serial.println("   • HTTP / HTTPS");
    Serial.println("   • MQTT / MQTTS");
    Serial.println("   • Serial Output");
    Serial.println("💾 Config Storage: EEPROM");
    Serial.println("💡 LED Indicator: Pin " + String(LED_PIN));
    Serial.println("🐛 Debug Mode: ENABLED");
    Serial.println("====================================");
    
    pinMode(LED_PIN, OUTPUT);
    pinMode(CALIB_BUTTON_PIN, INPUT_PULLUP);
    digitalWrite(LED_PIN, LOW);
    
    if (!EEPROM.begin(EEPROM_SIZE)) {
        Serial.println("ERROR: Gagal inisialisasi EEPROM!");
        while (1) {
            digitalWrite(LED_PIN, !digitalRead(LED_PIN));
            delay(200);
        }
    }
    
    dht.begin();
    Serial.println("✓ Sensor DHT22 initialized");
    
    bacaEEPROM();
    
    Serial.println("\n📥 Checking EEPROM for saved config...");
    if (loadConfigFromEEPROM()) {
        configurationValid = true;
        
        if (currentConfig.protocol != "SERIAL") {
            if (connectToWiFi()) {
                delay(1000);
                
                if (currentConfig.protocol == "MQTT" || currentConfig.protocol == "MQTTS") {
                    Serial.println("\n🔌 Initializing MQTT...");
                    reconnectMQTT();
                }
            }
        } else {
            Serial.println("📡 Serial mode - no WiFi needed");
        }
        
        Serial.println("\n✨ Device ready with saved config!");
        Serial.println("💡 Scan new NFC tag to update config");
    } else {
        Serial.println("⚠️ No saved config found");
        Serial.println("📱 Please scan NFC tag to configure device");
    }
    
    nfc.begin();
    
    uint32_t versiondata = nfc.getFirmwareVersion();
    if (!versiondata) {
        Serial.println("❌ PN532 not found!");
        while (1) {
            digitalWrite(LED_PIN, !digitalRead(LED_PIN));
            delay(500);
        }
    }
    
    Serial.print("✅ Found PN5");
    Serial.println((versiondata>>24) & 0xFF, HEX);
    
    nfc.SAMConfig();
    WiFi.mode(WIFI_STA);
    
    mqttClient.setCallback(mqttCallback);
    mqttClient.setBufferSize(512);
    mqttClient.setKeepAlive(60);
    mqttClient.setSocketTimeout(15);
    
    Serial.println("\n⏳ Warming up MQ sensors (10 seconds)...");
    for (int i = 10; i > 0; i--) {
        Serial.print("   Remaining: ");
        Serial.print(i);
        Serial.println(" seconds");
        
        digitalWrite(LED_PIN, i % 2);
        delay(1000);
    }
    digitalWrite(LED_PIN, LOW);
    Serial.println("✓ Sensors ready!");
    
    Serial.println("\n⏳ Ready!");
    if (!configurationValid) {
        Serial.println("📱 Place NFC tag to configure...");
    }
    Serial.println("💡 Commands: help, status, send, config, calib, clearconfig, debug");
    Serial.println("🔘 Press calibration button for sensor calibration\n");
    
    lastReleaseTime = millis();
    lastWifiCheck = millis();
    lastSensorSend = millis();
    lastHeartbeat = millis();
}

// ============ LOOP ============

void loop() {
    unsigned long currentTime = millis();
    
    cekTombolKalibrasi();
    
    if (currentTime - lastReleaseTime >= RELEASE_INTERVAL) {
        releaseNFCField();
        return;
    }
    
    if (configurationValid && currentConfig.protocol != "SERIAL" && 
        currentTime - lastWifiCheck >= WIFI_CHECK_INTERVAL) {
        if (WiFi.status() != WL_CONNECTED && wifiConnected) {
            Serial.println("\n⚠️ WiFi lost, reconnecting...");
            connectToWiFi();
            
            if (wifiConnected && (currentConfig.protocol == "MQTT" || currentConfig.protocol == "MQTTS")) {
                reconnectMQTT();
            }
        }
        lastWifiCheck = currentTime;
    }
    
    if (configurationValid && wifiConnected && 
        (currentConfig.protocol == "MQTT" || currentConfig.protocol == "MQTTS")) {
        if (!mqttClient.connected()) {
            reconnectMQTT();
        } else {
            mqttClient.loop();
        }
    }
    
    if (configurationValid && currentTime - lastSensorSend >= getSensorInterval()) {
        if (currentConfig.protocol == "SERIAL" || wifiConnected) {
            sendSensorData();
        }
        lastSensorSend = currentTime;
    }
    
    if (configurationValid && mqttClient.connected() && 
        currentTime - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        publishHeartbeat();
        lastHeartbeat = currentTime;
    }
    
    if (currentTime - lastCheckTime < CHECK_INTERVAL) {
        delay(10);
        return;
    }
    
    lastCheckTime = currentTime;
    
    uint8_t uid[] = { 0, 0, 0, 0, 0, 0, 0 };
    uint8_t uidLength;
    
    bool tagDetected = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 100);
    
    if (tagDetected) {
        String currentUID = getUIDString(uid, uidLength);
        
        if (!tagPresent) {
            Serial.println("\n🆕 NEW TAG!");
            tagPresent = true;
            lastUID = currentUID;
            processNFCTag(currentUID);
        } else if (currentUID != lastUID) {
            Serial.println("\n🔄 DIFFERENT TAG!");
            lastUID = currentUID;
            lastRawData = "";
            processNFCTag(currentUID);
        }
    } else {
        if (tagPresent) {
            Serial.println("\n❌ TAG REMOVED");
            tagPresent = false;
            lastUID = "";
        }
    }
    
    if (Serial.available()) {
        String cmd = Serial.readStringUntil('\n');
        cmd.trim();
        cmd.toLowerCase();
        
        if (cmd == "status") {
            Serial.println("\n📊 === SYSTEM STATUS ===");
            Serial.println("NFC Tag: " + String(tagPresent ? "PRESENT" : "ABSENT"));
            Serial.println("Config: " + String(configurationValid ? "VALID" : "INVALID"));
            Serial.println("Config Source: " + String(configLoadedFromEEPROM ? "EEPROM" : "NFC"));
            Serial.println("WiFi: " + String(wifiConnected ? "CONNECTED" : "DISCONNECTED"));
            Serial.println("Debug Mode: " + String(debugMode ? "ON" : "OFF"));
            
            if (wifiConnected) {
                Serial.println("IP: " + WiFi.localIP().toString());
                Serial.println("RSSI: " + String(WiFi.RSSI()) + " dBm");
            }
            
            if (configurationValid) {
                Serial.println("\n📡 Protocol: " + currentConfig.protocol);
                Serial.println("🌐 Server: " + currentConfig.serverUrl + ":" + String(currentConfig.serverPort));
                Serial.println("⏱️ Interval: " + String(currentConfig.interval) + "ms");
                
                if (currentConfig.protocol == "MQTT" || currentConfig.protocol == "MQTTS") {
                    Serial.println("📬 MQTT: " + String(mqttClient.connected() ? "CONNECTED ✅" : "DISCONNECTED ❌"));
                }
            }
            
            Serial.println("\n📊 Calibration:");
            Serial.println("Ro MQ135: " + String(Ro_MQ135, 3) + " kΩ");
            Serial.println("Ro MQ7: " + String(Ro_MQ7, 3) + " kΩ");
            Serial.println("Ro MQ9: " + String(Ro_MQ9, 3) + " kΩ");
            Serial.println("========================");
            
        } else if (cmd == "send") {
            if (configurationValid) {
                Serial.println("\n📤 Manual send test...");
                sendSensorData();
            } else {
                Serial.println("\n❌ No valid configuration");
            }
            
        } else if (cmd == "debug") {
            debugMode = !debugMode;
            Serial.println("\n🐛 Debug mode: " + String(debugMode ? "ENABLED" : "DISABLED"));
            
        } else if (cmd == "wifi") {
            if (configurationValid && currentConfig.protocol != "SERIAL") {
                Serial.println("\n🔄 Reconnecting WiFi...");
                connectToWiFi();
            } else {
                Serial.println("\n❌ No config or Serial mode");
            }
            
        } else if (cmd == "mqtt") {
            if (configurationValid && (currentConfig.protocol == "MQTT" || currentConfig.protocol == "MQTTS")) {
                Serial.println("\n🔄 Reconnecting MQTT...");
                if (wifiConnected) {
                    if (mqttClient.connected()) {
                        mqttClient.disconnect();
                        delay(1000);
                    }
                    reconnectMQTT();
                } else {
                    Serial.println("❌ WiFi not connected first");
                }
            } else {
                Serial.println("\n❌ Not using MQTT protocol");
            }
            
        } else if (cmd == "config") {
            if (configurationValid) {
                Serial.println("\n📋 === CONFIGURATION ===");
                Serial.println("📥 Source: " + String(configLoadedFromEEPROM ? "EEPROM" : "NFC Tag"));
                Serial.println("🆔 NFC ID: " + currentConfig.nfcId);
                Serial.println("📱 Device: " + currentConfig.deviceName);
                Serial.println("📡 WiFi: " + currentConfig.wifi);
                Serial.println("🌐 Server: " + currentConfig.serverUrl);
                Serial.println("🔌 Port: " + String(currentConfig.serverPort));
                Serial.println("📡 Protocol: " + currentConfig.protocol);
                Serial.println("📊 Sensor: " + currentConfig.sensorType);
                Serial.println("⏱️ Interval: " + String(currentConfig.interval) + "ms");
                Serial.println("========================");
            } else {
                Serial.println("\n❌ No valid configuration");
            }
            
        } else if (cmd == "calib") {
            Serial.println("\n🎛️ Starting manual calibration...");
            kalibrasiSensor();
            
        } else if (cmd == "clearconfig") {
            Serial.println("\n🗑️ Clearing saved configuration...");
            clearConfigFromEEPROM();
            Serial.println("✅ Config cleared. Please scan NFC tag to reconfigure.");
            
        } else if (cmd == "release") {
            Serial.println("\n🎛️ Manual NFC field release");
            releaseNFCField();
            
        } else if (cmd == "test") {
            Serial.println("\n🧪 === SENSOR TEST ===");
            float temp, hum, aqi;
            float ppm_135, ppm_7, ppm_9;
            int adc_135, adc_7, adc_9;
            
            readSensorData(temp, hum, aqi, ppm_135, ppm_7, ppm_9, adc_135, adc_7, adc_9);
            
            Serial.println("\n✅ FINAL RESULTS:");
            Serial.println("🌡️ Temperature: " + String(temp, 1) + "°C");
            Serial.println("💧 Humidity: " + String(hum, 1) + "%");
            Serial.println("🏭 AQI: " + String(aqi, 1) + " (" + getStatusUdara(aqi) + ")");
            Serial.println("\n📈 Gas Sensors:");
            Serial.println("MQ135: " + String(ppm_135, 2) + " ppm (ADC: " + String(adc_135) + ")");
            Serial.println("MQ7: " + String(ppm_7, 2) + " ppm (ADC: " + String(adc_7) + ")");
            Serial.println("MQ9: " + String(ppm_9, 2) + " ppm (ADC: " + String(adc_9) + ")");
            Serial.println("========================");
            
        } else if (cmd == "help") {
            Serial.println("\n📖 === COMMANDS ===");
            Serial.println("status      - System status");
            Serial.println("send        - Send test data");
            Serial.println("wifi        - Reconnect WiFi");
            Serial.println("mqtt        - Reconnect MQTT");
            Serial.println("config      - Show configuration");
            Serial.println("calib       - Calibrate sensors");
            Serial.println("clearconfig - Clear saved config");
            Serial.println("test        - Test sensor readings");
            Serial.println("debug       - Toggle debug mode");
            Serial.println("release     - Release NFC field");
            Serial.println("help        - Show this help");
            Serial.println("===================");
            
        } else if (cmd.length() > 0) {
            Serial.println("\n❓ Unknown: '" + cmd + "'");
            Serial.println("💡 Type 'help'");
        }
    }
}
