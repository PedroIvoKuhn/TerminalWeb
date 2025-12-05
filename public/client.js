const socket = io();

// --- Elementos da Página ---
const setupContainer = document.getElementById('setup-container');
const terminalContainer = document.getElementById('terminal-container');
const setupForm = document.getElementById('setup-form');
const numMachinesInput = document.getElementById('num-machines');

// --- Configuração do Terminal ---
const term = new Terminal({
    cursorBlink: true,
    theme: {
        background: '#1e1e1e'
    }
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

// --- Lógica de Inicialização ---
function initializeTerminal() {
    setupContainer.style.display = 'none';
    terminalContainer.style.display = 'block';

    term.open(document.getElementById('terminal'));
    fitAddon.fit();
    window.addEventListener('resize', () => fitAddon.fit());
}

// Lida com o envio do formulário de configuração inicial
setupForm.addEventListener('submit', (e) => {
    e.preventDefault(); 
    const numMachines = parseInt(numMachinesInput.value, 10);
    const mpiImage = document.querySelector('meta[name="mpi-image"]').getAttribute('content');

    if (numMachines > 0) {
        socket.emit('start-session', { numMachines: numMachines, mpiImage: mpiImage });
        initializeTerminal();
    }
});

// --- Lógica de Interação com o Terminal (Pós-inicialização) ---
term.onData(data => {
    socket.emit('input', data);
});

socket.on('output', data => {
    term.write(data);
});

socket.on('session-ready', (data) => {
    const machineList = document.getElementById('machine-list');
    machineList.innerHTML = '';

    data.aliases.forEach(alias => {
        const listItem = document.createElement('li');
        listItem.textContent = alias;
        machineList.appendChild(listItem);
    });
});

socket.on('connect_error', (err) => {
    console.error(`Erro de conexão: ${err.message}`);
    term.write(`\r\n[ERRO DE CONEXÃO]: ${err.message}`);
});

let countdownInterval;
const timerBar = document.getElementById('timer-bar');
const countdownDisplay = document.getElementById('countdown-display');
const sessionModal = document.getElementById('session-modal');

// Função para formatar milissegundos em HH:MM:SS
function formatTime(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000).toString().padStart(2, '0');
    const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, '0');
    const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function startCountdown(expiresAt) {
    // Mostra a barra
    timerBar.style.display = 'flex';
    timerBar.classList.remove('timer-critical'); // Remove alerta vermelho se houver

    // Limpa timer anterior se existir (caso seja uma extensão)
    if (countdownInterval) clearInterval(countdownInterval);

    countdownInterval = setInterval(() => {
        const now = Date.now();
        const timeLeft = expiresAt - now;

        // Atualiza o texto
        countdownDisplay.textContent = formatTime(timeLeft);

        // Se faltar menos de 20 minutos (ou o tempo do aviso), deixa vermelho
        // Ex: 20 minutos = 1200000 ms
        if (timeLeft < 1200000) { 
            timerBar.classList.add('timer-critical');
        } else {
            timerBar.classList.remove('timer-critical');
        }

        // Se o tempo acabar
        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            countdownDisplay.textContent = "00:00:00";
        }
    }, 1000);
}

// --- EVENTOS DO SOCKET ---

// 1. Recebe a data de expiração (no início ou na extensão)
socket.on('session:update', (data) => {
    startCountdown(data.expiresAt);
    // Esconde o modal se ele estiver aberto (no caso de extensão)
    sessionModal.style.display = 'none';
});

// 2. Recebe o aviso do servidor (para abrir o modal)
socket.on('session:warning', () => {
    sessionModal.style.display = 'flex'; // Abre o modal perguntando
});

// 3. Se a sessão morrer
socket.on('session:expired', (msg) => {
    clearInterval(countdownInterval);
    timerBar.style.display = 'none';
    alert(msg);
    window.location.reload();
});

// --- BOTÕES DO MODAL ---

document.getElementById('btn-extend').addEventListener('click', () => {
    socket.emit('session:extend-response'); // Pede mais tempo
    // O modal só vai fechar quando o servidor responder com 'session:update'
    // Para dar feedback visual imediato:
    document.querySelector('#session-modal h2').textContent = "Estendendo...";
});

document.getElementById('btn-ignore').addEventListener('click', () => {
    sessionModal.style.display = 'none'; // Só fecha a janela, o tempo continua correndo para o fim
});