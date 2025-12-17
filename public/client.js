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