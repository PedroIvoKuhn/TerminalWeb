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
    const image = document.querySelector('meta[name="image"]').getAttribute('content');

    if (numMachines > 0) {
        socket.emit('start-session', { numMachines: numMachines, image: image });
        initializeTerminal();
    }
});

// --- Lógica de Interação com o Terminal ---
term.onData(data => {
    socket.emit('input', data);
});

socket.on('output', data => {
    term.write(data);
});

socket.on('session-ready', (data) => {
    const machineList = document.getElementById('machine-list');
    machineList.innerHTML = '';
    localStorage.setItem("jobId", data.jobId);

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
        if ( timeLeft > (1000 * 60 * 60 * 12) ) {
          const btn = document.getElementById('btn-extend-24h')
          if (!btn.disabled) {
            btn.disabled = true;
            btn.title = "Disponível apenas quando faltar menos de 12 horas para encerrar a sessão.";
          } 
        } else {
          const btn = document.getElementById('btn-extend-24h');
          if (btn.disabled && btn.textContent !== "Processando...") {
            btn.disabled = false;
            btn.title = "";
          } 
        }

        // Atualiza o texto
        countdownDisplay.textContent = formatTime(timeLeft);
        const timer = document.getElementById('timer');

        // Se faltar menos de 20 minutos (ou o tempo do aviso), deixa vermelho
        if (timeLeft < 1000 * 60 * 20) { 
            timer.classList.add('timer-critical');
        } else {
            timer.classList.remove('timer-critical');
        }

        // Se o tempo acabar
        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            countdownDisplay.textContent = "00:00:00";
        }
    }, 1000);
}

// --- EVENTOS SOCKET ---

socket.on('session:update', (data) => {
    startCountdown(data.expiresAt);
    setTimeout(() => {
        sessionModal.style.display = 'none';
        const button24h = document.getElementById('btn-extend-24h');
        button24h.textContent = "+24 Horas";
        button24h.disabled = false;

        document.querySelector('#session-modal h2').textContent = "⚠️ A sessão vai expirar!";
        document.getElementById('btn-extend').disabled = false;
        document.getElementById('btn-ignore').disabled = false;
    }, 1500);
});

socket.on('session:warning', () => {
    sessionModal.style.display = 'flex';
});

socket.on('session:expired', () => {
    clearInterval(countdownInterval);
    timerBar.style.display = 'none';
    localStorage.removeItem("jobId");
    document.getElementById('expired-modal').style.display = 'flex';
});

// --- BOTÕES ---

document.getElementById('btn-extend').addEventListener('click', (e) => {
    e.target.disabled = true;
    document.getElementById('btn-ignore').disabled = true;

    document.querySelector('#session-modal h2').textContent = "Estendendo...";
    socket.emit('session:extend-response'); 
});

document.getElementById('btn-ignore').addEventListener('click', () => {
    sessionModal.style.display = 'none';
});

document.getElementById('btn-reload').addEventListener('click', () => {
    window.location.reload();
});

document.getElementById('btn-extend-24h').addEventListener('click', (e) => {
    e.target.disabled = true;
    e.target.textContent = "Processando...";
    socket.emit('session:extend-24h');
});

// --- EVENTOS DA SESSÃO ---
const jobId = localStorage.getItem("jobId");
if(jobId) {
    initializeTerminal();
    socket.emit("restore-session", { jobId });
}

document.getElementById('btn-kill-session').addEventListener('click', () => {
    socket.emit("kill-session");
});
