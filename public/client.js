const socket = io();

// --- Elementos da Página ---
const setupContainer = document.getElementById('setup-container');
const terminalContainer = document.getElementById('terminal-container');
const setupForm = document.getElementById('setup-form');
const numMachinesInput = document.getElementById('num-machines');

let myMasterPodName = null;
let currentLoadedBackup = null;
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
        
        // Limpa antes de preencher para não duplicar se chamar de novo
        selectBackup.innerHTML = '<option value="">-- Começar do Zero (Vazio) --</option>';

        arquivos.forEach(arq => {
            const option = document.createElement('option');
            // O nome vem como "aluno_xyz/trabalho.tar.gz". Pegamos só o final.
            const nomeLimpo = arq.name.split('/')[1].replace('.tar.gz', '');
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
    
    // Define o backup atual ao iniciar
    currentLoadedBackup = backupName || null;

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

// --- LÓGICA DE BACKUP ---

async function carregarBackups() {
    const lista = document.getElementById('lista-backups');
    const status = document.getElementById('status-cota');
    if(!lista) return;

    lista.innerHTML = 'Carregando...';

    // Atualiza o dropdown também para manter a lista de verificação sincronizada
    await preencherDropdownBackups();

    try {
        const res = await fetch(`/api/backups?userId=${currentUserId}`);
        const arquivos = await res.json();
        
        lista.innerHTML = '';
        let totalSize = 0;

        arquivos.forEach(arq => {
            totalSize += arq.size;

            // O nome para salvar/deletar
            const nomeParaSalvar = arq.name.split('/')[1].replace('.tar.gz', '');

            const isAtual = (nomeParaSalvar === currentLoadedBackup);

            const li = document.createElement('li');
            li.style.display = 'flex'; 
            li.style.justifyContent = 'space-between';
            li.style.marginBottom = '5px';
            li.style.padding = '8px';
            li.style.borderRadius = '4px';
            
            // Destaque visual se for o atual
            if (isAtual) {
                li.style.background = 'rgba(40, 167, 69, 0.2)'; 
                li.style.border = '1px solid #28a745';
            }
            
            // Botão condicional: Salvar (se for atual) ou Abrir (se for outro)
            let botaoAcao = '';
            if (isAtual) {
                 botaoAcao = `<button onclick="salvarArquivo('${nomeParaSalvar}')" style="background:#28a745; color:white; border:none; cursor:pointer; padding: 2px 8px; margin-right:5px;">💾 Salvar</button>`;
            }

            li.innerHTML = `
                <span style="${isAtual ? 'font-weight:bold' : ''}">${nomeParaSalvar} <small>(${(arq.size/1024/1024).toFixed(2)} MB)</small></span>
                <div>
                    ${botaoAcao}
                    <button onclick="deletar('${arq.name}')" style="background:#dc3545; color:white; border:none; cursor:pointer; padding: 2px 8px;">X</button>
                </div>
            `;
            lista.appendChild(li);
        });
        
        if(status) status.innerText = `Uso: ${(totalSize/1024/1024).toFixed(2)} / 100 MB`;
    } catch (e) {
        console.error("Erro listando backups", e);
        lista.innerHTML = 'Erro ao carregar lista.';
    }
}

// --- FUNÇÃO DE SALVAR GLOBAL ---
window.salvarArquivo = async function(nomeAlvo) {
    if(!myMasterPodName) return alert('Erro: Pod não conectado.');
    
    try {
        const res = await fetch('/api/backups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                userId: currentUserId, 
                podName: myMasterPodName, 
                nomeArquivo: nomeAlvo 
            })
        });
        
        const json = await res.json();
        
        if(json.error) alert('Erro: ' + json.error);
        else {
            alert('Salvo com sucesso!');
            
            // 1. Atualiza a variável local para saber que estamos neste arquivo
            currentLoadedBackup = nomeAlvo;
            
            // 2. Avisa o servidor
            socket.emit('update-active-backup', nomeAlvo);

            // 3. Atualiza a lista visualmente
            carregarBackups();
            
            // 4. Limpa o campo de texto se tiver algo escrito
            const inputNovo = document.getElementById('nome-backup');
            if(inputNovo) inputNovo.value = '';
        }
    } catch(e) { 
        alert('Erro de conexão ao salvar.'); 
    }
};

// --- CONFIGURAÇÃO DO BOTÃO "SALVAR NOVO" ---
const btnSalvarNovo = document.getElementById('btn-salvar-novo');

if(btnSalvarNovo) {
    btnSalvarNovo.addEventListener('click', () => {
        let nome = document.getElementById('nome-backup').value;
        
        if(!nome) return alert("Digite um nome para o novo arquivo.");
        
        nome = nome.trim(); // Limpa espaços

        // Varre o dropdown para ver se esse nome já existe
        const jaExiste = Array.from(selectBackup.options).some(o => o.value === nome);

        if (jaExiste) {
            // Se já existe, interrompe tudo e pede confirmação explícita
            const confirmar = confirm(`O arquivo "${nome}" JÁ EXISTE!\n\nSe você continuar, o conteúdo antigo será APAGADO e substituído pelo atual.\n\nDeseja SOBRESCREVER?`);
            
            if (!confirmar) return; // Se cancelar, para aqui. Não salva nada.
        }

        // Se não existe (ou se o usuário confirmou que quer sobrescrever), chama o salvar
        window.salvarArquivo(nome);
    });
}

// --- FUNÇÃo RESTAURAR ---
window.restaurar = async (nome) => {
    if(!confirm(`Carregar conteúdo de "${nome}"? Isso mistura com os arquivos atuais.`)) return;
    
    try {
        const res = await fetch('/api/backups/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUserId, podName: myMasterPodName, nomeArquivo: nome })
        });
        const json = await res.json();
        if(json.error) alert(json.error);
        else {
            alert("Conteúdo adicionado!");
            socket.emit('input', 'ls -la\r'); // Força um ls no terminal
        }
    } catch(e) { alert("Erro ao restaurar."); }
};

// Função global para deletar
window.deletar = async (nome) => {
    if(!confirm('Apagar este backup?')) return;
    await fetch('/api/backups', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, nomeCompleto: nome })
    });
    
    // Se apagou o arquivo que estava aberto, reseta o estado
    const nomeLimpo = nome.split('/')[1].replace('.tar.gz', '');
    if(nomeLimpo === currentLoadedBackup) {
        currentLoadedBackup = null;
    }

    carregarBackups();
};