/**
 * ====================================================================
 * USINA NUCLEAR ANGRA III — PAINEL DE CONTROLE & TELEMETRIA IOT
 * Arquivo: app.js
 * 
 * Funcionalidades:
 * 1. Integração com Nuvem HiveMQ via WebSockets (MQTT).
 * 2. Gráfico Dinâmico em Tempo Real com Chart.js.
 * 3. Consumo de tópicos de telemetria dos sensores e atuadores.
 * 4. Programação completa de botões (SCRAM, Desligamento, Teste, Silenciar, Trava IoT).
 * 5. Feedbacks visuais ricos: Toasts, status badges pulsantes, logs animados.
 * ====================================================================
 */

// ====================================================================
// CONFIGURAÇÃO DO BROKER MQTT (HIVEMQ) & TÓPICOS
// ====================================================================
const MQTT_CONFIG = {
    // HiveMQ Public Broker via WebSocket Seguro (WSS) ou WS padrão
    url: (window.location.protocol === 'https:' ? 'wss://' : 'wss://') + 'broker.hivemq.com:8884/mqtt',
    fallbackUrl: 'ws://broker.hivemq.com:8000/mqtt',
    options: {
        clientId: 'angra3_web_' + Math.random().toString(16).substring(2, 10),
        clean: true,
        connectTimeout: 7000,
        reconnectPeriod: 3000,
        keepalive: 60
    },
    topics: {
        telemetry: 'angra3/telemetria',
        lockStatus: 'angra3/fechadura/status',
        reactorStatus: 'angra3/reator/status',
        alerts: 'angra3/alertas',
        commandsPrefix: 'angra3/comandos/'
    }
};

// ====================================================================
// ESTADO GLOBAL DA APLICAÇÃO
// ====================================================================
const state = {
    mqttConnected: false,
    chartPaused: false,
    currentMetric: 'temperatura',
    isScram: false,
    isShuttingDown: false,
    autoCloseTimer: null,
    pointsCollected: 0,
    
    // Telemetria atual
    telemetry: {
        temperatura: 327.0,
        pressao: 155.0,
        potencia: 1405,
        radiacao: 0.12,
        vazao: 18500,
        turbina: 3000,
        trava: 0,      // 0 = travado, 1 = destravado
        servo: 0       // 0 a 90 graus
    },

    // Histórico de pontos para o Chart.js
    history: {
        labels: [],
        temperatura: [],
        pressao: [],
        radiacao: [],
        potencia: []
    }
};

let mqttClient = null;
let realtimeChart = null;

// ====================================================================
// INICIALIZAÇÃO APÓS CARREGAMENTO DO DOM
// ====================================================================
document.addEventListener('DOMContentLoaded', () => {
    initClock();
    initSmoothNavigation();
    initChart();
    initSliders();
    initPumpToggles();
    initButtons();
    initSmartLock();
    initChartControls();
    
    // Conecta ao Broker HiveMQ
    connectMqtt();

    // Inicia simulador autônomo local (garante gráficos vivos enquanto aguarda dados do ESP32)
    startAutonomousTelemetry();
});

// ====================================================================
// 1. CONEXÃO MQTT (HIVEMQ)
// ====================================================================
function connectMqtt() {
    updateMqttStatus('conectando', 'MQTT: CONECTANDO...');

    try {
        if (typeof mqtt === 'undefined') {
            console.error('Biblioteca MQTT.js não encontrada!');
            updateMqttStatus('erro', 'MQTT: LIB NÃO CARREGADA');
            return;
        }

        console.log(`[MQTT] Conectando ao HiveMQ: ${MQTT_CONFIG.url}`);
        mqttClient = mqtt.connect(MQTT_CONFIG.url, MQTT_CONFIG.options);

        mqttClient.on('connect', () => {
            state.mqttConnected = true;
            console.log('[MQTT] Conectado ao Broker HiveMQ com sucesso!');
            updateMqttStatus('conectado', 'MQTT: ONLINE (HiveMQ)');
            showToast('Conexão Estabelecida', 'Conectado ao broker HiveMQ com sucesso!', 'success');
            addAlertLog('OK', 'Conexão com o broker HiveMQ (broker.hivemq.com) estabelecida via WebSockets.');

            // Inscrição nos tópicos
            const topicsToSubscribe = [
                MQTT_CONFIG.topics.telemetry,
                MQTT_CONFIG.topics.lockStatus,
                MQTT_CONFIG.topics.reactorStatus,
                MQTT_CONFIG.topics.alerts,
                MQTT_CONFIG.topics.commandsPrefix + '#'
            ];

            topicsToSubscribe.forEach(topic => {
                mqttClient.subscribe(topic, (err) => {
                    if (!err) {
                        console.log(`[MQTT] Inscrito no tópico: ${topic}`);
                    } else {
                        console.error(`[MQTT] Erro ao subscrever em ${topic}:`, err);
                    }
                });
            });
        });

        mqttClient.on('message', (topic, message) => {
            handleMqttMessage(topic, message.toString());
        });

        mqttClient.on('reconnect', () => {
            console.log('[MQTT] Tentando reconectar...');
            updateMqttStatus('conectando', 'MQTT: RECONECTANDO...');
        });

        mqttClient.on('offline', () => {
            state.mqttConnected = false;
            console.warn('[MQTT] Cliente Offline.');
            updateMqttStatus('offline', 'MQTT: OFFLINE');
        });

        mqttClient.on('error', (err) => {
            console.error('[MQTT] Erro de conexão:', err);
            updateMqttStatus('erro', 'MQTT: ERRO');
        });

    } catch (e) {
        console.error('[MQTT] Exceção na conexão:', e);
        updateMqttStatus('erro', 'MQTT: FALHA');
    }
}

// Atualização visual do status de conexão MQTT no Header
function updateMqttStatus(status, text) {
    const badge = document.getElementById('mqtt-status-badge');
    const dot = document.getElementById('mqtt-status-dot');
    const label = document.getElementById('mqtt-status-text');

    if (!badge || !dot || !label) return;

    label.textContent = text;
    dot.className = 'status-dot';

    switch (status) {
        case 'conectado':
            dot.classList.add('pulse-success');
            badge.style.borderColor = 'rgba(0, 230, 118, 0.4)';
            break;
        case 'conectando':
            dot.classList.add('pulse-warning');
            badge.style.borderColor = 'rgba(255, 145, 0, 0.4)';
            break;
        case 'offline':
        case 'erro':
            dot.classList.add('pulse-danger');
            badge.style.borderColor = 'rgba(255, 23, 68, 0.4)';
            break;
    }
}

// ====================================================================
// 2. PROCESSAMENTO DE MENSAGENS MQTT RECEBIDAS
// ====================================================================
function handleMqttMessage(topic, messageStr) {
    console.log(`[MQTT RX] Tópico: ${topic} | Mensagem: ${messageStr}`);

    try {
        // 1. Telemetria Geral dos Sensores
        if (topic === MQTT_CONFIG.topics.telemetry) {
            let data = {};
            try {
                data = JSON.parse(messageStr);
            } catch (err) {
                // Caso a telemetria venha como valor bruto numérico
                data = { temperatura: parseFloat(messageStr) };
            }
            processTelemetryData(data);
        }
        // 2. Status da Fechadura / Trava IoT
        else if (topic === MQTT_CONFIG.topics.lockStatus || topic.endsWith('/fechadura')) {
            const isUnlocked = messageStr === '1' || messageStr.toLowerCase() === 'open';
            updateSmartLockUI(isUnlocked, 'Wokwi ESP32');
        }
        // 3. Status Geral do Reator (SCRAM / ONLINE)
        else if (topic === MQTT_CONFIG.topics.reactorStatus) {
            if (messageStr === 'SCRAM') {
                executarFeedbackScram(false);
            }
        }
        // 4. Log de Alertas
        else if (topic === MQTT_CONFIG.topics.alerts) {
            addAlertLog('AVISO', messageStr);
            showToast('Alerta do Reator', messageStr, 'warning');
        }
        // 5. RPM da Turbina vindo do E-Stop (GPIO 34 / Potenciômetro)
        else if (topic.endsWith('/turbina/rpm') || topic.endsWith('/estop-rpm') || topic.endsWith('/rpm')) {
            const rpmVal = parseFloat(messageStr);
            if (!isNaN(rpmVal)) {
                state.telemetry.turbina = rpmVal;
                state.telemetry.potencia = Math.round((rpmVal / 3000) * 1510);
                updateTelemetryCards();
                pushDataToChart();
            }
        }
        // 6. E-Stop / SCRAM vindo do Botão Físico no Wokwi (GPIO 25)
        else if (topic.endsWith('/scram') || topic.endsWith('/estop')) {
            if (messageStr === '1' || messageStr.toUpperCase() === 'SCRAM') {
                executarFeedbackScram(false);
            }
        }
    } catch (e) {
        console.error('[MQTT] Erro ao processar mensagem recebida:', e);
    }
}

// Atualiza o estado e a interface com os dados recebidos dos sensores
function processTelemetryData(data) {
    if (data.temperatura !== undefined) state.telemetry.temperatura = Number(data.temperatura);
    if (data.pressao !== undefined)     state.telemetry.pressao = Number(data.pressao);
    if (data.potencia !== undefined)    state.telemetry.potencia = Number(data.potencia);
    if (data.radiacao !== undefined)    state.telemetry.radiacao = Number(data.radiacao);
    if (data.vazao !== undefined)       state.telemetry.vazao = Number(data.vazao);
    if (data.turbina !== undefined)     state.telemetry.turbina = Number(data.turbina);
    if (data.trava !== undefined) {
        updateSmartLockUI(Number(data.trava) === 1, 'ESP32 Telemetria');
    }

    updateTelemetryCards();
    pushDataToChart();
}

// ====================================================================
// 3. ATUALIZAÇÃO DOS CARDS DE TELEMETRIA
// ====================================================================
function updateTelemetryCards() {
    // 1. Temperatura do Núcleo
    const elTemp = document.getElementById('core-temp-value');
    const barTemp = document.getElementById('core-temp-bar');
    if (elTemp && barTemp) {
        elTemp.textContent = state.telemetry.temperatura.toFixed(1);
        const pctTemp = Math.min(100, Math.max(0, (state.telemetry.temperatura / 480) * 100));
        barTemp.style.setProperty('--bar-width', pctTemp + '%');
        
        // Cores dinâmicas de aviso
        if (state.telemetry.temperatura > 380) {
            barTemp.style.setProperty('--bar-color', 'var(--accent-red)');
        } else if (state.telemetry.temperatura > 340) {
            barTemp.style.setProperty('--bar-color', 'var(--accent-orange)');
        } else {
            barTemp.style.setProperty('--bar-color', 'var(--accent-cyan)');
        }
    }

    // 2. Pressão do Pressurizador
    const elPress = document.getElementById('pressure-value');
    const barPress = document.getElementById('pressure-bar');
    if (elPress && barPress) {
        elPress.textContent = state.telemetry.pressao.toFixed(1);
        const pctPress = Math.min(100, Math.max(0, (state.telemetry.pressao / 200) * 100));
        barPress.style.setProperty('--bar-width', pctPress + '%');
    }

    // 3. Potência Gerada
    const elPower = document.getElementById('power-value');
    const barPower = document.getElementById('power-bar');
    if (elPower && barPower) {
        elPower.textContent = Math.round(state.telemetry.potencia);
        const pctPower = Math.min(100, Math.max(0, (state.telemetry.potencia / 1510) * 100));
        barPower.style.setProperty('--bar-width', pctPower + '%');
    }

    // 4. Radiação Ambiental
    const elRad = document.getElementById('radiation-value');
    const barRad = document.getElementById('radiation-bar');
    if (elRad && barRad) {
        elRad.textContent = state.telemetry.radiacao.toFixed(2);
        const pctRad = Math.min(100, Math.max(0, (state.telemetry.radiacao / 1.0) * 100));
        barRad.style.setProperty('--bar-width', pctRad + '%');
        
        if (state.telemetry.radiacao > 0.5) {
            barRad.style.setProperty('--bar-color', 'var(--accent-red)');
        } else if (state.telemetry.radiacao > 0.25) {
            barRad.style.setProperty('--bar-color', 'var(--accent-orange)');
        } else {
            barRad.style.setProperty('--bar-color', 'var(--accent-green)');
        }
    }

    // 5. Turbina Principal / RPM (Integrado com Potenciômetro Wokwi E-Stop)
    const elTurbine = document.getElementById('turbine-value');
    const barTurbine = document.getElementById('turbine-bar');
    if (elTurbine && barTurbine) {
        elTurbine.textContent = Math.round(state.telemetry.turbina).toLocaleString('pt-BR');
        const pctTurbine = Math.min(100, Math.max(0, (state.telemetry.turbina / 3000) * 100));
        barTurbine.style.setProperty('--bar-width', pctTurbine + '%');

        if (state.telemetry.turbina > 2800) {
            barTurbine.style.setProperty('--bar-color', 'var(--accent-red)');
        } else if (state.telemetry.turbina < 500 && !state.isScram) {
            barTurbine.style.setProperty('--bar-color', 'var(--accent-orange)');
        } else {
            barTurbine.style.setProperty('--bar-color', 'var(--accent-purple)');
        }
    }

    // 6. Vazão de Refrigeração
    const elCoolant = document.getElementById('coolant-value');
    const barCoolant = document.getElementById('coolant-bar');
    if (elCoolant && barCoolant) {
        elCoolant.textContent = Math.round(state.telemetry.vazao).toLocaleString('pt-BR');
        const pctCoolant = Math.min(100, Math.max(0, (state.telemetry.vazao / 22000) * 100));
        barCoolant.style.setProperty('--bar-width', pctCoolant + '%');
    }

    // Atualização de Status Geral (Nível de Ameaça)
    const threatLevelEl = document.getElementById('threat-level');
    if (threatLevelEl) {
        if (state.isScram) {
            threatLevelEl.textContent = 'CRÍTICO';
            threatLevelEl.className = 'status-value level-critical';
            threatLevelEl.style.color = 'var(--accent-red)';
        } else if (state.telemetry.temperatura > 360 || state.telemetry.radiacao > 0.4) {
            threatLevelEl.textContent = 'ELEVADO';
            threatLevelEl.className = 'status-value level-warning';
            threatLevelEl.style.color = 'var(--accent-orange)';
        } else {
            threatLevelEl.textContent = 'NORMAL';
            threatLevelEl.className = 'status-value level-normal';
            threatLevelEl.style.color = 'var(--accent-green)';
        }
    }
}

// ====================================================================
// 4. GRÁFICOS EM TEMPO REAL COM CHART.JS
// ====================================================================
function initChart() {
    const canvas = document.getElementById('realtimeChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Configuração dos Datasets no tema Angra III
    const datasets = [
        {
            label: 'Temperatura do Núcleo (°C)',
            data: [],
            borderColor: '#ff9100',
            backgroundColor: 'rgba(255, 145, 0, 0.1)',
            borderWidth: 2.5,
            pointBackgroundColor: '#ff9100',
            pointBorderColor: '#0a0e17',
            pointRadius: 3,
            pointHoverRadius: 6,
            fill: true,
            tension: 0.35,
            yAxisID: 'y'
        },
        {
            label: 'Pressão (bar)',
            data: [],
            borderColor: '#00e5ff',
            backgroundColor: 'rgba(0, 229, 255, 0.08)',
            borderWidth: 2.5,
            pointBackgroundColor: '#00e5ff',
            pointBorderColor: '#0a0e17',
            pointRadius: 3,
            fill: true,
            tension: 0.35,
            hidden: true,
            yAxisID: 'y'
        },
        {
            label: 'Radiação (μSv/h)',
            data: [],
            borderColor: '#00e676',
            backgroundColor: 'rgba(0, 230, 118, 0.08)',
            borderWidth: 2.5,
            pointBackgroundColor: '#00e676',
            pointBorderColor: '#0a0e17',
            pointRadius: 3,
            fill: true,
            tension: 0.35,
            hidden: true,
            yAxisID: 'y'
        },
        {
            label: 'Potência Gerada (MW)',
            data: [],
            borderColor: '#2979ff',
            backgroundColor: 'rgba(41, 121, 255, 0.08)',
            borderWidth: 2.5,
            pointBackgroundColor: '#2979ff',
            pointBorderColor: '#0a0e17',
            pointRadius: 3,
            fill: true,
            tension: 0.35,
            hidden: true,
            yAxisID: 'y'
        },
        {
            label: 'Turbina Principal (RPM)',
            data: [],
            borderColor: '#d500f9',
            backgroundColor: 'rgba(213, 0, 249, 0.08)',
            borderWidth: 2.5,
            pointBackgroundColor: '#d500f9',
            pointBorderColor: '#0a0e17',
            pointRadius: 3,
            fill: true,
            tension: 0.35,
            hidden: true,
            yAxisID: 'y'
        }
    ];

    realtimeChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 400,
                easing: 'easeOutQuart'
            },
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: '#90a4ae',
                        font: {
                            family: 'Rajdhani',
                            size: 13,
                            weight: '600'
                        },
                        usePointStyle: true,
                        pointStyle: 'circle'
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(19, 26, 43, 0.95)',
                    titleColor: '#00e5ff',
                    bodyColor: '#e8eaf6',
                    borderColor: 'rgba(0, 229, 255, 0.3)',
                    borderWidth: 1,
                    padding: 10,
                    titleFont: { family: 'Orbitron', size: 12 },
                    bodyFont: { family: 'Share Tech Mono', size: 12 }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#546e7a',
                        font: { family: 'Share Tech Mono', size: 11 },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 8
                    }
                },
                y: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#90a4ae',
                        font: { family: 'Share Tech Mono', size: 11 }
                    }
                }
            }
        }
    });
}

// Adiciona um ponto ao gráfico em tempo real
function pushDataToChart() {
    if (!realtimeChart || state.chartPaused) return;

    const now = new Date();
    const timeLabel = now.toLocaleTimeString('pt-BR', { hour12: false });
    const MAX_POINTS = 20;

    state.pointsCollected++;
    const pointsCountEl = document.getElementById('chart-points-count');
    if (pointsCountEl) pointsCountEl.textContent = state.pointsCollected;

    // Atualiza label atual do topo do gráfico
    const valDisplay = document.getElementById('chart-current-value');
    if (valDisplay) {
        if (state.currentMetric === 'temperatura') {
            valDisplay.textContent = state.telemetry.temperatura.toFixed(1) + ' °C';
        } else if (state.currentMetric === 'pressao') {
            valDisplay.textContent = state.telemetry.pressao.toFixed(1) + ' bar';
        } else if (state.currentMetric === 'radiacao') {
            valDisplay.textContent = state.telemetry.radiacao.toFixed(2) + ' μSv/h';
        } else if (state.currentMetric === 'potencia') {
            valDisplay.textContent = Math.round(state.telemetry.potencia) + ' MW';
        } else if (state.currentMetric === 'turbina') {
            valDisplay.textContent = Math.round(state.telemetry.turbina) + ' RPM';
        } else {
            valDisplay.textContent = `${state.telemetry.temperatura.toFixed(1)} °C | ${state.telemetry.pressao.toFixed(0)} bar`;
        }
    }

    // Adiciona labels
    realtimeChart.data.labels.push(timeLabel);
    if (realtimeChart.data.labels.length > MAX_POINTS) {
        realtimeChart.data.labels.shift();
    }

    // Adiciona valores a cada dataset correspondente
    // 0: Temperatura
    realtimeChart.data.datasets[0].data.push(state.telemetry.temperatura);
    if (realtimeChart.data.datasets[0].data.length > MAX_POINTS) {
        realtimeChart.data.datasets[0].data.shift();
    }

    // 1: Pressão
    realtimeChart.data.datasets[1].data.push(state.telemetry.pressao);
    if (realtimeChart.data.datasets[1].data.length > MAX_POINTS) {
        realtimeChart.data.datasets[1].data.shift();
    }

    // 2: Radiação
    realtimeChart.data.datasets[2].data.push(state.telemetry.radiacao);
    if (realtimeChart.data.datasets[2].data.length > MAX_POINTS) {
        realtimeChart.data.datasets[2].data.shift();
    }

    // 3: Potência
    realtimeChart.data.datasets[3].data.push(state.telemetry.potencia);
    if (realtimeChart.data.datasets[3].data.length > MAX_POINTS) {
        realtimeChart.data.datasets[3].data.shift();
    }

    // 4: Turbina (RPM)
    if (realtimeChart.data.datasets[4]) {
        realtimeChart.data.datasets[4].data.push(state.telemetry.turbina);
        if (realtimeChart.data.datasets[4].data.length > MAX_POINTS) {
            realtimeChart.data.datasets[4].data.shift();
        }
    }

    realtimeChart.update('none'); // Update rápido sem travamento
}

// Configuração dos controles de abas do gráfico (Temperatura, Pressão, etc.)
function initChartControls() {
    const tabs = document.querySelectorAll('.btn-chart-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const metric = tab.getAttribute('data-metric');
            state.currentMetric = metric;
            applyMetricFilter(metric);
        });
    });

    // Botão Pausar / Retomar
    const pauseBtn = document.getElementById('btn-chart-pause');
    if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
            state.chartPaused = !state.chartPaused;
            if (state.chartPaused) {
                pauseBtn.textContent = '▶️ Retomar';
                pauseBtn.style.borderColor = 'var(--accent-green)';
                pauseBtn.style.color = 'var(--accent-green)';
                showToast('Gráfico Pausado', 'A coleta gráfica em tela foi temporariamente congelada.', 'info');
            } else {
                pauseBtn.textContent = '⏸️ Pausar';
                pauseBtn.style.borderColor = '';
                pauseBtn.style.color = '';
                showToast('Gráfico Retomado', 'A plotagem em tempo real foi restaurada.', 'success');
            }
        });
    }

    // Botão Limpar
    const clearBtn = document.getElementById('btn-chart-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (realtimeChart) {
                realtimeChart.data.labels = [];
                realtimeChart.data.datasets.forEach(ds => ds.data = []);
                realtimeChart.update();
                state.pointsCollected = 0;
                const pointsCountEl = document.getElementById('chart-points-count');
                if (pointsCountEl) pointsCountEl.textContent = '0';
                showToast('Histórico Limpo', 'Os pontos do gráfico foram resetados.', 'info');
            }
        });
    }

    // Botão Exportar CSV
    const exportBtn = document.getElementById('btn-chart-export');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            if (!realtimeChart || realtimeChart.data.labels.length === 0) {
                showToast('Aviso', 'Nenhuma amostra disponível para exportar no momento.', 'warning');
                return;
            }

            let csv = 'Timestamp,Temperatura_C,Pressao_bar,Radiacao_uSvh,Potencia_MW\n';
            const labels = realtimeChart.data.labels;
            const dsTemp = realtimeChart.data.datasets[0].data;
            const dsPress = realtimeChart.data.datasets[1].data;
            const dsRad = realtimeChart.data.datasets[2].data;
            const dsPower = realtimeChart.data.datasets[3].data;

            for (let i = 0; i < labels.length; i++) {
                csv += `"${labels[i]}",${dsTemp[i] || 0},${dsPress[i] || 0},${dsRad[i] || 0},${dsPower[i] || 0}\n`;
            }

            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `telemetria_angra3_${Date.now()}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showToast('Download Concluído', 'Arquivo CSV de telemetria gerado com sucesso!', 'success');
            playFeedbackTone(880, 0.15, 'sine');
        });
    }
}

// Emissor de áudio sintetizado para feedbacks operacionais (Web Audio API)
function playFeedbackTone(freq = 440, duration = 0.2, type = 'sine') {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
    } catch (e) {
        // Áudio silenciado ou desabilitado pelo navegador
    }
}

// Alterna visibilidade dos datasets no Chart.js de acordo com a aba selecionada
function applyMetricFilter(metric) {
    if (!realtimeChart) return;

    if (metric === 'combinado') {
        // Exibe todos os dados
        realtimeChart.data.datasets.forEach(ds => ds.hidden = false);
    } else {
        realtimeChart.data.datasets[0].hidden = (metric !== 'temperatura');
        realtimeChart.data.datasets[1].hidden = (metric !== 'pressao');
        realtimeChart.data.datasets[2].hidden = (metric !== 'radiacao');
        realtimeChart.data.datasets[3].hidden = (metric !== 'potencia');
        if (realtimeChart.data.datasets[4]) {
            realtimeChart.data.datasets[4].hidden = (metric !== 'turbina');
        }
    }

    realtimeChart.update();
}

// ====================================================================
// 5. PROGRAMAÇÃO DOS BOTÕES & AÇÕES CRÍTICAS
// ====================================================================
function initButtons() {
    // 1. Botão SCRAM (Desligamento de Emergência)
    const btnScram = document.getElementById('btn-scram');
    if (btnScram) {
        btnScram.addEventListener('click', () => {
            const confirmed = confirm('⚠️ ATENÇÃO OPERADOR:\nTem certeza que deseja acionar o SCRAM imediato do reator?\nTodas as barras de controle serão totalmente inseridas!');
            if (confirmed) {
                executarFeedbackScram(true);
            }
        });
    }

    // 2. Desligamento Controlado
    const btnShutdown = document.getElementById('btn-controlled-shutdown');
    if (btnShutdown) {
        btnShutdown.addEventListener('click', () => {
            if (state.isScram || state.isShuttingDown) {
                showToast('Aviso', 'Procedimento de desligamento já em andamento!', 'warning');
                return;
            }
            executarDesligamentoControlado();
        });
    }

    // 3. Testar Sistemas de Segurança
    const btnTest = document.getElementById('btn-test-systems');
    if (btnTest) {
        btnTest.addEventListener('click', () => {
            executarTesteSistemas();
        });
    }

    // 4. Silenciar Alarmes
    const btnSilence = document.getElementById('btn-silence-alarm');
    if (btnSilence) {
        btnSilence.addEventListener('click', () => {
            executarSilenciarAlarmes();
        });
    }
}

// Execução de Parada de Emergência SCRAM
function executarFeedbackScram(publicarMqtt) {
    state.isScram = true;

    // Atualização visual do Header Badge
    const badge = document.getElementById('reactor-status-badge');
    if (badge) {
        badge.querySelector('.status-text').textContent = 'SCRAM ATIVADO';
        const dot = badge.querySelector('.status-dot');
        dot.className = 'status-dot pulse-danger';
    }

    // Zera potência e turbina
    state.telemetry.potencia = 0;
    state.telemetry.turbina = 0;
    updateTelemetryCards();

    // Trava de segurança fechada
    updateSmartLockUI(false, 'SCRAM de Emergência');

    // Insere todas as barras de controle em 100%
    document.querySelectorAll('.control-slider').forEach(slider => {
        slider.value = 100;
        const disp = slider.previousElementSibling?.querySelector('.slider-value');
        if (disp) disp.textContent = '100%';
    });

    // Feedback sonoro/visual
    showToast('SCRAM ATIVADO!', 'Desligamento de emergência executado com sucesso.', 'danger');
    addAlertLog('CRÍTICO', 'SCRAM EXECUTADO — Hastes de absorção totalmente inseridas. Reator seguro em parada fria.');
    playFeedbackTone(220, 0.7, 'sawtooth');

    // Envia comando MQTT para o ESP32 em Wokwi
    if (publicarMqtt && mqttClient && state.mqttConnected) {
        mqttClient.publish(MQTT_CONFIG.topics.commandsPrefix + 'scram', '1');
        mqttClient.publish(MQTT_CONFIG.topics.reactorStatus, 'SCRAM', { retain: true });
        console.log('[MQTT TX] Comando SCRAM enviado ao Broker HiveMQ.');
    }
}

// Execução de Desligamento Controlado
function executarDesligamentoControlado() {
    state.isShuttingDown = true;
    showToast('Desligamento Controlado', 'Iniciando redução progressiva da geração...', 'info');
    addAlertLog('AVISO', 'Desligamento controlado do reator solicitado pelo operador.');

    const badge = document.getElementById('reactor-status-badge');
    if (badge) {
        badge.querySelector('.status-text').textContent = 'DESLIGANDO...';
        badge.querySelector('.status-dot').className = 'status-dot pulse-warning';
    }

    // Envia MQTT
    if (mqttClient && state.mqttConnected) {
        mqttClient.publish(MQTT_CONFIG.topics.commandsPrefix + 'shutdown', '1');
    }

    // Animação progressiva de decaimento de potência e temperatura
    let passos = 10;
    const interval = setInterval(() => {
        passos--;
        state.telemetry.potencia = Math.max(0, state.telemetry.potencia - 140);
        state.telemetry.temperatura = Math.max(120, state.telemetry.temperatura - 20);
        updateTelemetryCards();

        if (passos <= 0) {
            clearInterval(interval);
            state.isShuttingDown = false;
            if (badge) badge.querySelector('.status-text').textContent = 'REATOR DESLIGADO';
            showToast('Concluído', 'Reator em regime de desligamento controlado.', 'success');
            addAlertLog('OK', 'Desligamento controlado concluído. Parâmetros estabilizados.');
        }
    }, 800);
}

// Execução do Teste de Sistemas de Segurança
function executarTesteSistemas() {
    const items = document.querySelectorAll('.system-item');
    showToast('Diagnóstico Iniciado', 'Iniciando varredura automatizada nos 8 subsistemas...', 'info');
    addAlertLog('INFO', 'Rotina de autoteste dos sistemas de segurança iniciada.');

    if (mqttClient && state.mqttConnected) {
        mqttClient.publish(MQTT_CONFIG.topics.commandsPrefix + 'teste', 'start');
    }

    items.forEach((item, index) => {
        setTimeout(() => {
            const statusSpan = item.querySelector('.system-status');
            const originalText = statusSpan.textContent;
            item.classList.add('testing');
            statusSpan.textContent = 'TESTANDO...';

            setTimeout(() => {
                item.classList.remove('testing');
                statusSpan.textContent = '100% NOMINAL';
                item.style.borderColor = 'var(--accent-green)';
                playFeedbackTone(587.33, 0.08, 'sine');

                setTimeout(() => {
                    statusSpan.textContent = originalText;
                    item.style.borderColor = '';
                }, 3000);
            }, 600);
        }, index * 250);
    });

    setTimeout(() => {
        showToast('Diagnóstico Concluído', 'Todos os 8 sistemas responderam normalmente.', 'success');
        addAlertLog('OK', 'Teste de integridade dos sistemas concluído com 100% de aprovação.');
    }, items.length * 250 + 700);
}

// Silenciar Alarmes
function executarSilenciarAlarmes() {
    const alerts = document.querySelectorAll('.alert-item.alert-critical, .alert-item.alert-warning');
    alerts.forEach(a => a.style.animation = 'none');

    showToast('Alarmes Silenciados', 'Sinalizadores sonoros e visuais silenciados pelo operador.', 'info');
    addAlertLog('INFO', 'Alarmes de alerta colocados em estado silenciado pelo console.');

    if (mqttClient && state.mqttConnected) {
        mqttClient.publish(MQTT_CONFIG.topics.commandsPrefix + 'silenciar', '1');
    }
}

// ====================================================================
// 6. INTEGRAÇÃO DA FECHADURA INTELIGENTE & TRAVA IOT (ATIVIDADE 07)
// ====================================================================
function initSmartLock() {
    const btnUnlock = document.getElementById('btn-unlock-smartlock');
    const btnLock = document.getElementById('btn-lock-smartlock');

    if (btnUnlock) {
        btnUnlock.addEventListener('click', () => {
            if (state.isScram) {
                showToast('Bloqueio Crítico', 'Não é possível destravar durante o modo SCRAM!', 'danger');
                return;
            }

            // Atualiza UI
            updateSmartLockUI(true, 'Comando Web Nuvem');

            // Envia comando MQTT para o Broker HiveMQ (ESP32 Wokwi receberá)
            if (mqttClient && state.mqttConnected) {
                mqttClient.publish(MQTT_CONFIG.topics.commandsPrefix + 'fechadura', '1');
                console.log('[MQTT TX] Comando DESTRAVAR enviado ao HiveMQ.');
            }

            showToast('Destravamento Remoto', 'Comando enviado ao ESP32 via HiveMQ!', 'success');
            addAlertLog('INFO', 'Trava de contenção IoT destravada via comando em nuvem.');
            playFeedbackTone(659.25, 0.15, 'triangle');

            // Timer de 5s para fechamento automático igual no Wokwi
            startSmartLockAutoCloseTimer();
        });
    }

    if (btnLock) {
        btnLock.addEventListener('click', () => {
            if (state.autoCloseTimer) clearTimeout(state.autoCloseTimer);

            updateSmartLockUI(false, 'Comando Web Nuvem');

            if (mqttClient && state.mqttConnected) {
                mqttClient.publish(MQTT_CONFIG.topics.commandsPrefix + 'fechadura', '0');
                console.log('[MQTT TX] Comando TRAVAR enviado ao HiveMQ.');
            }

            showToast('Trava Fechada', 'Trava de contenção bloqueada com sucesso.', 'info');
            playFeedbackTone(329.63, 0.2, 'triangle');
        });
    }
}

// Atualiza a representação gráfica do Smart Lock (Servo, LEDs e Estado)
function updateSmartLockUI(unlocked, sourceName) {
    state.telemetry.trava = unlocked ? 1 : 0;
    state.telemetry.servo = unlocked ? 90 : 0;

    const card = document.getElementById('lock-visual-card');
    const symbol = document.getElementById('lock-icon-symbol');
    const statusText = document.getElementById('lock-status-text');
    const sourceEl = document.getElementById('lock-last-source');
    const angleText = document.getElementById('servo-angle-text');
    const gaugeFill = document.getElementById('servo-gauge-fill');
    const ledRed = document.getElementById('led-red-light');
    const ledGreen = document.getElementById('led-green-light');

    if (!card || !statusText) return;

    if (unlocked) {
        card.classList.add('unlocked');
        symbol.textContent = '🔓';
        statusText.textContent = 'DESTRAVADA (90°)';
        statusText.classList.add('status-unlocked');
        if (angleText) angleText.textContent = '90° (Aberto)';
        if (gaugeFill) gaugeFill.style.width = '100%';
        if (ledRed) ledRed.classList.remove('active');
        if (ledGreen) ledGreen.classList.add('active');
    } else {
        card.classList.remove('unlocked');
        symbol.textContent = '🔒';
        statusText.textContent = 'TRAVADA (0°)';
        statusText.classList.remove('status-unlocked');
        if (angleText) angleText.textContent = '0° (Fechado)';
        if (gaugeFill) gaugeFill.style.width = '0%';
        if (ledRed) ledRed.classList.add('active');
        if (ledGreen) ledGreen.classList.remove('active');
    }

    if (sourceEl && sourceName) {
        sourceEl.textContent = `Origem: ${sourceName}`;
    }
}

// Temporizador automático de 5 segundos para re-bloqueio
function startSmartLockAutoCloseTimer() {
    if (state.autoCloseTimer) clearTimeout(state.autoCloseTimer);

    let secondsLeft = 5;
    const sourceEl = document.getElementById('lock-last-source');

    const updateCountdown = () => {
        if (sourceEl && state.telemetry.trava === 1) {
            sourceEl.textContent = `Fechamento automático em ${secondsLeft}s...`;
        }
    };

    updateCountdown();

    const interval = setInterval(() => {
        secondsLeft--;
        if (secondsLeft > 0) {
            updateCountdown();
        } else {
            clearInterval(interval);
            updateSmartLockUI(false, 'Fechamento Automático (5s)');
            addAlertLog('INFO', 'Trava de contenção fechada automaticamente após 5 segundos.');
        }
    }, 1000);

    state.autoCloseTimer = interval;
}

// ====================================================================
// 7. PROGRAMAÇÃO DE SLIDERS E TOGGLES DE BOMBAS
// ====================================================================
function initSliders() {
    document.querySelectorAll('.control-slider').forEach(slider => {
        const valueDisplay = slider.previousElementSibling?.querySelector('.slider-value');
        
        slider.addEventListener('input', () => {
            const val = slider.value;
            if (valueDisplay) valueDisplay.textContent = val + '%';

            // Publica via MQTT se conectado
            if (mqttClient && state.mqttConnected) {
                mqttClient.publish(`${MQTT_CONFIG.topics.commandsPrefix}barras/${slider.id}`, val);
            }

            // Simula impacto sutil das barras na potência
            if (!state.isScram) {
                const mediaBarras = Array.from(document.querySelectorAll('.control-slider'))
                    .reduce((acc, s) => acc + Number(s.value), 0) / 4;
                state.telemetry.potencia = Math.round(1510 * (1 - (mediaBarras / 150)));
                updateTelemetryCards();
            }
        });
    });
}

function initPumpToggles() {
    const pumpCheckboxes = document.querySelectorAll('.toggle-switch input[type="checkbox"]');
    pumpCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            const label = checkbox.getAttribute('aria-label') || checkbox.id;
            const isOn = checkbox.checked;

            showToast('Comando de Bomba', `${label}: ${isOn ? 'LIGADA' : 'DESLIGADA'}`, isOn ? 'success' : 'warning');
            addAlertLog('INFO', `Alteração de estado: ${label} -> ${isOn ? 'ATIVO' : 'INATIVO'}.`);

            if (mqttClient && state.mqttConnected) {
                mqttClient.publish(`${MQTT_CONFIG.topics.commandsPrefix}bomba/${checkbox.id}`, isOn ? '1' : '0');
            }
        });
    });
}

// ====================================================================
// 8. FEEDBACKS VISUAIS: TOASTS & LOG DE ALERTAS
// ====================================================================
function showToast(title, message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
        success: '✅',
        danger: '⚠️',
        warning: '⚡',
        info: 'ℹ️'
    };

    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
    `;

    container.appendChild(toast);

    // Remove automaticamente após 3.8s
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 350);
    }, 3800);
}

function addAlertLog(tag, message) {
    const alertsContainer = document.getElementById('alerts-log');
    if (!alertsContainer) return;

    const now = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    const tagClassMap = {
        'CRÍTICO': 'tag-critical alert-critical',
        'AVISO': 'tag-warning alert-warning',
        'OK': 'tag-success alert-success',
        'INFO': 'tag-info alert-info'
    };

    const itemClass = tagClassMap[tag] || 'tag-info alert-info';
    const parts = itemClass.split(' ');

    const alertEl = document.createElement('div');
    alertEl.className = `alert-item ${parts[1] || 'alert-info'}`;
    alertEl.style.animation = 'slideIn 0.3s ease-out';
    alertEl.innerHTML = `
        <time class="alert-time">${now}</time>
        <span class="alert-tag ${parts[0] || 'tag-info'}">${tag}</span>
        <p class="alert-message">${message}</p>
    `;

    alertsContainer.insertBefore(alertEl, alertsContainer.firstChild);

    // Mantém no máximo 15 alertas em tela
    while (alertsContainer.children.length > 15) {
        alertsContainer.removeChild(alertsContainer.lastChild);
    }
}

// ====================================================================
// 9. RELÓGIO & NAVEGAÇÃO
// ====================================================================
function initClock() {
    function update() {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('pt-BR', { hour12: false });
        const clockEl = document.getElementById('header-clock');
        if (clockEl) {
            clockEl.textContent = timeStr;
            clockEl.setAttribute('datetime', now.toISOString());
        }
    }
    setInterval(update, 1000);
    update();
}

function initSmoothNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            const target = document.querySelector(link.getAttribute('href'));
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
}

// ====================================================================
// 10. SIMULADOR AUTÔNOMO (GARANTE DADOS VIVOS MESMO SEM WOKWI ATIVO)
// ====================================================================
function startAutonomousTelemetry() {
    setInterval(() => {
        // Se o reator estiver em modo SCRAM, reduz temperatura gradualmente
        if (state.isScram) {
            state.telemetry.temperatura = Math.max(70, state.telemetry.temperatura - 1.5);
            state.telemetry.pressao = Math.max(30, state.telemetry.pressao - 1.0);
            state.telemetry.radiacao = 0.05;
        } else if (!state.isShuttingDown) {
            // Flutuações físicas normais
            const rand = (min, max) => (Math.random() * (max - min) + min);
            state.telemetry.temperatura = 327 + rand(-2.5, 2.5);
            state.telemetry.pressao = 155 + rand(-1.2, 1.2);
            state.telemetry.radiacao = 0.12 + rand(-0.015, 0.015);
        }

        updateTelemetryCards();
        pushDataToChart();

        // Opcional: Se conectado ao MQTT e não houver publisher externo, publica telemetria simulada
        if (mqttClient && state.mqttConnected && !state.isScram) {
            const payload = JSON.stringify({
                temperatura: parseFloat(state.telemetry.temperatura.toFixed(1)),
                pressao: parseFloat(state.telemetry.pressao.toFixed(1)),
                potencia: Math.round(state.telemetry.potencia),
                radiacao: parseFloat(state.telemetry.radiacao.toFixed(2)),
                trava: state.telemetry.trava
            });
            // Publica em canal de telemetria para sincronizar outras abas se abertas
            mqttClient.publish(MQTT_CONFIG.topics.telemetry, payload);
        }
    }, 2000);
}

