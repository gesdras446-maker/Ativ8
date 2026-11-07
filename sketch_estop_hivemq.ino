/*
 * ====================================================================
 * PROJETO ATIVIDADE 07: E-STOP (EMERGENCY STOP) COM HIVEMQ MQTT
 * Wokwi: https://wokwi.com/projects/478397334417475585
 * Autor original: Lucas Henrique | Adaptação: HiveMQ & Angra III
 * 
 * Hardware (Wokwi):
 * - ESP32 DevKit v4
 * - Potenciômetro no GPIO 34 (Sensor Analógico de RPM / Turbina)
 * - Módulo Relé / Motor no GPIO 26 (Atuador de Potência)
 * - Botão Físico E-Stop (Vermelho) no GPIO 25 (INPUT_PULLUP)
 * 
 * Broker MQTT:
 * - Host: broker.hivemq.com (Porta 1883 TCP)
 * - Tópicos:
 *   - Publicação de RPM: "angra3/turbina/rpm" e "angra3/telemetria"
 *   - Publicação de Log: "angra3/alertas"
 *   - Publicação de Status: "angra3/reator/status"
 *   - Subscrição de Comandos: "angra3/comandos/#" e "angra3/comandos/scram"
 * ====================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>

// ============================================================================
// CONFIGURAÇÃO WI-FI E BROKER HIVEMQ
// ============================================================================
const char* WIFI_SSID     = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";

// HiveMQ Broker Público Gratuito (TCP padrão porta 1883)
const char* MQTT_SERVER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;

// ============================================================================
// MAPEAMENTO DOS PINOS FÍSICOS
// ============================================================================
const int PIN_POTENCIOMETRO = 34; // Entrada analógica (Sensor de RPM da Turbina)
const int PIN_RELE         = 26; // Saída para Relé / Motor Principal
const int PIN_BOTAO_ESTOP  = 25; // Botão Vermelho de Emergência (INPUT_PULLUP)

// ============================================================================
// TÓPICOS MQTT PADRONIZADOS
// ============================================================================
const char* TOPIC_TELEMETRIA   = "angra3/telemetria";
const char* TOPIC_RPM          = "angra3/turbina/rpm";
const char* TOPIC_COMANDO_SUB  = "angra3/comandos/#";
const char* TOPIC_STATUS       = "angra3/reator/status";
const char* TOPIC_ALERTAS      = "angra3/alertas";

// ============================================================================
// VARIÁVEIS DE CONTROLE E ESTADO
// ============================================================================
WiFiClient espClient;
PubSubClient client(espClient);

bool motorLigado = true;
const int VALOR_LIMITE_RPM = 2800; // Limite de sobrevelocidade crítica
int rpmAtual = 0;

// Temporização não bloqueante com millis()
unsigned long ultimoEnvioRPM = 0;
const unsigned long INTERVALO_ENVIO_RPM = 1500; // Envia telemetria a cada 1.5s

// Tratamento de clique e debounce do botão físico
int estadoBotaoAnterior = HIGH;
unsigned long ultimoDebounce = 0;

// Protótipos
void setupWifi();
void reconnectMQTT();
void callback(char* topic, byte* payload, unsigned int length);
void desligarMotor(const char* motivo);
void ligarMotor();
void enviarTelemetriaCompleta(int rpm);

void setup() {
  Serial.begin(115200);
  delay(100);

  Serial.println("\n==================================================");
  Serial.println("  SISTEMA DE SEGURANCA E-STOP — ESP32 + HIVEMQ   ");
  Serial.println("==================================================");

  // Configuração dos pinos de hardware
  pinMode(PIN_RELE, OUTPUT);
  pinMode(PIN_BOTAO_ESTOP, INPUT_PULLUP);
  
  // Relé inicia LIGADO (Sistema operacional normal)
  digitalWrite(PIN_RELE, HIGH);

  estadoBotaoAnterior = digitalRead(PIN_BOTAO_ESTOP);

  // Conexão Wi-Fi
  setupWifi();

  // Configuração MQTT HiveMQ
  client.setServer(MQTT_SERVER, MQTT_PORT);
  client.setCallback(callback);
  client.setBufferSize(512); // Buffer amplo para JSON
}

void loop() {
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop();

  unsigned long tempoAtual = millis();

  // --------------------------------------------------------------------------
  // 1. LEITURA DO BOTÃO FÍSICO E-STOP (DETECÇÃO DE TRANSIÇÃO COM DEBOUNCE)
  // --------------------------------------------------------------------------
  int leituraBotao = digitalRead(PIN_BOTAO_ESTOP);

  if (leituraBotao == LOW && estadoBotaoAnterior == HIGH && (tempoAtual - ultimoDebounce > 200)) {
    ultimoDebounce = tempoAtual;
    Serial.println("\n[E-STOP FISICO] BOTAO VERMELHO PRESSIONADO!");
    desligarMotor("Emergencia: E-Stop Acionado Fisicamente no Painel");
  }
  estadoBotaoAnterior = leituraBotao;

  // --------------------------------------------------------------------------
  // 2. LEITURA DO POTENCIÔMETRO (RPM DA TURBINA) E ENVIO A CADA 1.5s
  // --------------------------------------------------------------------------
  if (tempoAtual - ultimoEnvioRPM >= INTERVALO_ENVIO_RPM) {
    ultimoEnvioRPM = tempoAtual;

    int valorAnalogico = analogRead(PIN_POTENCIOMETRO);
    
    // Se o motor estiver desligado (após E-Stop), o RPM cai para zero
    if (motorLigado) {
      rpmAtual = map(valorAnalogico, 0, 4095, 0, 3000);
    } else {
      rpmAtual = 0;
    }

    Serial.print("[SENSOR] RPM da Turbina: ");
    Serial.print(rpmAtual);
    Serial.print(" RPM | Motor Relé: ");
    Serial.println(motorLigado ? "LIGADO" : "DESLIGADO (E-STOP)");

    // Envia o RPM e telemetria formatada via MQTT
    enviarTelemetriaCompleta(rpmAtual);

    // Proteção de sobrevelocidade automática
    if (rpmAtual > VALOR_LIMITE_RPM && motorLigado) {
      desligarMotor("Emergencia: Limite de RPM Ultrapassado (> 2800 RPM)!");
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

  Serial.print("[MQTT] Conectando ao Broker HiveMQ (broker.hivemq.com)... ");
  String clientId = "ESP32_EStop_" + String(random(0xffff), HEX);

  if (client.connect(clientId.c_str())) {
    Serial.println("CONECTADO COM SUCESSO!");
    
    // Inscreve-se nos canais de comandos vindos da página web
    client.subscribe(TOPIC_COMANDO_SUB);
    
    // Publica status inicial
    client.publish(TOPIC_STATUS, motorLigado ? "ONLINE" : "SCRAM", true);
    client.publish(TOPIC_ALERTAS, "ESP32 E-Stop Online no HiveMQ");
  } else {
    Serial.print("Falha, rc=");
    Serial.print(client.state());
    Serial.println(" - Tentando novamente em 4s");
  }
}

// ============================================================================
// CALLBACK: RECEBE COMANDOS DA PÁGINA WEB VIA HIVEMQ
// ============================================================================
void callback(char* topic, byte* payload, unsigned int length) {
  String mensagem = "";
  for (unsigned int i = 0; i < length; i++) {
    mensagem += (char)payload[i];
  }
  mensagem.trim();

  Serial.print("[MQTT RX] Topico: ");
  Serial.print(topic);
  Serial.print(" | Mensagem: ");
  Serial.println(mensagem);

  String strTopic = String(topic);

  // 1. Comando SCRAM ou E-STOP vindo do botão da página web
  if (strTopic.endsWith("/scram") || strTopic.endsWith("/estop") || strTopic.endsWith("estop-comando")) {
    if (mensagem == "1" || mensagem.equalsIgnoreCase("scram") || mensagem.equalsIgnoreCase("off")) {
      desligarMotor("E-Stop / SCRAM Acionado Remotamente pela Pagina Web");
    } else if (mensagem == "0" || mensagem.equalsIgnoreCase("reset") || mensagem.equalsIgnoreCase("on")) {
      ligarMotor();
    }
  }
  // 2. Comando Reset
  else if (strTopic.endsWith("/reset")) {
    ligarMotor();
  }
}

// ============================================================================
// FUNÇÃO DE DESLIGAMENTO DO MOTOR / RELÉ (E-STOP)
// ============================================================================
void desligarMotor(const char* motivo) {
  if (motorLigado) {
    motorLigado = false;
    digitalWrite(PIN_RELE, LOW); // Corta a alimentação do motor (Relé DESLIGADO)
    
    Serial.println("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    Serial.print("  [ALERTA CRITICO] ");
    Serial.println(motivo);
    Serial.println("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

    if (client.connected()) {
      client.publish(TOPIC_STATUS, "SCRAM", true);
      client.publish(TOPIC_ALERTAS, motivo, true);
      client.publish("angra3/reator/scram", "1");
    }
  }
}

// ============================================================================
// FUNÇÃO DE LIGAMENTO DO MOTOR / RELÉ (RESET)
// ============================================================================
void ligarMotor() {
  motorLigado = true;
  digitalWrite(PIN_RELE, HIGH); // Reativa o Relé
  Serial.println("[SISTEMA] Motor rearmado com sucesso.");

  if (client.connected()) {
    client.publish(TOPIC_STATUS, "ONLINE", true);
    client.publish(TOPIC_ALERTAS, "Motor do Sistema E-Stop Rearmado.");
  }
}

// ============================================================================
// ENVIO DE TELEMETRIA COMPLETA PARA A PÁGINA WEB
// ============================================================================
void enviarTelemetriaCompleta(int rpm) {
  if (!client.connected()) return;

  // Calcula valores derivados proporcionais ao RPM
  float potenciaCalc = motorLigado ? map(rpm, 0, 3000, 0, 1510) : 0;
  float tempCalc     = motorLigado ? (300.0 + (rpm / 100.0)) : 80.0;
  float pressaoCalc  = motorLigado ? (140.0 + (rpm / 200.0)) : 40.0;
  float radCalc      = motorLigado ? 0.12 : 0.05;

  // 1. Tópico direto de RPM
  client.publish(TOPIC_RPM, String(rpm).c_str());

  // 2. Tópico JSON unificado consumido pelo Chart.js e Cards no app.js
  char jsonBuffer[256];
  snprintf(jsonBuffer, sizeof(jsonBuffer),
    "{\"turbina\":%d,\"potencia\":%.0f,\"temperatura\":%.1f,\"pressao\":%.1f,\"radiacao\":%.2f,\"motor\":%d}",
    rpm,
    potenciaCalc,
    tempCalc,
    pressaoCalc,
    radCalc,
    motorLigado ? 1 : 0
  );

  client.publish(TOPIC_TELEMETRIA, jsonBuffer);
}

