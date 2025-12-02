const socket = io();

// --- Elementos da Página ---
const setupContainer = document.getElementById('setup-container');
const terminalContainer = document.getElementById('terminal-container');
const setupForm = document.getElementById('setup-form');
const numMachinesInput = document.getElementById('num-machines');

let myMasterPodName = null;
const currentUserId = 'devUser'; // Em produção viria do LTI
const selectBackup = document.getElementById('select-backup');

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

async function preencherDropdownBackups() {
    try {
        const res = await fetch(`/api/backups?userId=${currentUserId}`);
        const arquivos = await res.json();
        
        arquivos.forEach(arq => {
            const option = document.createElement('option');
            // O nome vem como "aluno_xyz/trabalho.tar.gz". Pegamos só o final.
            const nomeLimpo = arq.name.split('/')[1]; 
            option.value = nomeLimpo; 
            option.textContent = `📂 ${nomeLimpo} (${(arq.size/1024/1024).toFixed(2)} MB)`;
            selectBackup.appendChild(option);
        });
    } catch (e) {
        console.error("Erro ao carregar backups para o menu", e);
    }
}

preencherDropdownBackups();

// Lida com o envio do formulário de configuração inicial
setupForm.addEventListener('submit', (e) => {
    e.preventDefault(); 
    const numMachines = parseInt(numMachinesInput.value, 10);
    const mpiImage = document.querySelector('meta[name="mpi-image"]').getAttribute('content');
    const backupName = selectBackup.value;

    if (numMachines > 0) {
        // Enviar userId e backupName junto com o pedido de inicio
        socket.emit('start-session', { 
            numMachines, 
            mpiImage, 
            userId: currentUserId, // Importante mandar o ID
            backupName: backupName // O arquivo escolhido (ou vazio)
        });
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

    //Pega o nome do pod mestre e mostra a tela de backup
    if (data.masterPodName) {
        console.log("Pod Mestre identificado:", data.masterPodName);
        myMasterPodName = data.masterPodName;
        
        // Torna a div visível
        const backupUi = document.getElementById('backup-ui');
        if(backupUi) {
            backupUi.style.display = 'block';
            carregarBackups(); // Chama a função para listar o que já existe
        }
    }
});

socket.on('connect_error', (err) => {
    console.error(`Erro de conexão: ${err.message}`);
    term.write(`\r\n[ERRO DE CONEXÃO]: ${err.message}`);
});

// --- LÓGICA DE BACKUP (Cole isso no final do arquivo) ---

async function carregarBackups() {
    const lista = document.getElementById('lista-backups');
    const status = document.getElementById('status-cota');
    if(!lista) return;

    lista.innerHTML = 'Carregando...';

    try {
        const res = await fetch(`/api/backups?userId=${currentUserId}`);
        const arquivos = await res.json();
        
        lista.innerHTML = '';
        let totalSize = 0;

        arquivos.forEach(arq => {
            totalSize += arq.size;
            const li = document.createElement('li');
            li.style.display = 'flex'; 
            li.style.justifyContent = 'space-between';
            li.style.marginBottom = '5px';
            li.style.background = '#444';
            li.style.padding = '5px';
            
            li.innerHTML = `
                <span>${arq.name.split('/')[1]} <small>(${(arq.size/1024/1024).toFixed(2)} MB)</small></span>
                <button onclick="deletar('${arq.name}')" style="background:#dc3545; color:white; border:none; cursor:pointer; padding: 2px 8px;">X</button>
            `;
            lista.appendChild(li);
        });
        
        if(status) status.innerText = `Uso: ${(totalSize/1024/1024).toFixed(2)} / 100 MB`;
    } catch (e) {
        console.error("Erro listando backups", e);
        lista.innerHTML = 'Erro ao carregar lista.';
    }
}

// Botão Salvar
const btnSalvar = document.getElementById('btn-salvar');
if(btnSalvar) {
    btnSalvar.addEventListener('click', async () => {
        const nomeInput = document.getElementById('nome-backup');
        const nome = nomeInput.value;
        
        if(!nome || !myMasterPodName) return alert('Erro: Nome vazio ou pod não conectado.');

        btnSalvar.innerText = 'Salvando...';
        btnSalvar.disabled = true;
        
        try {
            const res = await fetch('/api/backups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUserId, podName: myMasterPodName, nomeArquivo: nome })
            });
            
            const json = await res.json();
            
            if(json.error) alert('Erro: ' + json.error);
            else {
                alert('Salvo com sucesso!');
                carregarBackups();
                nomeInput.value = ''; // Limpa o campo
            }
        } catch(e) {
            alert('Erro de conexão ao salvar.');
        }

        btnSalvar.innerText = 'Salvar Agora';
        btnSalvar.disabled = false;
    });
}

// Função global para deletar
window.deletar = async (nome) => {
    if(!confirm('Apagar este backup?')) return;
    await fetch('/api/backups', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, nomeCompleto: nome })
    });
    carregarBackups();
};