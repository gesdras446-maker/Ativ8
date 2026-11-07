/*
 * ====================================================================
 * USINA NUCLEAR ANGRA III — SISTEMA IOT COM HIVEMQ (ATIVIDADE 07 & 08)
 * Microcontrolador: ESP32 DevKit v4 (Simulação Wokwi)
 * Broker MQTT: broker.hivemq.com (Porta TCP 1883)
 * 
 * Funcionalidades:
 * 1. Conexão Wi-Fi (Wokwi-GUEST) e reconexão automática ao Broker HiveMQ.
 * 2. Publicação periódica de dados de telemetria dos sensores (Temperatura,
 *    Pressão, Radiação, Potência e Estado da Trava).
 * 3. Assinatura e recepção de comandos remotos da página Web via MQTT:
 *    - angra3/comandos/fechadura: Destravar (1) / Travar (0)
 *    - angra3/comandos/scram: Parada de emergência imediata
 *    - angra3/comandos/bomba: Acionamento de refrigeração
 * 4. Controle local por botão físico (GPIO 12) com debounce e temporizador
 *    de fechamento automático de 5 segundos.
 * 5. Atuação de Servo Motor (GPIO 13) e sinalização com LEDs (Verde GPIO 14 / Vermelho GPIO 27).
 * ====================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ESP32Servo.h>

// --- Credenciais de Wi-Fi e Broker HiveMQ ---
const char* WIFI_SSID     = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";

// HiveMQ Broker Público Gratuito (TCP)
const char* MQTT_BROKER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;

// Tópicos MQTT Padronizados
const char* TOPICO_TELEMETRIA    = "angra3/telemetria";
const char* TOPICO_STATUS_TRAVA  = "angra3/fechadura/status";
const char* TOPICO_STATUS_REATOR = "angra3/reator/status";
const char* TOPICO_ALERTAS       = "angra3/alertas";
const char* TOPICO_COMANDOS_SUB  = "angra3/comandos/#";

// --- Mapeamento de Pinos Físicos ---
const int PINO_SERVO    = 13; // Sinal PWM do Servo Motor
const int PINO_BOTAO    = 12; // Botão de acionamento físico local
const int PINO_VERDE    = 14; // LED Verde (Destravado / Normal)
const int PINO_VERMELHO = 27; // LED Vermelho (Travado / Alerta)
const int PINO_SENSOR   = 34; // Entrada Analógica (Opcional - Potenciômetro/Sensor)

// --- Instâncias dos Objetos ---
WiFiClient espClient;
PubSubClient mqttClient(espClient);
Servo meuServo;

// --- Variáveis de Controle e Estado ---
bool portaDestravada     = false;
bool modoScramAtivo      = false;
unsigned long tempoAbertura = 0;
const unsigned long TEMPO_PORTA_ABERTA = 5000; // 5 segundos aberta
int ultimoEstadoBotao    = HIGH;
unsigned long ultimoDebounce = 0;

// Variáveis de Telemetria dos Sensores
unsigned long ultimoEnvioTelemetria = 0;
const unsigned long INTERVALO_TELEMETRIA = 2000; // Envia a cada 2 segundos

float temperaturaBase = 327.0;
float pressaoBase     = 155.0;
float radiacaoBase    = 0.12;
int   potenciaBase    = 1405;

// --- Protótipos de Funções ---
void setupWifi();
void reconnectMqtt();
void processarComandoMqtt(char* topic, byte* payload, unsigned int length);
void acionarAbertura(const char* origem);
void travarPorta();
void ativarScram();
void enviarTelemetria();

void setup() {
  Serial.begin(115200);
  delay(100);

  Serial.println("\n==================================================");
  Serial.println("  Usina Nuclear Angra III - ESP32 HiveMQ Gateway  ");
  Serial.println("==================================================");

  // 1. Configuração dos Pinos
  pinMode(PINO_BOTAO, INPUT_PULLUP);
  pinMode(PINO_VERDE, OUTPUT);
  pinMode(PINO_VERMELHO, OUTPUT);

  // Estado inicial dos LEDs: Travado (Vermelho ligado, Verde desligado)
  digitalWrite(PINO_VERMELHO, HIGH);
  digitalWrite(PINO_VERDE, LOW);

  // 2. Inicialização segura do Servo Motor
  ESP32PWM::allocateTimer(0);
  meuServo.setPeriodHertz(50);
  meuServo.attach(PINO_SERVO, 500, 2400);
  meuServo.write(0); // Posição travada (0 graus)

  // 3. Conexão ao Wi-Fi
  setupWifi();

  // 4. Configuração do Cliente MQTT HiveMQ
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(processarComandoMqtt);
  mqttClient.setBufferSize(512); // Amplia buffer MQTT para suporte a payloads JSON completos
}

void loop() {
  // Mantém a conexão com o broker HiveMQ
  if (!mqttClient.connected()) {
    reconnectMqtt();
  }
  mqttClient.loop();

  // 1. Leitura do Botão Físico com Debounce
  int leituraBotao = digitalRead(PINO_BOTAO);
  if (leituraBotao == LOW && ultimoEstadoBotao == HIGH && (millis() - ultimoDebounce > 250)) {
    ultimoDebounce = millis();
    Serial.println("[BOTAO] Botao fisico de saida acionado!");
    acionarAbertura("Botao Fisico");
  }
  ultimoEstadoBotao = leituraBotao;

  // 2. Temporizador de 5 segundos para fechar automaticamente
  if (portaDestravada && !modoScramAtivo && (millis() - tempoAbertura >= TEMPO_PORTA_ABERTA)) {
    Serial.println("[TIMER] Tempo esgotado (5s) -> Fechando trava...");
    travarPorta();
  }

  // 3. Piscar LED vermelho caso SCRAM esteja ativo
  if (modoScramAtivo) {
    digitalWrite(PINO_VERMELHO, (millis() / 300) % 2);
  }

  // 4. Envio Periódico de Telemetria para o HiveMQ
  if (millis() - ultimoEnvioTelemetria >= INTERVALO_TELEMETRIA) {
    ultimoEnvioTelemetria = millis();
    enviarTelemetria();
  }
}

// --- Conexão ao Wi-Fi ---
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
    Serial.println("\n[WIFI] Conectado com sucesso!");
    Serial.print("[WIFI] Endereco IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[WIFI] Falha na conexao. Tentando novamente no loop.");
  }
}

// --- Conexão e Reconexão ao Broker HiveMQ ---
void reconnectMqtt() {
  static unsigned long ultimaTentativa = 0;
  if (millis() - ultimaTentativa < 4000) return;
  ultimaTentativa = millis();

  Serial.print("[MQTT] Tentando conectar ao Broker HiveMQ (");
  Serial.print(MQTT_BROKER);
  Serial.print(")... ");

  // Gera um ID de cliente único para evitar conflitos no broker público
  String clientId = "ESP32_Angra3_" + String(random(0xffff), HEX);

  if (mqttClient.connect(clientId.c_str())) {
    Serial.println("CONECTADO!");

    // Assina os canais de comando
    mqttClient.subscribe(TOPICO_COMANDOS_SUB);
    Serial.print("[MQTT] Inscrito no topico: ");
    Serial.println(TOPICO_COMANDOS_SUB);

    // Publica status de online
    mqttClient.publish(TOPICO_STATUS_REATOR, modoScramAtivo ? "SCRAM" : "ONLINE", true);
    mqttClient.publish(TOPICO_STATUS_TRAVA, portaDestravada ? "1" : "0", true);
  } else {
    Serial.print("FALHA, rc=");
    Serial.print(mqttClient.state());
    Serial.println(" - Tentando novamente em 4s");
  }
}

// --- Callback para Tratar Comandos Recebidos do HiveMQ ---
void processarComandoMqtt(char* topic, byte* payload, unsigned int length) {
  // Converte o payload para string legível
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

  // 1. Comando da Fechadura / Trava
  if (strTopic.endsWith("/fechadura") || strTopic.endsWith("smartlock-comando")) {
    if (mensagem == "1" || mensagem.equalsIgnoreCase("open") || mensagem.equalsIgnoreCase("destravar")) {
      modoScramAtivo = false;
      acionarAbertura("Nuvem HiveMQ");
    } else if (mensagem == "0" || mensagem.equalsIgnoreCase("close") || mensagem.equalsIgnoreCase("travar")) {
      travarPorta();
    }
  }
  // 2. Comando SCRAM (Parada de Emergência)
  else if (strTopic.endsWith("/scram")) {
    if (mensagem == "1" || mensagem.equalsIgnoreCase("SCRAM")) {
      ativarScram();
    }
  }
  // 3. Reset / Retorno da Emergência
  else if (strTopic.endsWith("/reset")) {
    modoScramAtivo = false;
    digitalWrite(PINO_VERMELHO, HIGH);
    digitalWrite(PINO_VERDE, LOW);
    meuServo.write(0);
    mqttClient.publish(TOPICO_STATUS_REATOR, "ONLINE");
    Serial.println("[SISTEMA] Modo normal restaurado.");
  }
}

// --- Ação de Destravar a Fechadura ---
void acionarAbertura(const char* origem) {
  meuServo.write(90);                 // Move o servo para 90 graus (Destravado)
  digitalWrite(PINO_VERMELHO, LOW);   // Apaga LED vermelho
  digitalWrite(PINO_VERDE, HIGH);     // Acende LED verde

  portaDestravada = true;
  tempoAbertura = millis();           // Inicia contagem de 5s

  Serial.print("[TRAVA] Destravada por: ");
  Serial.println(origem);

  if (mqttClient.connected()) {
    mqttClient.publish(TOPICO_STATUS_TRAVA, "1");
    mqttClient.publish(TOPICO_ALERTAS, "Trava de Contencao Destravada");
  }
}

// --- Ação de Travar a Fechadura ---
void travarPorta() {
  meuServo.write(0);                  // Retorna o servo para 0 graus (Travado)
  digitalWrite(PINO_VERMELHO, HIGH);  // Acende LED vermelho
  digitalWrite(PINO_VERDE, LOW);      // Apaga LED verde

  portaDestravada = false;

  Serial.println("[TRAVA] Travada com sucesso.");

  if (mqttClient.connected()) {
    mqttClient.publish(TOPICO_STATUS_TRAVA, "0");
  }
}

// --- Ação de Emergência SCRAM ---
void ativarScram() {
  modoScramAtivo = true;
  portaDestravada = false;
  meuServo.write(0); // Insere imediatamente todas as travas e hastes de controle

  digitalWrite(PINO_VERDE, LOW);
  digitalWrite(PINO_VERMELHO, HIGH);

  potenciaBase = 0;

  Serial.println("==========================================");
  Serial.println("  [ALERTA CRITICO] SCRAM EXECUTADO!       ");
  Serial.println("==========================================");

  if (mqttClient.connected()) {
    mqttClient.publish(TOPICO_STATUS_REATOR, "SCRAM", true);
    mqttClient.publish(TOPICO_STATUS_TRAVA, "0", true);
    mqttClient.publish(TOPICO_ALERTAS, "CRITICO: SCRAM ATIVADO NO ESP32!", true);
  }
}

// --- Envio de Telemetria para o HiveMQ ---
void enviarTelemetria() {
  if (!mqttClient.connected()) return;

  // Simula pequenas flutuações físicas normais do reator
  float variacaoTemp = (random(-15, 16)) / 10.0;
  float variacaoPress = (random(-10, 11)) / 10.0;
  float variacaoRad  = (random(-2, 3)) / 100.0;

  float tempAtual  = modoScramAtivo ? 85.0 : (temperaturaBase + variacaoTemp);
  float pressAtual = modoScramAtivo ? 45.0 : (pressaoBase + variacaoPress);
  float radAtual   = modoScramAtivo ? 0.05 : (radiacaoBase + variacaoRad);
  int   potAtual   = modoScramAtivo ? 0 : (potenciaBase + random(-8, 9));

  // Formata o pacote JSON compacto
  char jsonBuffer[256];
  snprintf(jsonBuffer, sizeof(jsonBuffer),
    "{\"temperatura\":%.2f,\"pressao\":%.2f,\"radiacao\":%.3f,\"potencia\":%d,\"trava\":%d,\"servo\":%d}",
    tempAtual,
    pressAtual,
    radAtual,
    potAtual,
    portaDestravada ? 1 : 0,
    portaDestravada ? 90 : 0
  );

  mqttClient.publish(TOPICO_TELEMETRIA, jsonBuffer);
  Serial.print("[TELEMETRIA ENVIADA] ");
  Serial.println(jsonBuffer);
}
