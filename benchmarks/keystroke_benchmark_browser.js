// ==============================================================================
// Benchmark de Latência de Digitação (QoE) - TerminalWeb
// Execute este código diretamente no Console do Navegador (F12) com o terminal aberto.
// ==============================================================================

(function runKeystrokeBenchmark() {
    const TOTAL_SAMPLES = 50;
    const rtts = [];
    let sentCount = 0;
    let lastSendTime = 0;
    let isRunning = true;

    console.log(`%c[BENCHMARK QoE] Iniciando medição de latência de eco (${TOTAL_SAMPLES} amostras)...`, "color: #0284c7; font-weight: bold;");

    function sendKeystroke() {
        if (sentCount >= TOTAL_SAMPLES) {
            summarize();
            return;
        }
        sentCount++;
        lastSendTime = performance.now();
        // Envia um caractere Enter para medir o round-trip de resposta do shell/pty
        socket.emit('input', '\n');
    }

    function onOutput() {
        if (lastSendTime > 0 && isRunning) {
            const rtt = performance.now() - lastSendTime;
            rtts.push(rtt);
            lastSendTime = 0;
            if (sentCount < TOTAL_SAMPLES) {
                setTimeout(sendKeystroke, 80); // Intervalo simulando digitação humana
            } else {
                summarize();
            }
        }
    }

    socket.on('output', onOutput);

    function summarize() {
        isRunning = false;
        socket.off('output', onOutput);

        const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
        const min = Math.min(...rtts);
        const max = Math.max(...rtts);
        const sorted = [...rtts].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)];

        console.log(`%c=== RESULTADOS DE LATÊNCIA DO TERMINAL (QoE) ===`, "color: #16a34a; font-weight: bold; font-size: 14px;");
        console.table({
            "Amostras": rtts.length,
            "Média (ms)": avg.toFixed(2),
            "Mínima (ms)": min.toFixed(2),
            "P95 (ms)": p95.toFixed(2),
            "Máxima (ms)": max.toFixed(2),
            "Abaixo do Limiar Humano (<150ms)?": avg < 150 ? "SIM (Fluido)" : "NÃO"
        });
    }

    sendKeystroke();
})();

