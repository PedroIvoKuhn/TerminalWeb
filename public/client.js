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

// Cache para guardar a estrutura dos arquivos e não carregar toda hora
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
        select.innerHTML = '<option value="">-- Começar do Zero (Vazio) --</option>';
        arquivos.forEach(arq => {
            const nomeLimpo = arq.name.split('/')[1].replace('.tar.gz', '');
            const option = document.createElement('option');
            option.value = nomeLimpo;
            option.textContent = `📂 ${nomeLimpo}`;
            select.appendChild(option);
        });

        // 2. Preenche a Lista de Baixo (Downloads + Navegação)
        if (listaUl) {
            listaUl.innerHTML = '';
            
            if (arquivos.length === 0) {
                listaUl.innerHTML = '<li style="color:#777; font-size: 0.9em;">Nenhum arquivo encontrado.</li>';
                return;
            }

            arquivos.forEach(arq => {
                const nomeRaw = arq.name.split('/')[1]; 
                const nomeLimpo = nomeRaw.replace('.tar.gz', '');
                const tamanho = (arq.size / 1024 / 1024).toFixed(2);
                const linkDownloadBackup = `/api/download?userId=${currentUserId}&nomeArquivo=${nomeRaw}`;

                const li = document.createElement('li');
                li.style.cssText = "background: #333; margin-bottom: 5px; padding: 10px; border-radius: 4px; border: 1px solid #444;";
                
                li.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight:bold; color:#f1f1f1;">📦 ${nomeLimpo} <small style="color:#aaa; font-weight:normal;">(${tamanho} MB)</small></span>
                        
                        <div>
                            <button onclick="toggleNavegacao('${nomeLimpo}', this)" style="background:#17a2b8; color:white; border:none; padding:6px 12px; cursor:pointer; border-radius:4px; font-size: 0.8em; margin-right: 5px;">
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

// Abre/Fecha a navegação
window.toggleNavegacao = async (nomeBackup, btn) => {
    const container = document.getElementById(`tree-container-${nomeBackup}`);
    
    // Se já está aberto, fecha
    if (container.style.display === 'block') {
        container.style.display = 'none';
        btn.innerText = '📂 Navegar';
        return;
    }

    // Abre e muda o texto do botão
    container.style.display = 'block';
    btn.innerText = '📂 Fechar';

    // Se já temos os dados em cache, não chama o servidor de novo
    if (cacheArquivos[nomeBackup]) {
        desenharArvore(container, cacheArquivos[nomeBackup], nomeBackup);
        return;
    }

    // Busca estrutura no servidor
    try {
        const res = await fetch(`/api/backups/content?userId=${currentUserId}&nomeArquivo=${nomeBackup}`);
        const files = await res.json();
        
        cacheArquivos[nomeBackup] = files; // Salva no cache
        desenharArvore(container, files, nomeBackup);
    } catch (e) { 
        container.innerHTML = '<span style="color:red">Erro ao carregar arquivos.</span>'; 
    }
};

// Prepara o container e chama a renderização recursiva
function desenharArvore(container, todosArquivos, nomeBackup) {
    container.innerHTML = '';
    
    // Filtra nomes vazios ou inválidos
    const listaLimpa = todosArquivos.filter(f => f.name && f.name.trim() !== '');
    
    if (listaLimpa.length === 0) {
        container.innerHTML = '<small style="color:#777">Backup vazio.</small>';
        return;
    }

    // Inicia a renderização a partir da raiz
    container.appendChild(renderizarNivel(listaLimpa, '', nomeBackup));
}

// Função Recursiva que desenha pastas e arquivos
function renderizarNivel(todosArquivos, prefixoAtual, nomeBackup) {
    const ul = document.createElement('ul');
    ul.style.listStyle = 'none';
    ul.style.paddingLeft = '15px';
    ul.style.marginTop = '5px';

    let pastas = new Set();
    let arquivos = [];

    // Separa o que é pasta e o que é arquivo neste nível
    todosArquivos.forEach(file => {
        if (!file.name.startsWith(prefixoAtual)) return;
        
        const relativo = file.name.slice(prefixoAtual.length);
        const partes = relativo.split('/');

        if (partes.length > 1 && partes[0] !== '') {
            pastas.add(partes[0]); // É pasta
        } else if (partes.length === 1 && partes[0] !== '') {
            // É arquivo (ignora se for apenas o nome do diretório terminando em /)
            if (file.type !== 'directory' && !file.name.endsWith('/')) {
                arquivos.push({ ...file, nomeCurto: partes[0] });
            }
        }
    });

    // 1. Renderiza Pastas
    pastas.forEach(nomePasta => {
        const li = document.createElement('li');
        const novoPrefixo = prefixoAtual + nomePasta + '/';
        
        // Link para baixar a pasta inteira
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
        
        // Container dos filhos (invisível por padrão)
        const divFilhos = document.createElement('div');
        divFilhos.style.display = 'none';
        
        // RECURSÃO: Chama a si mesma para preencher o conteúdo
        divFilhos.appendChild(renderizarNivel(todosArquivos, novoPrefixo, nomeBackup));
        
        li.appendChild(divFilhos);
        ul.appendChild(li);
    });

    // 2. Renderiza Arquivos
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

// Chame a função assim que o script carregar
carregarListaDownloads();

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
        
        selectBackup.innerHTML = '<option value="">-- Começar do Zero (Vazio) --</option>';

        arquivos.forEach(arq => {
            const nomeLimpo = arq.name.split('/')[1].replace('.tar.gz', '');
            const option = document.createElement('option');
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

    if (data.masterPodName) {
        console.log("Pod Mestre identificado:", data.masterPodName);
        myMasterPodName = data.masterPodName;
        
        const backupUi = document.getElementById('backup-ui');
        if(backupUi) {
            backupUi.style.display = 'block';
            carregarBackups(); 
            window.atualizarArquivosPod();
        }
    }
});

socket.on('connect_error', (err) => {
    console.error(`Erro de conexão: ${err.message}`);
    term.write(`\r\n[ERRO DE CONEXÃO]: ${err.message}`);
});

// --- LÓGICA DE BACKUP INTERNO (Rodapé) ---

async function carregarBackups() {
    const lista = document.getElementById('lista-backups');
    const status = document.getElementById('status-cota');
    if(!lista) return;

    lista.innerHTML = 'Carregando...';
    await preencherDropdownBackups();

    try {
        const res = await fetch(`/api/backups?userId=${currentUserId}`);
        const arquivos = await res.json();
        
        lista.innerHTML = '';
        let totalSize = 0;

        arquivos.forEach(arq => {
            totalSize += arq.size;
            const nomeParaSalvar = arq.name.split('/')[1].replace('.tar.gz', '');
            const isAtual = (nomeParaSalvar === currentLoadedBackup);

            const li = document.createElement('li');
            li.style.display = 'flex'; 
            li.style.justifyContent = 'space-between';
            li.style.marginBottom = '5px';
            li.style.padding = '8px';
            li.style.borderRadius = '4px';
            
            if (isAtual) {
                li.style.background = 'rgba(40, 167, 69, 0.2)'; 
                li.style.border = '1px solid #28a745';
            } else {
                li.style.background = '#444';
            }
            
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
            currentLoadedBackup = nomeAlvo;
            socket.emit('update-active-backup', nomeAlvo);

            // Atualiza listas e limpa cache da navegação pois o arquivo mudou
            delete cacheArquivos[nomeAlvo];
            carregarBackups();
            carregarListaDownloads();
            window.atualizarArquivosPod();
            
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
        nome = nome.trim(); 

        const jaExiste = Array.from(selectBackup.options).some(o => o.value === nome);

        if (jaExiste) {
            const confirmar = confirm(`O arquivo "${nome}" JÁ EXISTE!\n\nSe você continuar, o conteúdo antigo será APAGADO e substituído pelo atual.\n\nDeseja SOBRESCREVER?`);
            if (!confirmar) return; 
        }
        window.salvarArquivo(nome);
    });
}

// --- FUNÇÃO RESTAURAR ---
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
            socket.emit('input', 'ls -la\r'); 
        }
    } catch(e) { alert("Erro ao restaurar."); }
};

// 1. Pede a lista para o servidor
window.atualizarArquivosPod = function() {
    if(!myMasterPodName) return;
    socket.emit('list-pod-files', { podName: myMasterPodName });
};

// 2. Recebe a lista e desenha na tela
socket.on('pod-files-list', (files) => {
    const lista = document.getElementById('pod-file-list');
    if(!lista) return; // Proteção caso o elemento não exista ainda
    lista.innerHTML = '';

    if (files.length === 0) {
        lista.innerHTML = '<li style="color:#777; padding:5px;">Pasta vazia.</li>';
        return;
    }

    files.forEach(file => {
        const isDir = file.endsWith('/'); 
        const nome = file;
        
        const li = document.createElement('li');
        li.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid #333;";
        
        if (isDir) {
            li.innerHTML = `<span style="color: #4db8ff;">📁 ${nome}</span>`;
        } else {
            li.innerHTML = `
                <span style="color: #eee;">📄 ${nome}</span>
                <a href="/api/pod/download-file?podName=${myMasterPodName}&fileName=${nome}" target="_blank">
                    <button style="background:#333; color:white; border:1px solid #555; cursor:pointer; border-radius:3px; padding: 2px 6px; font-size: 0.8em;">⬇️</button>
                </a>
            `;
        }
        lista.appendChild(li);
    });
});

// 3. Função para Baixar TUDO (Zipado)
window.baixarTudoPod = function() {
    if(!myMasterPodName) return alert("Terminal não conectado.");
    window.open(`/api/pod/download-file?podName=${myMasterPodName}`, '_blank');
};

// Função global para deletar
window.deletar = async (nome) => {
    if(!confirm('Tem certeza que deseja APAGAR este arquivo permanentemente?')) return;
    
    try {
        await fetch('/api/backups', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUserId, nomeCompleto: nome })
        });
        
        const nomeLimpo = nome.split('/')[1].replace('.tar.gz', '');
        
        // Limpa cache e estado
        delete cacheArquivos[nomeLimpo];
        if(nomeLimpo === currentLoadedBackup) {
            currentLoadedBackup = null;
        }

        await carregarListaDownloads(); 
        await carregarBackups();

        alert('Arquivo apagado.');

    } catch (e) {
        console.error(e);
        alert('Erro ao tentar apagar.');
    }
};