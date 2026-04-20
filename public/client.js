const socket = io();
const urlParams = new URLSearchParams(window.location.search);
const targetMachine = urlParams.get("machine") || "master";

// --- Elementos da Página ---
const setupContainer = document.getElementById('setup-container');
const terminalContainer = document.getElementById('terminal-container');
const setupForm = document.getElementById('setup-form');
const numMachinesInput = document.getElementById('num-machines');

let myMasterPodName = null;
let currentLoadedBackup = null;
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

// --- Inicializando terminal ---
setupForm.addEventListener('submit', (e) => {
    e.preventDefault(); 
    const numMachines = parseInt(numMachinesInput.value, 10);
    const backupName = selectBackup.value;
    currentLoadedBackup = backupName || null;
    const image = document.querySelector('meta[name="image"]').getAttribute('content');

    if (numMachines > 0) {
        socket.emit('start-session', { numMachines: numMachines, image: image, backupName: backupName });
        initializeTerminal();
    }
});

function initializeTerminal() {
    setupContainer.style.display = 'none';
    terminalContainer.style.display = 'block';

    term.open(document.getElementById('terminal'));

    term.onResize((size) => {
        socket.emit('resize', { cols: size.cols, rows: size.rows });
    });

    fitAddon.fit();
    window.addEventListener('resize', () => fitAddon.fit());
}

// --- MiniO ---
loadDownloadList();
const fileCache = {};
// --- 1. LISTAGEM DA TELA INICIAL (COM NAVEGAÇÃO) ---
const downloadListContainer = document.getElementById('download-list');

if (downloadListContainer) {
    downloadListContainer.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;

        const action = target.getAttribute('data-action');
        const fileName = target.getAttribute('data-file');

        if (action === 'navigate') {
            toggleNavigation(fileName, target);
        } else if (action === 'delete') {
            deleteFile(fileName);
        } else if (action === 'toggle-folder') {
            const nextDiv = target.parentElement.nextElementSibling;
            nextDiv.style.display = nextDiv.style.display === 'none' ? 'block' : 'none';
        }
    });
}

async function loadDownloadList() {
    const listUl = document.getElementById('download-list');
    const select = document.getElementById('select-backup');
    
    try {
        const res = await fetch('/api/backups');
        if (!res.ok) throw new Error("Erro ao buscar lista");
        const files = await res.json();

        // 1. Preenche o Dropdown (Select)
        if(select) {
            select.innerHTML = '<option value="">-- Começar do Zero (Vazio) --</option>';
            files.forEach(arq => {
                const rawName = arq.name.split('/')[1];
                if(!rawName) return;
                const cleanName = rawName.replace('.tar.gz', '');
                const option = document.createElement('option');
                option.value = cleanName;
                option.textContent = `📂 ${cleanName}`;
                select.appendChild(option);
            });
            if(currentLoadedBackup) select.value = currentLoadedBackup;
        }

        // 2. Preenche a Lista de Baixo (Downloads + Navegação)
        if (listUl) {
            listUl.innerHTML = '';
            
            if (files.length === 0) {
                listUl.innerHTML = '<li style="color:#777; font-size: 0.9em;">Nenhum arquivo encontrado.</li>';
                return;
            }

            files.forEach(file => {
                const rawName = file.name.split('/')[1]; 
                if(!rawName) return;

                const cleanName = rawName.replace('.tar.gz', '');
                const sizeMB = (file.size / 1024 / 1024).toFixed(2);
                const downloadLink = `/api/download?fileName=${encodeURIComponent(rawName)}`;

                const li = document.createElement('li');
                li.style.cssText = "background: #333; margin-bottom: 5px; padding: 10px; border-radius: 4px; border: 1px solid #444;";
                
                li.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight:bold; color:#f1f1f1;">📦 ${cleanName} <small style="color:#aaa; font-weight:normal;">(${sizeMB} MB)</small></span>
                        
                        <div>
                            <button data-action="navigate" data-file="${rawName}"                      style="background:#17a2b8; color:white; border:none; padding:6px 12px; cursor:pointer; border-radius:4px; font-size: 0.8em; margin-right: 5px;">
                                📂 Navegar
                            </button>

                            <a href="${downloadLink}" target="_blank" style="text-decoration:none; margin-right: 5px;">
                                <button style="background:#007bff; color:white; border:none; padding:6px 12px; cursor:pointer; border-radius:4px; font-size: 0.8em; font-weight:bold;">
                                    ⬇️ Baixar
                                </button>
                            </a>

                            <button data-action="delete" data-file="${file.name}" style="background:#dc3545; color:white; border:none; padding:6px 12px; cursor:pointer; border-radius:4px; font-size: 0.8em;">
                                🗑️ Apagar
                            </button>
                        </div>
                    </div>
                    
                    <div id="tree-container-${cleanName}" style="display:none; margin-top:10px; padding-left:10px; border-left:1px solid #555;">
                        <small style="color:#aaa">Carregando...</small>
                    </div>
                `;
                listUl.appendChild(li);
            });
        }
    } catch (e) {
        console.error(e);
    }
}

// --- 2. LÓGICA DA ÁRVORE (Tree View) ---
async function toggleNavigation(rawBackupName, btnElement) {
    const cleanName = rawBackupName.replace('.tar.gz', '');
    const container = document.getElementById(`tree-container-${cleanName}`);
    
    if (container.style.display === 'block') {
        container.style.display = 'none';
        btnElement.innerText = '📂 Navegar';
        return;
    }

    container.style.display = 'block';
    btnElement.innerText = '📂 Fechar';

    if (fileCache[rawBackupName]) {
        drawTree(container, fileCache[rawBackupName], rawBackupName);
        return;
    }

    try {
        const res = await fetch(`/api/backups/content?fileName=${encodeURIComponent(rawBackupName)}`);
        if (!res.ok) throw new Error("Erro ao carregar");
        const files = await res.json();
        
        fileCache[rawBackupName] = files;
        drawTree(container, files, rawBackupName);
    } catch (e) { 
        container.innerHTML = '<span style="color:red">Erro ao carregar arquivos.</span>'; 
    }
};

function drawTree(container, allFiles, backupName) {
    container.innerHTML = '';
    const cleanList = allFiles.filter(f => f.name && f.name.trim() !== '');
    
    if (cleanList.length === 0) {
        container.innerHTML = '<small style="color:#777">Backup vazio.</small>';
        return;
    }
    container.appendChild(renderTreeLevel(cleanList, '', backupName));
}

function renderTreeLevel(allFiles, currentPrefix, backupName) {
    const ul = document.createElement('ul');
    ul.style.listStyle = 'none';
    ul.style.paddingLeft = '15px';
    ul.style.marginTop = '5px';

    let folders = new Set();
    let files = [];

    allFiles.forEach(file => {
        if (!file.name.startsWith(currentPrefix)) return;
        
        const relativePath = file.name.slice(currentPrefix.length);
        const parts = relativePath.split('/');

        if (parts.length > 1 && parts[0] !== '') {
            folders.add(parts[0]);
        } else if (parts.length === 1 && parts[0] !== '') {
            if (file.type !== 'directory' && !file.name.endsWith('/')) {
                files.push({ ...file, shortName: parts[0] });
            }
        }
    });

    folders.forEach(folderName => {
        const li = document.createElement('li');
        const newPrefix = currentPrefix + folderName + '/';
        const linkZip = `/api/backups/download-folder?backupName=${backupName}&folder=${encodeURIComponent(newPrefix)}`;

        li.innerHTML = `
            <div style="padding:3px 0; display:flex; justify-content:space-between; align-items:center;">
                <span style="cursor:pointer; color: #f3ff4dff; flex:1;" onclick="this.parentElement.nextElementSibling.style.display = (this.parentElement.nextElementSibling.style.display === 'none' ? 'block' : 'none');">
                    ▶ 📁 ${folderName}
                </span>
                <a href="${linkZip}" target="_blank" onclick="event.stopPropagation()">
                    <button style="background:none; border:2px solid #4db8ff; color:#4db8ff; cursor:pointer; padding:6px 12px; font-size:0.7em; border-radius:5px;">⬇️ .ZIP</button>
                </a>
            </div>
        `;
        const childDiv = document.createElement('div');
        childDiv.style.display = 'none';
        childDiv.appendChild(renderTreeLevel(allFiles, newPrefix, backupName));
        li.appendChild(childDiv);
        ul.appendChild(li);
    });

    files.forEach(file => {
        const li = document.createElement('li');
        li.style.cssText = "padding:3px 0; display:flex; justify-content:space-between; border-bottom:1px dashed #444; align-items:center;";
        const link = `/api/backups/download-single?backupName=${backupName}&file=${encodeURIComponent(file.name)}`;
        li.innerHTML = `
            <span style="color:#ccc;">📄 ${file.shortName}</span>
            <a href="${link}" target="_blank">
                <button style="background:none; border:2px solid #4db8ff; color:#4db8ff; cursor:pointer; padding:6px 12px; font-size:0.7em; border-radius:5px;">⬇️ ARQUIVO</button>
            </a>
        `;
        ul.appendChild(li);
    });

    return ul;
}

// --- CONTROLE DA INTERFACE DE BACKUP ---
function updateBackupUI() {
    const currentArea = document.getElementById('area-salvar-atual');
    const currentLbl = document.getElementById('lbl-nome-atual');
    const currentBtn = document.getElementById('btn-salvar-atual');

    if (currentLoadedBackup && currentArea) {
        currentArea.style.display = 'flex';
        currentLbl.textContent = currentLoadedBackup;

        currentBtn.onclick = () => saveFile(currentLoadedBackup);
    } else if (currentArea) {
        currentArea.style.display = 'none';
    }
}

// --- Lógica de Backup (Agora só calcula Cota e atualiza listas externas) ---
async function loadBackups() {
    const statusLbl = document.getElementById('status-cota');
    await loadDownloadList(); 

    try {
        const res = await fetch('/api/backups');
        if (res.statusLbl === 401) {
            console.warn("Sessão não autorizada");
            return;
        }
        const files = await res.json();
        
        let totalSize = 0;
        files.forEach(arq => {
            totalSize += arq.size;
        });
        
        if(statusLbl) statusLbl.innerText = `Uso: ${(totalSize/1024/1024).toFixed(2)} / 100 MB`;

    } catch (e) {
        console.error("Erro cota", e);
    }
}

// --- SALVAR ---
async function saveFile(targetName) {
    if(!myMasterPodName) return alert('Erro: Pod não conectado.');
    
    targetName = targetName.trim();
    if(!targetName) return alert("Nome inválido");

    const alreadyExists = Array.from(selectBackup.options).some(o => o.value === targetName);

    if (alreadyExists && targetName !== currentLoadedBackup) {
        if(!confirm(`O arquivo "${targetName}" JÁ EXISTE! \n\nDeseja sobreescrever?`)) return;
    }

    try {
        const res = await fetch('/api/backups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                podName: myMasterPodName, 
                fileName: targetName 
            })
        });
        const json = await res.json();
        
        if(json.error){ 
            alert('Erro: ' + json.error);
        } else {
            alert('Salvo com sucesso!');
            currentLoadedBackup = targetName;
            updateBackupUI(); 
            socket.emit('update-active-backup', targetName);

            const rawName = targetName + ".tar.gz";
            if(fileCache[rawName]) delete fileCache[rawName];
            
            await loadBackups();
            
            const inputNew = document.getElementById('nome-backup');
            if(inputNew) inputNew.value = '';
        }
    } catch(e) { 
        alert('Erro de conexão ao salvar.'); 
    }
};

const btnSaveNew = document.getElementById('btn-salvar-novo');
if(btnSaveNew) {
    btnSaveNew.addEventListener('click', () => {
        let nameInput = document.getElementById('nome-backup').value;
        if(!nameInput) return alert("Digite um nome para o novo arquivo.");
        saveFile(nameInput);
    });
}

// --- DELETAR ---
async function deleteFile(fullName) {
    if(!confirm('Tem certeza que deseja APAGAR este arquivo permanentemente?')) return;
    
    try {
        await fetch('/api/backups', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName: fullName })
        });
        
        const cleanName = fullName.split('/')[1].replace('.tar.gz', '');
        if (fileCache[fullName]) delete fileCache[fullName];

        if(cleanName === currentLoadedBackup) {
            currentLoadedBackup = null;
            updateBackupUI();
        }

        await loadBackups();
        alert('Arquivo apagado.');

    } catch (e) {
        console.error(e);
        alert('Erro ao tentar apagar.');
    }
};

// --- FUNÇÕES DO CONTADOR ---
let countdownInterval;
const timerBar = document.getElementById('timer-bar');
const countdownDisplay = document.getElementById('countdown-display');
const sessionModal = document.getElementById('session-modal');

function formatTime(ms) { // Formata milissegundos em HH:MM:SS
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000).toString().padStart(2, '0');
    const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, '0');
    const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function startCountdown(expiresAt) {
    timerBar.style.display = 'flex';
    timerBar.classList.remove('timer-critical');

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
term.onData(data => socket.emit('input', data));
socket.on('output', data => term.write(data));

socket.on('session-ready', (data) => {
    const machineList = document.getElementById('machine-list');
    machineList.innerHTML = '';
    localStorage.setItem("jobId", data.jobId);

    data.aliases.forEach(alias => {
        const btn = document.createElement('button');
        btn.textContent = `${alias}`;
        btn.className = 'btn-machine';

        if (alias === targetMachine) {
          btn.disabled = true;
        }

        btn.onclick = () => {
          // Pega a URL atual, limpa parâmetros velhos e adiciona o target novo
          const novaUrl = `${window.location.pathname}?machine=${alias}`;
          window.open(novaUrl, '_blank');
        };

        machineList.appendChild(btn);
    });

    if (data.masterPodName) {
        console.log("Pod Mestre identificado:", data.masterPodName);
        myMasterPodName = data.masterPodName;
        
        const backupUi = document.getElementById('backup-ui');
        if(backupUi) {
            backupUi.style.display = 'block';
            updateBackupUI();
            loadBackups();
        }
    }

    setTimeout(() => {
        console.log("Terminal sincronizando dimensões:", term.cols, term.rows);
        fitAddon.fit();
        socket.emit('resize', { cols: term.cols, rows: term.rows });
    }, 500);
});

socket.on('connect_error', (err) => {
    term.write(`\r\n[ERRO DE CONEXÃO]: ${err.message}`);
});

// --- SESSION SOCKETS ---
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

document.getElementById('btn-kill-session').addEventListener('click', () => {
    socket.emit("kill-session");
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
    socket.emit("restore-session", { 
    jobId: jobId,
    machine: targetMachine,
  });
}
