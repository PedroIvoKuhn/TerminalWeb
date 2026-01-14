const socket = io();

// --- Elementos da Página ---
const setupContainer = document.getElementById('setup-container');
const terminalContainer = document.getElementById('terminal-container');
const setupForm = document.getElementById('setup-form');
const numMachinesInput = document.getElementById('num-machines');

let myMasterPodName = null;
let currentLoadedBackup = null;
const currentUserId = 'devUser';
const selectBackup = document.getElementById('select-backup');

let cacheArquivos = {}; 

// --- Configuração do Terminal ---
const term = new Terminal({
    cursorBlink: true,
    theme: {
        background: '#1e1e1e'
    }
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

// --- 1. LISTAGEM DA TELA INICIAL (COM NAVEGAÇÃO) ---
async function carregarListaDownloads() {
    const listaUl = document.getElementById('download-list');
    const select = document.getElementById('select-backup');
    
    try {
        const res = await fetch(`/api/backups?userId=${currentUserId}`);
        const arquivos = await res.json();

        // 1. Preenche o Dropdown (Select)
        if(select) {
            select.innerHTML = '<option value="">-- Começar do Zero (Vazio) --</option>';
            arquivos.forEach(arq => {
                const nomeRaw = arq.name.split('/')[1];
                if(!nomeRaw) return;
                const nomeLimpo = nomeRaw.replace('.tar.gz', '');
                const option = document.createElement('option');
                option.value = nomeLimpo;
                option.textContent = `📂 ${nomeLimpo}`;
                select.appendChild(option);
            });
            if(currentLoadedBackup) select.value = currentLoadedBackup;
        }

        // 2. Preenche a Lista de Baixo (Downloads + Navegação)
        if (listaUl) {
            listaUl.innerHTML = '';
            
            if (arquivos.length === 0) {
                listaUl.innerHTML = '<li style="color:#777; font-size: 0.9em;">Nenhum arquivo encontrado.</li>';
                return;
            }

            arquivos.forEach(arq => {
                const nomeRaw = arq.name.split('/')[1]; 
                if(!nomeRaw) return;
                const nomeLimpo = nomeRaw.replace('.tar.gz', '');
                const tamanho = (arq.size / 1024 / 1024).toFixed(2);
                const linkDownloadBackup = `/api/download?userId=${currentUserId}&nomeArquivo=${nomeRaw}`;

                const li = document.createElement('li');
                li.style.cssText = "background: #333; margin-bottom: 5px; padding: 10px; border-radius: 4px; border: 1px solid #444;";
                
                li.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight:bold; color:#f1f1f1;">📦 ${nomeLimpo} <small style="color:#aaa; font-weight:normal;">(${tamanho} MB)</small></span>
                        
                        <div>
                            <button onclick="toggleNavegacao('${nomeRaw}', this)" style="background:#17a2b8; color:white; border:none; padding:6px 12px; cursor:pointer; border-radius:4px; font-size: 0.8em; margin-right: 5px;">
                                📂 Navegar
                            </button>

                            <a href="${linkDownloadBackup}" target="_blank" style="text-decoration:none; margin-right: 5px;">
                                <button style="background:#007bff; color:white; border:none; padding:6px 12px; cursor:pointer; border-radius:4px; font-size: 0.8em; font-weight:bold;">
                                    ⬇️ Baixar
                                </button>
                            </a>

                            <button onclick="deletar('${arq.name}')" style="background:#dc3545; color:white; border:none; padding:6px 12px; cursor:pointer; border-radius:4px; font-size: 0.8em;">
                                🗑️ Apagar
                            </button>
                        </div>
                    </div>
                    
                    <div id="tree-container-${nomeLimpo}" style="display:none; margin-top:10px; padding-left:10px; border-left:1px solid #555;">
                        <small style="color:#aaa">Carregando...</small>
                    </div>
                `;
                listaUl.appendChild(li);
            });
        }
    } catch (e) {
        console.error(e);
    }
}

// --- 2. LÓGICA DA ÁRVORE (Tree View) ---
window.toggleNavegacao = async (nomeRawBackup, btn) => {
    const nomeLimpo = nomeRawBackup.replace('.tar.gz', '');
    const container = document.getElementById(`tree-container-${nomeLimpo}`);
    
    if (container.style.display === 'block') {
        container.style.display = 'none';
        btn.innerText = '📂 Navegar';
        return;
    }

    container.style.display = 'block';
    btn.innerText = '📂 Fechar';

    if (cacheArquivos[nomeRawBackup]) {
        desenharArvore(container, cacheArquivos[nomeRawBackup], nomeRawBackup);
        return;
    }

    try {
        const res = await fetch(`/api/backups/content?userId=${currentUserId}&nomeArquivo=${nomeRawBackup}`);
        const files = await res.json();
        
        cacheArquivos[nomeRawBackup] = files;
        desenharArvore(container, files, nomeRawBackup);
    } catch (e) { 
        container.innerHTML = '<span style="color:red">Erro ao carregar arquivos.</span>'; 
    }
};

function desenharArvore(container, todosArquivos, nomeBackup) {
    container.innerHTML = '';
    const listaLimpa = todosArquivos.filter(f => f.name && f.name.trim() !== '');
    
    if (listaLimpa.length === 0) {
        container.innerHTML = '<small style="color:#777">Backup vazio.</small>';
        return;
    }
    container.appendChild(renderizarNivel(listaLimpa, '', nomeBackup));
}

function renderizarNivel(todosArquivos, prefixoAtual, nomeBackup) {
    const ul = document.createElement('ul');
    ul.style.listStyle = 'none';
    ul.style.paddingLeft = '15px';
    ul.style.marginTop = '5px';

    let pastas = new Set();
    let arquivos = [];

    todosArquivos.forEach(file => {
        if (!file.name.startsWith(prefixoAtual)) return;
        
        const relativo = file.name.slice(prefixoAtual.length);
        const partes = relativo.split('/');

        if (partes.length > 1 && partes[0] !== '') {
            pastas.add(partes[0]);
        } else if (partes.length === 1 && partes[0] !== '') {
            if (file.type !== 'directory' && !file.name.endsWith('/')) {
                arquivos.push({ ...file, nomeCurto: partes[0] });
            }
        }
    });

    pastas.forEach(nomePasta => {
        const li = document.createElement('li');
        const novoPrefixo = prefixoAtual + nomePasta + '/';
        const linkZip = `/api/backups/download-folder?userId=${currentUserId}&nomeBackup=${nomeBackup}&folder=${encodeURIComponent(novoPrefixo)}`;

        li.innerHTML = `
            <div style="padding:3px 0; display:flex; justify-content:space-between; align-items:center;">
                <span style="cursor:pointer; color: #f3ff4dff; flex:1;" onclick="this.parentElement.nextElementSibling.style.display = (this.parentElement.nextElementSibling.style.display === 'none' ? 'block' : 'none');">
                    ▶ 📁 ${nomePasta}
                </span>
                <a href="${linkZip}" target="_blank" onclick="event.stopPropagation()">
                    <button style="background:none; border:2px solid #4db8ff; color:#4db8ff; cursor:pointer; padding:6px 12px; font-size:0.7em; border-radius:5px;">⬇️ .ZIP</button>
                </a>
            </div>
        `;
        const divFilhos = document.createElement('div');
        divFilhos.style.display = 'none';
        divFilhos.appendChild(renderizarNivel(todosArquivos, novoPrefixo, nomeBackup));
        li.appendChild(divFilhos);
        ul.appendChild(li);
    });

    arquivos.forEach(arq => {
        const li = document.createElement('li');
        li.style.cssText = "padding:3px 0; display:flex; justify-content:space-between; border-bottom:1px dashed #444; align-items:center;";
        const link = `/api/backups/download-single?userId=${currentUserId}&nomeBackup=${nomeBackup}&file=${encodeURIComponent(arq.name)}`;
        li.innerHTML = `
            <span style="color:#ccc;">📄 ${arq.nomeCurto}</span>
            <a href="${link}" target="_blank">
                <button style="background:none; border:2px solid #4db8ff; color:#4db8ff; cursor:pointer; padding:6px 12px; font-size:0.7em; border-radius:5px;">⬇️ ARQUIVO</button>
            </a>
        `;
        ul.appendChild(li);
    });

    return ul;
}

carregarListaDownloads();

// --- Lógica de Inicialização ---
function initializeTerminal() {
    setupContainer.style.display = 'none';
    terminalContainer.style.display = 'block';

    term.open(document.getElementById('terminal'));
    setTimeout(() => {
        fitAddon.fit();
        socket.emit('resize', { cols: term.cols, rows: term.rows });
    }, 100);
    window.addEventListener('resize', () => {
        fitAddon.fit();
        socket.emit('resize', { cols: term.cols, rows: term.rows });
    });
}

// --- CONTROLE DA INTERFACE DE BACKUP ---
function atualizarInterfaceBackup() {
    const areaAtual = document.getElementById('area-salvar-atual');
    const lblAtual = document.getElementById('lbl-nome-atual');
    const btnAtual = document.getElementById('btn-salvar-atual');

    if (currentLoadedBackup && areaAtual) {
        areaAtual.style.display = 'flex';
        lblAtual.textContent = currentLoadedBackup;

        btnAtual.onclick = function() {
            window.salvarArquivo(currentLoadedBackup);
        };
    } else if (areaAtual) {
        areaAtual.style.display = 'none';
    }
}

// --- Lógica de Backup (Agora só calcula Cota e atualiza listas externas) ---
async function carregarBackups() {
    const status = document.getElementById('status-cota');

    await carregarListaDownloads(); 

    try {
        const res = await fetch(`/api/backups?userId=${currentUserId}`);
        const arquivos = await res.json();
        
        let totalSize = 0;
        arquivos.forEach(arq => {
            totalSize += arq.size;
        });
        
        if(status) status.innerText = `Uso: ${(totalSize/1024/1024).toFixed(2)} / 100 MB`;

    } catch (e) {
        console.error("Erro cota", e);
    }
}

// --- EVENTOS ---
setupForm.addEventListener('submit', (e) => {
    e.preventDefault(); 
    const numMachines = parseInt(numMachinesInput.value, 10);
    const mpiImage = document.querySelector('meta[name="mpi-image"]').getAttribute('content');
    const backupName = selectBackup.value;
    
    currentLoadedBackup = backupName || null;

    if (numMachines > 0) {
        socket.emit('start-session', { 
            numMachines, 
            mpiImage, 
            userId: currentUserId, 
            backupName: backupName 
        });
        initializeTerminal();
    }
});

term.onData(data => socket.emit('input', data));
socket.on('output', data => term.write(data));

socket.on('session-ready', (data) => {
    const machineList = document.getElementById('machine-list');
    machineList.innerHTML = '';

    data.aliases.forEach(alias => {
        const listItem = document.createElement('li');
        listItem.textContent = alias;
        machineList.appendChild(listItem);
    });

    if (data.masterPodName) {
        console.log("Pod Mestre identificado:", data.masterPodName);
        myMasterPodName = data.masterPodName;
        
        const backupUi = document.getElementById('backup-ui');
        if(backupUi) {
            backupUi.style.display = 'block';
            atualizarInterfaceBackup();
            carregarBackups();
        }
    }
});

socket.on('connect_error', (err) => {
    term.write(`\r\n[ERRO DE CONEXÃO]: ${err.message}`);
});

// --- SALVAR ---
window.salvarArquivo = async function(nomeAlvo) {
    if(!myMasterPodName) return alert('Erro: Pod não conectado.');
    
    nomeAlvo = nomeAlvo.trim();
    if(!nomeAlvo) return alert("Nome inválido");

    const jaExiste = Array.from(selectBackup.options).some(o => o.value === nomeAlvo);

    if (jaExiste && nomeAlvo !== currentLoadedBackup) {
        if(!confirm(`O arquivo "${nomeAlvo}" JÁ EXISTE! \n\nDeseja sobreescrever?`)) return;
    }

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
            currentLoadedBackup = nomeAlvo;
            atualizarInterfaceBackup(); 
            socket.emit('update-active-backup', nomeAlvo);

            const nomeRaw = nomeAlvo + ".tar.gz";
            if(cacheArquivos[nomeRaw]) delete cacheArquivos[nomeRaw];
            
            await carregarBackups();
            
            const inputNovo = document.getElementById('nome-backup');
            if(inputNovo) inputNovo.value = '';
        }
    } catch(e) { 
        alert('Erro de conexão ao salvar.'); 
    }
};

const btnSalvarNovo = document.getElementById('btn-salvar-novo');
if(btnSalvarNovo) {
    btnSalvarNovo.addEventListener('click', () => {
        let nome = document.getElementById('nome-backup').value;
        if(!nome) return alert("Digite um nome para o novo arquivo.");
        window.salvarArquivo(nome);
    });
}

// --- DELETAR ---
window.deletar = async (nome) => {
    if(!confirm('Tem certeza que deseja APAGAR este arquivo permanentemente?')) return;
    
    try {
        await fetch('/api/backups', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUserId, nomeCompleto: nome })
        });
        
        const nomeLimpo = nome.split('/')[1].replace('.tar.gz', '');
        delete cacheArquivos[nome];

        if(nomeLimpo === currentLoadedBackup) {
            currentLoadedBackup = null;
            atualizarInterfaceBackup();
        }

        await carregarBackups();
        alert('Arquivo apagado.');

    } catch (e) {
        console.error(e);
        alert('Erro ao tentar apagar.');
    }
};