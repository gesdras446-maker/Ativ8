# Usina Nuclear Angra III — Painel de Controle & Telemetria IoT

> **Projeto Integrado: Atividade 07 (Sistemas Embarcados com ESP32 & MQTT) & Atividade 08 (Dashboard Web em Tempo Real com Chart.js)**  
> **Instituição:** SENAI / SESI  
> **Tema:** Consumo de APIs, Gráficos Dinâmicos em Tempo Real, Integração MQTT e Feedbacks Visuais.

---

## 📋 Sumário
1. [Visão Geral do Projeto](#-visão-geral-do-projeto)
2. [Arquitetura de Comunicação](#-arquitetura-de-comunicação)
3. [Dicionário de Tópicos MQTT (HiveMQ)](#-dicionário-de-tópicos-mqtt-hivemq)
4. [Hardware e Simulação no Wokwi](#-hardware-e-simulação-no-wokwi)
   - [Opção A: Projeto E-Stop (Parada de Emergência)](#opção-a-projeto-e-stop-link-478397334417475585)
   - [Opção B: Projeto Fechadura Inteligente (Trava de Contenção)](#opção-b-projeto-fechadura-inteligente-link-478401133524771841)
   - [Opção C: Firmware Unificado (Tudo em Um)](#opção-c-firmware-unificado-tudo-em-um)
5. [Frontend Web: Funcionalidades Desenvolvidas](#-frontend-web-funcionalidades-desenvolvidas)
6. [Passo a Passo para Execução e Teste](#-passo-a-passo-para-execução-e-teste)
7. [Dicas para a Apresentação e Avaliação](#-dicas-para-a-apresentação-e-avaliação)

---

## 🎯 Visão Geral do Projeto

O objetivo deste projeto é construir uma solução IoT completa de ponta a ponta:
1. **Dispositivos de Borda (Edge / ESP32)**: Leitura de sensores analógicos (Potenciômetro/RPM da Turbina), acionamento de atuadores de segurança (Módulo Relé, Servo Motor de Contenção e LEDs de Sinalização), e tratamento de botões físicos de emergência (E-Stop).
2. **Nuvem IoT (Broker HiveMQ)**: Utilização do broker público gratuito `broker.hivemq.com` para tráfego bidirecional de mensagens em formato JSON via TCP (porta 1883) e WebSockets (porta 8884/8000).
3. **Dashboard Web (Frontend)**: Interface moderna e responsiva no tema Sci-Fi / Nuclear com:
   - Gráfico dinâmico em tempo real utilizando **Chart.js** com 5 métricas alternáveis.
   - Conexão nativa e reativa com a nuvem utilizando a biblioteca **MQTT.js**.
   - Painel de acionamento de comandos críticos (SCRAM, Desligamento Controlado, Autoteste de Sistemas, Silenciamento de Alarmes e Trava Remota).
   - Múltiplos tratamentos de feedback visual (Badges pulsantes, Log de Alertas, Toasts flutuantes e áudio sintetizado via Web Audio API).
   - Exportação do histórico de telemetria coletado em formato `.csv`.

---

## 🌐 Arquitetura de Comunicação

```
┌──────────────────────────────────────────────┐
│          MICROCONTROLADOR ESP32              │
│  (Wokwi Simulator — Linguagem C++/Arduino)   │
│  - Sensor de RPM (Potenciômetro GPIO 34)     │
│  - Botão de Emergência E-Stop (GPIO 25)      │
│  - Módulo Relé Motor/Gerador (GPIO 26)       │
│  - Trava Servo Motor (GPIO 13)               │
│  - Sinalizadores LED Verde/Vermelho          │
└──────────────────────┬───────────────────────┘
                       │
                       │ Protocolo MQTT padrão (TCP: Porta 1883)
                       ▼
┌──────────────────────────────────────────────┐
│       BROKER MQTT PÚBLICO HIVEMQ             │
│         broker.hivemq.com                    │
│   (Encaminhamento Publish / Subscribe)       │
└──────────────────────┬───────────────────────┘
                       │
                       │ Protocolo MQTT sobre WebSockets (WSS: Porta 8884)
                       ▼
┌──────────────────────────────────────────────┐
│           DASHBOARD WEB (HTML5/CSS/JS)       │
│  (Navegador do Operador — app.js)            │
│  - Gráfico de Linha em Tempo Real (Chart.js) │
│  - Status da Conexão em tempo real           │
│  - Comandos: SCRAM, Trava, Bombas, Barras    │
│  - Feedbacks: Toasts, Áudio e Log Alertas    │
│  - Exportador CSV de Amostras                │
└──────────────────────────────────────────────┘
```

---

## 📡 Dicionário de Tópicos MQTT (HiveMQ)

| Tópico | Direção | Formato / Payload | Descrição |
| :--- | :--- | :--- | :--- |
| `angra3/telemetria` | ESP32 ➔ Web | JSON `{"temperatura":...,"pressao":...,"turbina":...,"potencia":...,"trava":...}` | Pacote unificado com as leituras dos sensores a cada 1.5s |
| `angra3/turbina/rpm` | ESP32 ➔ Web | Numérico (Ex: `"2450"`) | Valor instantâneo do RPM lido no potenciômetro |
| `angra3/fechadura/status` | ESP32 ➔ Web | `"1"` (Aberta) ou `"0"` (Fechada) | Estado da trava da porta de contenção |
| `angra3/reator/status` | Bidirecional | `"ONLINE"` ou `"SCRAM"` | Estado operacional geral da usina |
| `angra3/alertas` | ESP32 ➔ Web | Texto (Ex: `"SCRAM Ativado"`) | Notificações e alertas críticos de segurança |
| `angra3/comandos/scram` | Web ➔ ESP32 | `"1"` (Dispara SCRAM) | Comando de desligamento emergencial imediato |
| `angra3/comandos/fechadura`| Web ➔ ESP32 | `"1"` (Destravar) ou `"0"` (Travar) | Controle remoto da fechadura/servo |
| `angra3/comandos/teste` | Web ➔ ESP32 | `"start"` | Disparo da rotina de diagnóstico dos sistemas |
| `angra3/comandos/bomba/...`| Web ➔ ESP32 | `"1"` (Liga) ou `"0"` (Desliga) | Acionamento das bombas primárias e secundárias |

---

## 🔌 Hardware e Simulação no Wokwi

O projeto suporta tanto a execução em **dois circuitos separados** quanto em **um circuito único consolidado**.

### Opção A: Projeto E-Stop ([Link 478397334417475585](https://wokwi.com/projects/478397334417475585))
- **Arquivo C++**: [`sketch_estop_hivemq.ino`](file:///c:/Users/47819605880.SESISENAI.001/Desktop/Ativ8/sketch_estop_hivemq.ino)
- **Pinagem**:
  - `GPIO 34`: Potenciômetro (SIG) — Simula o RPM da Turbina (0 a 3000 RPM).
  - `GPIO 26`: Módulo Relé (IN) — Motor/Gerador principal da usina.
  - `GPIO 25`: Botão de Pressão Vermelho — Parada física de emergência (E-Stop).

### Opção B: Projeto Fechadura Inteligente ([Link 478401133524771841](https://wokwi.com/projects/478401133524771841))
- **Arquivo C++**: [`sketch.ino`](file:///c:/Users/47819605880.SESISENAI.001/Desktop/Ativ8/sketch.ino) / [`sketch_hivemq.ino`](file:///c:/Users/47819605880.SESISENAI.001/Desktop/Ativ8/sketch_hivemq.ino)
- **Pinagem**:
  - `GPIO 13`: Servo Motor (PWM) — Trava mecânica (0° = Travada / 90° = Aberta).
  - `GPIO 12`: Botão de Pressão Verde — Abertura local de saída.
  - `GPIO 14`: LED Verde — Sinalização de sistema destravado / normal.
  - `GPIO 27`: LED Vermelho — Sinalização de sistema travado / alerta.

### Opção C: Firmware Unificado (Tudo em Um)
- **Arquivo C++**: [`sketch_unificado.ino`](file:///c:/Users/47819605880.SESISENAI.001/Desktop/Ativ8/sketch_unificado.ino)
- Integra todos os 7 componentes físicos em um único microcontrolador ESP32 sem nenhum conflito de pinos.

---

## 💻 Frontend Web: Funcionalidades Desenvolvidas

### 1. Gráficos em Tempo Real (`Chart.js`)
- Renderização de gráfico de linha responsivo com curvas suaves (`tension: 0.35`) e preenchimento gradiente.
- **Botões Seletores de Métrica**:
  - `🌡️ Temperatura`: Visualiza a curva de temperatura do núcleo em °C.
  - `⚙️ Pressão`: Curva de pressão do pressurizador em bar.
  - `☢️ Radiação`: Monitoramento radiológico em μSv/h.
  - `⚡ Potência`: Geração bruta em MW.
  - `🔄 Turbina (RPM)`: Leitura instantânea vinda do potenciômetro do ESP32.
  - `🌐 Multi-Variáveis`: Visão combinada com todas as grandezas simultâneas.
- **Ações Rápidas**:
  - `⏸️ Pausar`: Congela temporariamente a renderização para análise estática.
  - `🗑️ Limpar`: Limpa a fila de pontos.
  - `📥 Exportar CSV`: Gera download automático de planilha com timestamp e todas as medições coletadas.

### 2. Programação dos Botões e Controles
- **Botão SCRAM**: Dispara confirmação de segurança, envia comando MQTT ao ESP32, desarma o relé do motor, recolhe as travas, zera potências e coloca o painel em alerta visual vermelho.
- **Botão Desligamento Controlado**: Realiza uma desaceleração programada em 10 etapas da geração de energia.
- **Botão Testar Sistemas de Segurança**: Realiza uma varredura visual sequencial nos 8 blocos de subsistemas com retorno de diagnóstico `100% NOMINAL`.
- **Botão Silenciar Alarmes**: Interrompe piscamentos de aviso sonoro/visual.
- **Widget da Fechadura / Trava IoT**:
  - Botão `Destravar (Nuvem)`: Envia pulso de destravamento, gira o servo para 90°, acende o LED verde virtual e dispara contagem regressiva de 5 segundos para re-bloqueio automático.
  - Botão `Travar Porta`: Bloqueio imediato da contenção.
- **Sliders e Toggles de Bombas**: Publicam eventos MQTT individualizados para cada bomba e barra de controle.

### 3. Tratamento de Feedbacks Visuais e Sonoros
- **Badge MQTT no Cabeçalho**: Indica visualmente `MQTT: ONLINE (HiveMQ)` em verde brilhante, `MQTT: CONECTANDO...` em âmbar, ou `MQTT: OFFLINE` em vermelho.
- **Notificações Toast**: Sistema flutuante com animações suaves de entrada e saída informando cada ação do operador.
- **Log de Alertas com Tags Coloridas**: Adiciona dinamicamente eventos (`CRÍTICO`, `AVISO`, `INFO`, `OK`) com animação slide-in.
- **Sintetizador Web Audio API**: Beeps sonoros discretos de alta fidelidade para cliques, confirmações e sirene de SCRAM, sem necessidade de arquivos `.mp3` externos.
- **Simulador Autônomo Local**: Garante que o painel exiba dados vivos e flutuações físicas realistas mesmo antes do Wokwi ser iniciado.

---

## 🚀 Passo a Passo para Execução e Teste

### Passo 1: Abrir o Painel Web
1. Dê um duplo clique no arquivo [`index.html`](file:///c:/Users/47819605880.SESISENAI.001/Desktop/Ativ8/index.html) para abri-lo no Google Chrome, Microsoft Edge ou Firefox.
2. Verifique o cabeçalho: o indicador exibirá **`MQTT: ONLINE (HiveMQ)`**.
3. O gráfico de telemetria já começará a traçar os primeiros pontos.

### Passo 2: Executar o Circuito no Wokwi
1. Abra o projeto do **E-Stop** ([Wokwi 478397334417475585](https://wokwi.com/projects/478397334417475585)) ou da **Fechadura** ([Wokwi 478401133524771841](https://wokwi.com/projects/478401133524771841)).
2. Certifique-se de colar o código correspondente (`sketch_estop_hivemq.ino` ou `sketch.ino`).
3. Clique no botão verde de **Play** do Wokwi.
4. No Monitor Serial do Wokwi, observe as mensagens:
   ```text
   [WIFI] Conectado!
   [MQTT] Conectado ao HiveMQ!
   ```

### Passo 3: Demonstrar a Interatividade Bidirecional
- **Do Wokwi para a Web**:
  - Gire o potenciômetro no Wokwi do E-Stop ➔ Veja o card da **Turbina Principal** e o gráfico Chart.js subirem instantaneamente no site.
  - Aperte o botão vermelho E-Stop no Wokwi ➔ Veja a tela da usina entrar imediatamente no modo **SCRAM CRÍTICO** com sirene e toast de perigo.
  - Aperte o botão verde no Wokwi da Fechadura ➔ Veja a trava no site mudar para **DESTRAVADA (90°)**.
- **Da Web para o Wokwi**:
  - No site, clique no botão **"Destravar (Nuvem)"** ➔ Veja o Servo Motor no Wokwi girar para 90° e o LED verde acender.
  - No site, clique no botão vermelho **"SCRAM"** ➔ Veja o Módulo Relé no Wokwi abrir (desligar) na mesma hora.
  - No site, clique em **"📥 Exportar CSV"** na barra do gráfico para baixar os dados coletados.

---

## 🏆 Dicas para a Apresentação e Avaliação

1. **Destaque a Eliminação de Barreiras de Rede**: Explique ao professor que ao invés de usar chaves de API restritas do Adafruit IO (que bloqueiam WebSockets abertos em navegadores), a migração para o **Broker HiveMQ** permitiu que a página web converse diretamente com o simulador Wokwi via WebSockets seguros (`WSS:8884`), tornando o sistema 100% em tempo real e de latência quase zero.
2. **Mostre a Independência de Bibliotecas**: O projeto contém cópias locais minificadas na pasta `lib/` com fallback dinâmico para CDN, funcionando perfeitamente mesmo em redes escolares com firewall ou sem internet.
3. **Mostre o Exportador de Dados CSV**: Demonstre como os dados das grandezas físicas da usina podem ser auditados e exportados para análise externa.

