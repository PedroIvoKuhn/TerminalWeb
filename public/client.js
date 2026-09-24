const socket = io();
const urlParams = new URLSearchParams(window.location.search);
const targetMachine = urlParams.get("machine") || "master";

// --- Elementos da Página ---
const setupContainer = document.getElementById('setup-container');
const terminalContainer = document.getElementById('terminal-container');
const setupForm = document.getElementById('setup-form');
const numMachinesInput = document.getElementById('num-machines');

let myMasterPodName = null;
let currentLoadedBackup = localStorage.getItem('active_backup_name') || null;;
const selectBackup = document.getElementById('select-backup');

let cacheArquivos = {}; 

document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const ltik = urlParams.get('ltik') || window.LTI_TOKEN;

    if (ltik) {
        const links = document.querySelectorAll('a[href^="/"]');
        links.forEach(link => {
            const url = new URL(link.href, window.location.origin);
            url.searchParams.set('ltik', ltik);
            link.href = url.pathname + url.search;
        });
    }
});

// --- Configuração do Terminal ---
const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Fira Code", "Cascadia Code", Consolas, monospace', // Fontes modernas de código
    theme: {
        background: '#1e1e1e', // Fundo que combina com seu CSS
        foreground: '#f8f8f2', // Texto padrão (quase branco)
        cursor: '#50fa7b',     // Cursor piscando em verde neon
        cursorAccent: '#1e1e1e',
        selectionBackground: '#44475a',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',    
        cyan: '#8be9fd',       
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff'
    }
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

// --- Inicializando terminal ---
setupForm.addEventListener('submit', (e) => {
    e.preventDefault(); 
    const numMachines = parseInt(numMachinesInput.value, 10);
    const image = document.querySelector('meta[name="image"]').getAttribute('content');
    const backupName = selectBackup.value;
    currentLoadedBackup = backupName || null;


    if (numMachines > 0) {
        localStorage.setItem('active_backup_name', backupName);
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
            const parentLi = target.closest('.tree-folder');
            const childContainer = parentLi.querySelector('.tree-children');
            
            if (childContainer) {
                const isHidden = childContainer.style.display === 'none';
                childContainer.style.display = isHidden ? 'block' : 'none';
                
                target.innerText = isHidden 
                    ? target.innerText.replace('▶', '▼') 
                    : target.innerText.replace('▼', '▶');
            }
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
                li.classList.add('backup-list-item');
                
                li.innerHTML = `
                    <div class="backup-item-header">
                        <span class="backup-title">📦 ${cleanName} <small class="backup-size">(${sizeMB} MB)</small></span>
                        
                        <div>
                            <button data-action="navigate" data-file="${rawName}" class="btn-sm btn-info">
                                📂 Navegar
                            </button>

                            <a href="${downloadLink}" target="_blank" style="text-decoration:none;">
                                <button class="btn-sm btn-download">
                                    ⬇️ Baixar
                                </button>
                            </a>

                            <button data-action="delete" data-file="${file.name}" class="btn-sm btn-danger" style="margin-right: 0;">
                                🗑️ Apagar
                            </button>
                        </div>
                    </div>
                    
                    <div id="tree-container-${cleanName}" class="tree-container" style="display:none;">
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
    ul.classList.add('tree-list');

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
        li.classList.add('tree-folder')

        const newPrefix = currentPrefix + folderName + '/';
        const linkZip = `/api/backups/download-folder?backupName=${backupName}&folder=${encodeURIComponent(newPrefix)}`;

        li.innerHTML = `
            <div class="tree-folder-header">
                <span data-action="toggle-folder" class="tree-folder-name">
                    ▶ 📁 ${folderName}
                </span>
                <a href="${linkZip}" target="_blank" onclick="event.stopPropagation()">
                    <button class="btn-outline">⬇️ .ZIP</button>
                </a>
            </div>
        `;
        const childDiv = document.createElement('div');
        childDiv.classList.add('tree-children');
        childDiv.style.display = 'none';
        childDiv.appendChild(renderTreeLevel(allFiles, newPrefix, backupName));
        li.appendChild(childDiv);
        ul.appendChild(li);
    });

    files.forEach(file => {
        const li = document.createElement('li');
        li.classList.add('tree-file');

        const link = `/api/backups/download-single?backupName=${backupName}&file=${encodeURIComponent(file.name)}`;
        li.innerHTML = `
            <span class="tree-file-name">📄 ${file.shortName}</span>
            <a href="${link}" target="_blank">
                <button class="btn-outline">⬇️ ARQUIVO</button>
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
        const msg = `O arquivo <b>"${targetName}"</b> JÁ EXISTE!<br><br>Deseja sobreescrever?`;
        const confirmed = await AppModal.confirm('Substituir Arquivo?', msg);
        if (!confirmed) return;
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
            AppModal.alert('Erro', json.error);
        } else {
            AppModal.alert('Salvo', 'Backup salvo com sucesso!');
            currentLoadedBackup = targetName;
            localStorage.setItem('active_backup_name', targetName);
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
    const confirmed = await AppModal.confirm('Atenção!', 'Tem certeza que deseja APAGAR este arquivo permanentemente?');
    if (!confirmed) return;
    
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
            localStorage.removeItem('active_backup_name');
            updateBackupUI();
        }

        await loadBackups();
        AppModal.alert('Sucesso', 'Arquivo apagado com sucesso.');

    } catch (e) {
        console.error(e);
        AppModal.alert('Erro', 'Erro ao tentar apagar.');
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
        const urlParams = new URLSearchParams(window.location.search);

        if (alias === targetMachine) {
          btn.disabled = true;
        }

        btn.onclick = () => {
            urlParams.set('machine', alias);
        
            const novaUrl = `${window.location.pathname}?${urlParams.toString()}`;
            window.open(novaUrl, '_blank');
        };

        machineList.appendChild(btn);
    });

    if (data.masterPodName) {
        //console.log("Pod Mestre identificado:", data.masterPodName);
        myMasterPodName = data.masterPodName;
        
        const backupUi = document.getElementById('backup-ui');
        if(backupUi) {
            backupUi.style.display = 'block';
            updateBackupUI();
            loadBackups();
        }
    }

    const machineRaw = urlParams.get('machine') || 'Master';
    const machine = machineRaw.charAt(0).toLocaleUpperCase() + machineRaw.slice(1).replaceAll('-', ' ');
    document.title = `Terminal Web - ${machine}`;

    setTimeout(() => {
        //console.log("Terminal sincronizando dimensões:", term.cols, term.rows);
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
    localStorage.removeItem('active_backup_name');
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

window.addEventListener('beforeunload', () => {
    if (burstChkRemember && !burstChkRemember.checked) {
        clearCloudSessionCredentials();
    }
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

// --- CONTROLADOR DE MODAL DINÂMICO ---
const AppModal = {
    // Retorna uma Promise que resolve 'true' (Confirmar) ou 'false' (Cancelar)
    show: function({ title, message, type = 'alert', confirmText = 'OK', cancelText = 'Cancelar' }) {
        return new Promise((resolve) => {
            const modal = document.getElementById('custom-modal');
            const elTitle = document.getElementById('custom-modal-title');
            const elMessage = document.getElementById('custom-modal-message');
            const btnConfirm = document.getElementById('custom-modal-confirm');
            const btnCancel = document.getElementById('custom-modal-cancel');

            // Preenche os textos
            elTitle.textContent = title;
            elMessage.innerHTML = message; // Usamos innerHTML caso queira mandar uma quebra de linha <br>
            btnConfirm.textContent = confirmText;
            btnCancel.textContent = cancelText;

            // Ajusta os botões dependendo se é Alert ou Confirm
            if (type === 'confirm') {
                btnCancel.style.display = 'block';
            } else {
                btnCancel.style.display = 'none';
            }

            // Exibe o modal
            modal.style.display = 'flex';

            // Função para limpar os eventos antigos para não acumularem
            const cleanup = () => {
                modal.style.display = 'none';
                btnConfirm.onclick = null;
                btnCancel.onclick = null;
            };

            // Eventos de clique
            btnConfirm.onclick = () => {
                cleanup();
                resolve(true);
            };

            btnCancel.onclick = () => {
                cleanup();
                resolve(false);
            };
        });
    },

    alert: (title, message) => AppModal.show({ title, message, type: 'alert' }),
    confirm: (title, message) => AppModal.show({ title, message, type: 'confirm', confirmText: 'Sim', cancelText: 'Não' })
};

// --- CLOUD BURSTING ---
const btnBursting = document.getElementById('bursting');
const btnSetupBurst = document.getElementById('btn-setup-burst');
const burstModal = document.getElementById('burst-modal');

// Views do Modal de Bursting
const burstViewSelection = document.getElementById('burst-view-selection');
const burstViewForm = document.getElementById('burst-view-form');
const burstViewProgress = document.getElementById('burst-view-progress');

// Seleção de Provedor
const cardSelectAws = document.getElementById('card-select-aws');
const cardSelectAzure = document.getElementById('card-select-azure');
const btnBurstCloseSelection = document.getElementById('btn-burst-close-selection');
const btnBurstCancelSelection = document.getElementById('btn-burst-cancel-selection');

// Formulário de Credenciais
const btnBurstFormBack = document.getElementById('btn-burst-form-back');
const burstFormProviderBadge = document.getElementById('burst-form-provider-badge');
const btnOpenCloudTutorial = document.getElementById('btn-open-cloud-tutorial');
const burstCredentialsForm = document.getElementById('burst-credentials-form');
const burstFieldsAws = document.getElementById('burst-fields-aws');
const burstFieldsAzure = document.getElementById('burst-fields-azure');
const burstFormFeedback = document.getElementById('burst-form-feedback');
const burstChkRemember = document.getElementById('burst-chk-remember');
const btnBurstFormCancel = document.getElementById('btn-burst-form-cancel');

// Progresso e Console
const burstProviderBadge = document.getElementById('burst-provider-badge');
const burstProgressSubtitle = document.getElementById('burst-progress-subtitle');
const burstConsoleOutput = document.getElementById('burst-console-output');
const btnBurstFinish = document.getElementById('btn-burst-finish');
const btnBurstCancel = document.getElementById('btn-burst-cancel');
const btnBurstRetry = document.getElementById('btn-burst-retry');
const burstStatusBadge = document.getElementById('burst-status-badge');

let selectedCloudProvider = 'AWS';
let currentBurstStep = 1;
let isBurstConnected = false;
let connectedCloudProvider = null;

// Helpers de Visualização
function showBurstView(viewName) {
    if (burstViewSelection) burstViewSelection.style.display = viewName === 'selection' ? 'block' : 'none';
    if (burstViewForm) burstViewForm.style.display = viewName === 'form' ? 'block' : 'none';
    if (burstViewProgress) burstViewProgress.style.display = viewName === 'progress' ? 'block' : 'none';
}

function openBurstModal() {
    if (isBurstConnected) {
        AppModal.alert('Nuvem Conectada', `A máquina na nuvem (${connectedCloudProvider || 'Nuvem'}) já está conectada e operando no seu cluster!`);
        return;
    }
    showBurstView('selection');
    if (burstModal) burstModal.style.display = 'flex';
}

function closeBurstModal() {
    if (burstModal) burstModal.style.display = 'none';
}

// Limpa todas as credenciais temporárias do sessionStorage
function clearCloudSessionCredentials() {
    try {
        const keysToRemove = [
            'tw_aws_region', 'tw_aws_access_key', 'tw_aws_secret_key', 'tw_aws_session_token', 'tw_aws_instance_type',
            'tw_azure_subscription_id', 'tw_azure_tenant_id', 'tw_azure_client_id', 'tw_azure_client_secret',
            'tw_azure_location', 'tw_azure_vm_size', 'tw_azure_rg'
        ];
        keysToRemove.forEach(k => sessionStorage.removeItem(k));
    } catch (e) {}
}

if (burstChkRemember) {
    burstChkRemember.addEventListener('change', () => {
        if (!burstChkRemember.checked) {
            clearCloudSessionCredentials();
        }
    });
}

// Salva e restaura dados em sessionStorage para conveniência do usuário (limpo ao desconectar)
function loadSavedCredentials(provider) {
    try {
        if (provider === 'AWS') {
            const savedRegion = sessionStorage.getItem('tw_aws_region');
            const savedAccessKey = sessionStorage.getItem('tw_aws_access_key');
            const savedSecretKey = sessionStorage.getItem('tw_aws_secret_key');
            const savedToken = sessionStorage.getItem('tw_aws_session_token');
            const savedInstance = sessionStorage.getItem('tw_aws_instance_type');

            if (savedRegion) document.getElementById('aws-input-region').value = savedRegion;
            if (savedAccessKey) document.getElementById('aws-input-access-key').value = savedAccessKey;
            if (savedSecretKey) document.getElementById('aws-input-secret-key').value = savedSecretKey;
            if (savedToken) document.getElementById('aws-input-session-token').value = savedToken;
            if (savedInstance) document.getElementById('aws-input-instance-type').value = savedInstance;
        } else if (provider === 'AZURE') {
            const savedSub = sessionStorage.getItem('tw_azure_subscription_id');
            const savedTenant = sessionStorage.getItem('tw_azure_tenant_id');
            const savedClient = sessionStorage.getItem('tw_azure_client_id');
            const savedSecret = sessionStorage.getItem('tw_azure_client_secret');
            const savedLoc = sessionStorage.getItem('tw_azure_location');
            const savedVm = sessionStorage.getItem('tw_azure_vm_size');
            const savedRg = sessionStorage.getItem('tw_azure_rg');

            if (savedSub) document.getElementById('azure-input-subscription-id').value = savedSub;
            if (savedTenant) document.getElementById('azure-input-tenant-id').value = savedTenant;
            if (savedClient) document.getElementById('azure-input-client-id').value = savedClient;
            if (savedSecret) document.getElementById('azure-input-client-secret').value = savedSecret;
            if (savedLoc) document.getElementById('azure-input-location').value = savedLoc;
            if (savedVm) document.getElementById('azure-input-vm-size').value = savedVm;
            if (savedRg) document.getElementById('azure-input-rg').value = savedRg;
        }
    } catch (e) {}
}

function saveCredentialsToSession(provider, creds) {
    try {
        if (!burstChkRemember || !burstChkRemember.checked) return;
        if (provider === 'AWS') {
            sessionStorage.setItem('tw_aws_region', creds.region || '');
            sessionStorage.setItem('tw_aws_access_key', creds.accessKeyId || '');
            sessionStorage.setItem('tw_aws_secret_key', creds.secretAccessKey || '');
            sessionStorage.setItem('tw_aws_session_token', creds.sessionToken || '');
            sessionStorage.setItem('tw_aws_instance_type', creds.instanceType || '');
        } else if (provider === 'AZURE') {
            sessionStorage.setItem('tw_azure_subscription_id', creds.subscriptionId || '');
            sessionStorage.setItem('tw_azure_tenant_id', creds.tenantId || '');
            sessionStorage.setItem('tw_azure_client_id', creds.clientId || '');
            sessionStorage.setItem('tw_azure_client_secret', creds.clientSecret || '');
            sessionStorage.setItem('tw_azure_location', creds.location || '');
            sessionStorage.setItem('tw_azure_vm_size', creds.vmSize || '');
            sessionStorage.setItem('tw_azure_rg', creds.resourceGroupName || '');
        }
    } catch (e) {}
}

function selectProvider(provider) {
    selectedCloudProvider = provider.toUpperCase();

    if (burstFormFeedback) burstFormFeedback.style.display = 'none';

    if (selectedCloudProvider === 'AWS') {
        if (burstFormProviderBadge) {
            burstFormProviderBadge.textContent = 'AWS';
            burstFormProviderBadge.style.background = '#d97706';
        }
        if (burstFieldsAws) burstFieldsAws.style.display = 'block';
        if (burstFieldsAzure) burstFieldsAzure.style.display = 'none';
        if (btnOpenCloudTutorial) {
            btnOpenCloudTutorial.href = '/tutorial-nuvem#aws';
            btnOpenCloudTutorial.title = 'Abrir tutorial da AWS em nova janela';
        }
        loadSavedCredentials('AWS');
    } else {
        if (burstFormProviderBadge) {
            burstFormProviderBadge.textContent = 'AZURE';
            burstFormProviderBadge.style.background = '#0284c7';
        }
        if (burstFieldsAws) burstFieldsAws.style.display = 'none';
        if (burstFieldsAzure) burstFieldsAzure.style.display = 'block';
        if (btnOpenCloudTutorial) {
            btnOpenCloudTutorial.href = '/tutorial-nuvem#azure';
            btnOpenCloudTutorial.title = 'Abrir tutorial do Azure em nova janela';
        }
        loadSavedCredentials('AZURE');
    }

    showBurstView('form');
}

// Botões de abertura e navegação do modal
if (btnBursting) {
    btnBursting.addEventListener('click', openBurstModal);
}
if (btnSetupBurst) {
    btnSetupBurst.addEventListener('click', openBurstModal);
}

if (cardSelectAws) {
    cardSelectAws.addEventListener('click', () => selectProvider('AWS'));
    cardSelectAws.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') selectProvider('AWS');
    });
}
if (cardSelectAzure) {
    cardSelectAzure.addEventListener('click', () => selectProvider('AZURE'));
    cardSelectAzure.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') selectProvider('AZURE');
    });
}

if (btnBurstCloseSelection) btnBurstCloseSelection.addEventListener('click', closeBurstModal);
if (btnBurstCancelSelection) btnBurstCancelSelection.addEventListener('click', closeBurstModal);

if (btnBurstFormBack) {
    btnBurstFormBack.addEventListener('click', () => showBurstView('selection'));
}
if (btnBurstFormCancel) {
    btnBurstFormCancel.addEventListener('click', closeBurstModal);
}

// Toggle de exibição de senha nos campos com olho
document.querySelectorAll('.btn-toggle-eye').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        const inputEl = document.getElementById(targetId);
        if (inputEl) {
            if (inputEl.type === 'password') {
                inputEl.type = 'text';
                btn.textContent = '🙈';
            } else {
                inputEl.type = 'password';
                btn.textContent = '👁️';
            }
        }
    });
});

// Envio do Formulário de Credenciais
if (burstCredentialsForm) {
    burstCredentialsForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (burstFormFeedback) burstFormFeedback.style.display = 'none';

        let credentials = {};

        if (selectedCloudProvider === 'AWS') {
            const region = document.getElementById('aws-input-region').value;
            const accessKeyId = (document.getElementById('aws-input-access-key').value || '').trim();
            const secretAccessKey = (document.getElementById('aws-input-secret-key').value || '').trim();
            const sessionToken = (document.getElementById('aws-input-session-token').value || '').trim();
            const instanceType = document.getElementById('aws-input-instance-type').value;

            if (!accessKeyId || !secretAccessKey) {
                if (burstFormFeedback) {
                    burstFormFeedback.textContent = 'Por favor, informe a AWS Access Key ID e a Secret Access Key.';
                    burstFormFeedback.style.display = 'block';
                }
                return;
            }

            credentials = { region, accessKeyId, secretAccessKey, instanceType };
            if (sessionToken) credentials.sessionToken = sessionToken;
        } else {
            const subscriptionId = (document.getElementById('azure-input-subscription-id').value || '').trim();
            const tenantId = (document.getElementById('azure-input-tenant-id').value || '').trim();
            const clientId = (document.getElementById('azure-input-client-id').value || '').trim();
            const clientSecret = (document.getElementById('azure-input-client-secret').value || '').trim();
            const location = document.getElementById('azure-input-location').value;
            const vmSize = document.getElementById('azure-input-vm-size').value;
            const resourceGroupName = (document.getElementById('azure-input-rg').value || 'CloudBurstingRG').trim();

            if (!subscriptionId || !tenantId || !clientId || !clientSecret) {
                if (burstFormFeedback) {
                    burstFormFeedback.textContent = 'Por favor, preencha todos os campos obrigatórios da Azure (Subscription, Tenant, Client ID e Secret).';
                    burstFormFeedback.style.display = 'block';
                }
                return;
            }

            credentials = { subscriptionId, tenantId, clientId, clientSecret, location, vmSize, resourceGroupName };
        }

        saveCredentialsToSession(selectedCloudProvider, credentials);

        // Prepara tela de progresso
        const imageMeta = document.querySelector('meta[name="image"]');
        const activeImage = imageMeta ? imageMeta.getAttribute('content') : null;

        resetBurstModal();
        if (burstProviderBadge) burstProviderBadge.textContent = selectedCloudProvider;
        if (burstProgressSubtitle) {
            burstProgressSubtitle.textContent = `Provisionando nó na nuvem ${selectedCloudProvider} e integrando via VPN...`;
        }

        showBurstView('progress');
        socket.emit('burst:start', {
            provider: selectedCloudProvider,
            credentials,
            image: activeImage
        });
    });
}

function logBurstConsole(msg) {
    if (!burstConsoleOutput) return;
    const time = new Date().toLocaleTimeString();
    burstConsoleOutput.textContent += `\n[${time}] ${msg}`;
    burstConsoleOutput.scrollTop = burstConsoleOutput.scrollHeight;
}

function setBurstStep(stepNumber, state) {
    // state: 'pending' | 'active' | 'success' | 'error'
    const stepEl = document.getElementById(`burst-step-${stepNumber}`);
    if (!stepEl) return;

    stepEl.classList.remove('step-pending', 'step-active', 'step-success', 'step-error');
    stepEl.classList.add(`step-${state}`);

    const numberSpan = stepEl.querySelector('.step-number');
    const spinnerSpan = stepEl.querySelector('.step-spinner');

    if (state === 'active') {
        if (numberSpan) numberSpan.style.display = 'none';
        if (spinnerSpan) spinnerSpan.style.display = 'inline-block';
    } else if (state === 'success') {
        if (numberSpan) {
            numberSpan.style.display = 'inline-block';
            numberSpan.textContent = '✓';
        }
        if (spinnerSpan) spinnerSpan.style.display = 'none';
    } else if (state === 'error') {
        if (numberSpan) {
            numberSpan.style.display = 'inline-block';
            numberSpan.textContent = '✗';
        }
        if (spinnerSpan) spinnerSpan.style.display = 'none';
    } else {
        if (numberSpan) {
            numberSpan.style.display = 'inline-block';
            numberSpan.textContent = String(stepNumber);
        }
        if (spinnerSpan) spinnerSpan.style.display = 'none';
    }
}

function resetBurstModal() {
    for (let i = 1; i <= 4; i++) {
        setBurstStep(i, i === 1 ? 'active' : 'pending');
    }
    if (burstConsoleOutput) {
        burstConsoleOutput.textContent = 'Iniciando expansão do cluster com as credenciais fornecidas...';
    }
    if (btnBurstFinish) btnBurstFinish.style.display = 'none';
    if (btnBurstCancel) btnBurstCancel.style.display = 'none';
    if (btnBurstRetry) btnBurstRetry.style.display = 'none';
}

if (btnBurstFinish) {
    btnBurstFinish.addEventListener('click', closeBurstModal);
}

if (btnBurstCancel) {
    btnBurstCancel.addEventListener('click', closeBurstModal);
}

if (btnBurstRetry) {
    btnBurstRetry.addEventListener('click', () => {
        showBurstView('form');
    });
}

socket.on('burst:step', ({ step, message }) => {
    currentBurstStep = step;
    logBurstConsole(message);

    for (let i = 1; i < step; i++) {
        setBurstStep(i, 'success');
    }
    setBurstStep(step, 'active');
});

socket.on('burst:complete', ({ nodeId, nodeName, provider }) => {
    isBurstConnected = true;
    connectedCloudProvider = provider || selectedCloudProvider;
    for (let i = 1; i <= 4; i++) {
        setBurstStep(i, 'success');
    }
    const displayName = nodeName || nodeId;
    logBurstConsole(`✅ Sucesso! Nó ${displayName} (${connectedCloudProvider}) integrado ao cluster MicroK8s.`);

    if (btnBurstFinish) btnBurstFinish.style.display = 'inline-block';
    if (btnBurstCancel) btnBurstCancel.style.display = 'none';
    if (btnBurstRetry) btnBurstRetry.style.display = 'none';

    if (btnBursting) {
        const textSpan = btnBursting.querySelector('.burst-btn-text');
        if (textSpan) textSpan.textContent = `${connectedCloudProvider} Conectada`;
        btnBursting.classList.add('connected');
    }
    if (burstStatusBadge) {
        burstStatusBadge.style.display = 'inline-block';
    }
});

socket.on('burst:error', ({ message }) => {
    setBurstStep(currentBurstStep, 'error');
    logBurstConsole(`❌ ERRO: ${message}`);

    if (btnBurstCancel) {
        btnBurstCancel.style.display = 'inline-block';
        btnBurstCancel.textContent = 'Fechar';
    }
    if (btnBurstRetry) {
        btnBurstRetry.style.display = 'inline-block';
    }
    if (btnBurstFinish) btnBurstFinish.style.display = 'none';
});