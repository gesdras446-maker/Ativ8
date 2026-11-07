/*
 * ====================================================================
 * USINA NUCLEAR ANGRA III — ESP32 IOT GATEWAY UNIFICADO (ATIVIDADES 07 & 08)
 * Integração: E-Stop (Parada de Emergência) + Fechadura Inteligente (Trava IoT)
 * 
 * Hardware Combinado (Sem Conflito de Pinos):
 * [PARTE 1: E-STOP]
 * - GPIO 34: Potenciômetro Analógico (Sensor de RPM da Turbina 0-3000 RPM)
 * - GPIO 26: Módulo Relé / Motor Principal (Atuador de Força)
 * - GPIO 25: Botão Físico Vermelho (E-Stop / Parada de Emergência)
 * 
 * [PARTE 2: FECHADURA / TRAVA DE CONTENÇÃO]
 * - GPIO 13: Sinal PWM do Servo Motor (0° Travado / 90° Destravado)
 * - GPIO 12: Botão Físico Verde (Abertura Local da Trava)
 * - GPIO 14: LED Verde (Indicação de Normal / Destravado)
 * - GPIO 27: LED Vermelho (Indicação de Alerta / Travado)
 * 
 * Broker MQTT:
 * - Host: broker.hivemq.com (Porta 1883 TCP)
 * ====================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ESP32Servo.h>

// --- Credenciais Wi-Fi e Broker HiveMQ ---
const char* WIFI_SSID     = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";
const char* MQTT_SERVER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;

// --- Mapeamento de Pinos Físicos ---
// E-Stop:
const int PIN_POTENCIOMETRO = 34; // RPM Turbina
const int PIN_RELE         = 26; // Relé / Motor
const int PIN_BOTAO_ESTOP  = 25; // Botão Vermelho E-Stop

// Smart Lock:
const int PIN_SERVO        = 13; // Servo da Trava
const int PIN_BOTAO_LOCK   = 12; // Botão Verde Local
const int PIN_LED_VERDE    = 14; // LED Verde
const int PIN_LED_VERMELHO = 27; // LED Vermelho

// --- Tópicos MQTT ---
const char* TOPIC_TELEMETRIA   = "angra3/telemetria";
const char* TOPIC_RPM          = "angra3/turbina/rpm";
const char* TOPIC_TRAVA_STATUS = "angra3/fechadura/status";
const char* TOPIC_REATOR_STATUS= "angra3/reator/status";
const char* TOPIC_ALERTAS      = "angra3/alertas";
const char* TOPIC_COMANDOS_SUB = "angra3/comandos/#";

// --- Objetos e Variáveis de Controle ---
WiFiClient espClient;
PubSubClient client(espClient);
Servo servoTrava;

bool motorLigado      = true;  // Relé
bool portaDestravada  = false; // Trava
bool modoScram        = false; // Modo de Emergência Geral

const int LIMITE_RPM_SOBREVELOCIDADE = 2800;
int rpmAtual = 0;

unsigned long tempoAberturaTrava = 0;
const unsigned long TEMPO_TRAVA_ABERTA = 5000; // 5 segundos

unsigned long ultimoEnvioTelemetria = 0;
const unsigned long INTERVALO_TELEMETRIA = 1500; // 1.5s

int estadoEstopAnterior = HIGH;
int estadoLockAnterior  = HIGH;
unsigned long ultimoDebounce = 0;

// Protótipos
void setupWifi();
void reconnectMQTT();
void callback(char* topic, byte* payload, unsigned int length);
void acionarDestravamento(const char* origem);
void travarContencao();
void executarScram(const char* motivo);
void rearmarSistema();
void publicarTelemetria();

void setup() {
  Serial.begin(115200);
  delay(100);

  Serial.println("\n=======================================================");
  Serial.println("  ANGRA III — SISTEMA IOT ESP32 UNIFICADO (HIVEMQ)    ");
  Serial.println("=======================================================");

  // 1. Configuração dos Pinos do E-Stop
  pinMode(PIN_RELE, OUTPUT);
  pinMode(PIN_BOTAO_ESTOP, INPUT_PULLUP);
  digitalWrite(PIN_RELE, HIGH); // Inicia motor LIGADO

  // 2. Configuração dos Pinos da Trava
  pinMode(PIN_BOTAO_LOCK, INPUT_PULLUP);
  pinMode(PIN_LED_VERDE, OUTPUT);
  pinMode(PIN_LED_VERMELHO, OUTPUT);
  digitalWrite(PIN_LED_VERMELHO, HIGH); // Inicia TRAVADO
  digitalWrite(PIN_LED_VERDE, LOW);

  // 3. Inicialização do Servo
  ESP32PWM::allocateTimer(0);
  servoTrava.setPeriodHertz(50);
  servoTrava.attach(PIN_SERVO, 500, 2400);
  servoTrava.write(0); // 0 graus = Travado

  estadoEstopAnterior = digitalRead(PIN_BOTAO_ESTOP);
  estadoLockAnterior  = digitalRead(PIN_BOTAO_LOCK);

  // 4. Rede
  setupWifi();
  client.setServer(MQTT_SERVER, MQTT_PORT);
  client.setCallback(callback);
  client.setBufferSize(512);
}

void loop() {
  if (!client.connected()) reconnectMQTT();
  client.loop();

  unsigned long agora = millis();

  // --------------------------------------------------------------------------
  // 1. LEITURA DO BOTÃO VERMELHO (E-STOP / SCRAM LOCAL)
  // --------------------------------------------------------------------------
  int leituraEstop = digitalRead(PIN_BOTAO_ESTOP);
  if (leituraEstop == LOW && estadoEstopAnterior == HIGH && (agora - ultimoDebounce > 200)) {
    ultimoDebounce = agora;
    Serial.println("\n[LOCAL] BOTAO VERMELHO E-STOP ACIONADO!");
    executarScram("Botao Fisico E-Stop Acionado no Painel");
  }
  estadoEstopAnterior = leituraEstop;

  // --------------------------------------------------------------------------
  // 2. LEITURA DO BOTÃO VERDE (LIBERAÇÃO LOCAL DA TRAVA)
  // --------------------------------------------------------------------------
  int leituraLock = digitalRead(PIN_BOTAO_LOCK);
  if (leituraLock == LOW && estadoLockAnterior == HIGH && (agora - ultimoDebounce > 200)) {
    ultimoDebounce = agora;
    if (!modoScram) {
      Serial.println("\n[LOCAL] BOTAO VERDE DA TRAVA ACIONADO!");
      acionarDestravamento("Botao Fisico Local");
    } else {
      Serial.println("\n[AVISO] Trava bloqueada devido a SCRAM ativo!");
    }
  }
  estadoLockAnterior = leituraLock;

  // --------------------------------------------------------------------------
  // 3. TEMPORIZADOR DE FECHAMENTO AUTOMÁTICO DA TRAVA (5 SEGUNDOS)
  // --------------------------------------------------------------------------
  if (portaDestravada && !modoScram && (agora - tempoAberturaTrava >= TEMPO_TRAVA_ABERTA)) {
    Serial.println("[TIMER] 5s esgotados -> Re-travando contencao...");
    travarContencao();
  }

  // Piscar LED vermelho caso SCRAM esteja ativo
  if (modoScram) {
    digitalWrite(PIN_LED_VERMELHO, (agora / 300) % 2);
  }

  // --------------------------------------------------------------------------
  // 4. LEITURA ANALÓGICA DO RPM (POTENCIÔMETRO) & ENVIO PERIÓDICO (1.5s)
  // --------------------------------------------------------------------------
  if (agora - ultimoEnvioTelemetria >= INTERVALO_TELEMETRIA) {
    ultimoEnvioTelemetria = agora;

    int valorPot = analogRead(PIN_POTENCIOMETRO);
    rpmAtual = motorLigado ? map(valorPot, 0, 4095, 0, 3000) : 0;

    publicarTelemetria();

    // Verificação de sobrevelocidade da turbina
    if (rpmAtual > LIMITE_RPM_SOBREVELOCIDADE && motorLigado) {
      executarScram("Sobrevelocidade Critica da Turbina (> 2800 RPM)!");
    }
  }
}

// ============================================================================
// CONEXÃO WI-FI
// ============================================================================
void setupWifi() {
  Serial.print("[WIFI] Conectando a ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int tentativas = 0;
  while (WiFi.status() != WL_CONNECTED && tentativas < 20) {
    delay(500);
    Serial.print(".");
    tentativas++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Conectado!");
    Serial.print("[WIFI] IP: ");
    Serial.println(WiFi.localIP());
  }
}

// ============================================================================
// RECONEXÃO AO BROKER HIVEMQ
// ============================================================================
void reconnectMQTT() {
  static unsigned long ultimaTentativa = 0;
  if (millis() - ultimaTentativa < 4000) return;
  ultimaTentativa = millis();

  Serial.print("[MQTT] Conectando ao HiveMQ (broker.hivemq.com)... ");
  String clientId = "ESP32_Angra3_Unified_" + String(random(0xffff), HEX);

  if (client.connect(clientId.c_str())) {
    Serial.println("CONECTADO COM SUCESSO!");
    client.subscribe(TOPIC_COMANDOS_SUB);
    client.publish(TOPIC_REATOR_STATUS, modoScram ? "SCRAM" : "ONLINE", true);
    client.publish(TOPIC_TRAVA_STATUS, portaDestravada ? "1" : "0", true);
  } else {
    Serial.print("Falha, rc=");
    Serial.println(client.state());
  }
}

// ============================================================================
// CALLBACK: RECEBE COMANDOS DA PÁGINA WEB VIA HIVEMQ
// ============================================================================
void callback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  msg.trim();

  String strTopic = String(topic);
  Serial.print("[MQTT RX] Topico: ");
  Serial.print(topic);
  Serial.print(" | Mensagem: ");
  Serial.println(msg);

  // 1. Comando da Fechadura / Trava
  if (strTopic.endsWith("/fechadura")) {
    if (msg == "1" && !modoScram) {
      acionarDestravamento("Comando Web Nuvem");
    } else if (msg == "0") {
      travarContencao();
    }
  }
  // 2. Comando SCRAM / E-Stop
  else if (strTopic.endsWith("/scram") || strTopic.endsWith("/estop")) {
    if (msg == "1" || msg.equalsIgnoreCase("scram")) {
      executarScram("SCRAM Executado Remotamente via Web");
    } else if (msg == "0" || msg.equalsIgnoreCase("reset")) {
      rearmarSistema();
    }
  }
  // 3. Reset
  else if (strTopic.endsWith("/reset")) {
    rearmarSistema();
  }
}

// ============================================================================
// ATUAÇÃO DE CONTROLE
// ============================================================================
void acionarDestravamento(const char* origem) {
  servoTrava.write(90); // Gira o servo para 90° (aberto)
  digitalWrite(PIN_LED_VERMELHO, LOW);
  digitalWrite(PIN_LED_VERDE, HIGH);

  portaDestravada = true;
  tempoAberturaTrava = millis();

  Serial.printf("[TRAVA] Destravada por: %s\n", origem);

  if (client.connected()) {
    client.publish(TOPIC_TRAVA_STATUS, "1");
    client.publish(TOPIC_ALERTAS, "Trava de Contencao Destravada");
  }
}

void travarContencao() {
  servoTrava.write(0); // Retorna a 0° (fechado)
  digitalWrite(PIN_LED_VERMELHO, HIGH);
  digitalWrite(PIN_LED_VERDE, LOW);

  portaDestravada = false;
  Serial.println("[TRAVA] Travada com sucesso.");

  if (client.connected()) {
    client.publish(TOPIC_TRAVA_STATUS, "0");
  }
}

void executarScram(const char* motivo) {
  modoScram = true;
  motorLigado = false;
  portaDestravada = false;

  digitalWrite(PIN_RELE, LOW); // Abre relé (desliga motor)
  servoTrava.write(0);         // Trava contencao imediatamente
  digitalWrite(PIN_LED_VERDE, LOW);
  digitalWrite(PIN_LED_VERMELHO, HIGH);

  Serial.println("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  Serial.printf("  [SCRAM ATIVADO] %s\n", motivo);
  Serial.println("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

  if (client.connected()) {
    client.publish(TOPIC_REATOR_STATUS, "SCRAM", true);
    client.publish(TOPIC_TRAVA_STATUS, "0", true);
    client.publish(TOPIC_ALERTAS, motivo, true);
  }
}

void rearmarSistema() {
  modoScram = false;
  motorLigado = true;
  digitalWrite(PIN_RELE, HIGH);
  travarContencao();

  Serial.println("[SISTEMA] Modo normal restaurado com sucesso.");

  if (client.connected()) {
    client.publish(TOPIC_REATOR_STATUS, "ONLINE", true);
    client.publish(TOPIC_ALERTAS, "Sistema Rearmado e Operacional.");
  }
}

void publicarTelemetria() {
  if (!client.connected()) return;

  float potencia = motorLigado ? map(rpmAtual, 0, 3000, 0, 1510) : 0;
  float temp     = motorLigado ? (310.0 + (rpmAtual / 150.0)) : 80.0;
  float pressao  = motorLigado ? (145.0 + (rpmAtual / 250.0)) : 40.0;
  float radiacao = motorLigado ? 0.12 : 0.05;

  // 1. Tópico individual de RPM da turbina
  client.publish(TOPIC_RPM, String(rpmAtual).c_str());

  // 2. Payload JSON consumido pelo Chart.js e painel Web
  char jsonBuffer[256];
  snprintf(jsonBuffer, sizeof(jsonBuffer),
    "{\"turbina\":%d,\"potencia\":%.0f,\"temperatura\":%.1f,\"pressao\":%.1f,\"radiacao\":%.2f,\"trava\":%d,\"motor\":%d}",
    rpmAtual,
    potencia,
    temp,
    pressao,
    radiacao,
    portaDestravada ? 1 : 0,
    motorLigado ? 1 : 0
  );

  client.publish(TOPIC_TELEMETRIA, jsonBuffer);
}

