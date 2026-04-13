const { k8sExec, namespace } = require('../config/kubernetes');
const k8sService = require('./k8sService');
const sshService = require('./sshService');
const minioService = require('./minioService');
const sessionService = require('./sessionService');

module.exports = (io) => {
    io.on('connection', (socket) => {
        const session = socket.request.session;
        let userId = session ? session.userId : null;

        if (!userId && process.env.NODE_ENV === 'development') {
            userId = 'devUser';
        }

        console.log(`[Socket] Conectado. UserID da Sessão: ${userId}`);
        socket.data.userId = userId;
        socket.data.activeBackupName = null;
        socket.on('start-session', async (data) => {
            let { numMachines, image, backupName } = data;
            const currentUserId = socket.data.userId;

            if (!currentUserId) {
                console.log("[Socket] Bloqueio: Usuário não identificado.");
                socket.emit('output', '⛔ Erro: Sessão inválida ou expirada. Recarregue a página no Moodle.\r\n');
                return;
            }

            const jobId = `job-${socket.id.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
            const secretName = `ssh-keys-${jobId}`;
            // Guardamos os dados importantes na memória do socket
            socket.data.jobId = jobId;
            // Se ele começou com um arquivo, esse é o ativo. Se começou do zero, é null.
            socket.data.activeBackupName = backupName || null;

            socket.emit('output', `\r\nIniciando ${numMachines} nós usando a imagem ${image}...\r\n`);
            
            try {
                // Gerar Chaves
                socket.emit('output', 'Gerando chaves e configuração SSH...\r\n');
                const keys = await sshService.generateSSHKeys();
              
                // Iniciar contador
                const expiresAt = sessionService.startSession(jobId, socket, numMachines);
                socket.emit('session:update', { expiresAt: expiresAt });

                // Criar a infraestrutura
                const { masterPodName } = await k8sService.createClusterResources(jobId, numMachines, image, keys, expiresAt, numMachines);
                socket.emit('output', `Pods criados. Aguardando o nó mestre ficar pronto...\r\n`);

                // Esperar ficar pronto
                await k8sService.waitForPodRunning(masterPodName);

                if (backupName) {
                    socket.emit('output', `📦 Restaurando backup: "${backupName}"... `);
                    try {
                        // Chama aquela função de restaurar que criamos antes
                        await minioService.restaurarBackup(userId, masterPodName, backupName);
                        socket.emit('output', `[OK]\r\n`);
                    } catch (restoreErr) {
                        console.error(restoreErr);
                        socket.emit('output', `[FALHA AO RESTAURAR]: ${restoreErr.message}\r\n`);
                    }
                }

                const machineAliases = ['master'];
                for (let i = 1; i < numMachines; i++) {
                    machineAliases.push(`worker-${i}`);
                }

                await connectTerminal(socket, jobId, masterPodName);
                
                socket.emit('session-ready', { 
                    aliases: machineAliases,
                    jobId: jobId 
                });
                socket.emit('output', `\r\n✅ Conectado! Apelidos SSH configurados.\r\n`);
                socket.emit('output', `Tente: ssh worker-1 \r\n\r\n`);
            } catch (err) {
                await handlePodError(err, socket, jobId, secretName);
            }
        });

        socket.on('session:extend-response', async () => {
          await sessionService.extendSession(socket.data.jobId, 1000 * 60 * 60);
        });

        socket.on('update-active-backup', (novoNome) => {
            console.log(`[Socket] Backup ativo atualizado para: ${novoNome}`);
            socket.data.activeBackupName = novoNome;
        });

        socket.on('session:extend-24h', async () => {
          await sessionService.extendSession(socket.data.jobId, 1000 * 60 * 60 * 24);
        });

        socket.on('restore-session', async ({ jobId, machine }) => {
            const secretName = `ssh-keys-${jobId}`;
            const requestedMachine = machine || "master";
            const podName = `${requestedMachine}-${jobId}`;
            socket.data.jobId = jobId;
           
            try {
                const oldSession = sessionService.restoreSession(jobId, socket);
                if(!oldSession){
                    socket.emit('session:expired', "Sua sessão expirou");
                    return;
                }
                const { expiresAt, numMachines } = oldSession;
                socket.emit('session:update', { expiresAt: expiresAt });

                const machineAliases = ['master'];
                for (let i = 1; i < numMachines; i++) {
                    machineAliases.push(`worker-${i}`);
                }

                await connectTerminal(socket, jobId, podName);
                
                socket.emit('session-ready', { 
                    aliases: machineAliases,
                    jobId: jobId 
                });

                if (!machineAliases.includes(requestedMachine)) {
                  socket.emit('output', `\r\n[ERRO] A máquina '${requestedMachine}' não existe neste cluster. Se você deseja mais máquinas crie uma nova sessão.\r\n`);
                  return; 
                }
            } catch (err) {
                await handlePodError(err, socket, jobId, secretName);
            }
        });

        socket.on("kill-session", async () => {
            const jobId = socket.data.jobId;
            if (!jobId) return;

            await sessionService.terminateSession(jobId);
        });

        socket.on("disconnect", async () => {
            const { jobId, userId, activeBackupName } = socket.data;
            const masterPodName = `master-${jobId}`;
            if (!jobId) return;

            if (userId && activeBackupName && masterPodName) {
                    console.log(`[Auto-Save] Salvando automaticamente em: ${activeBackupName}`);
                    try {
                        // Tenta salvar antes de destruir
                        await minioService.salvarBackup(userId, masterPodName, activeBackupName);
                        console.log(`[Auto-Save] Sucesso!`);
                    } catch (err) {
                        console.error(`[Auto-Save] Falha ao salvar no encerramento:`, err.message);
                    }
                }

            sessionService.removeSocket(jobId, socket);
        });
    });
};

async function connectTerminal(socket, jobId, masterPodName) {
    const command = ['/bin/bash'];
    const execWs = await k8sExec.exec(
        namespace, 
        masterPodName, 
        'container', 
        command, 
        process.stdout, 
        process.stderr, 
        process.stdin, 
        true);

    setupTerminalInput(socket, execWs);
    execWs.onmessage = (event) => handleTerminalOutput(event, socket, jobId);
    execWs.onclose = () => handleTerminalClose(socket);

    return execWs;
}

function handleTerminalOutput(event, socket, jobId) {
    const buffer = Buffer.from(event.data);
    const channel = buffer[0];
    const message = buffer.toString('utf-8').substring(1);

    if ( channel === 3 ) {
        try {
            const statusObj = JSON.parse(message);
            if (statusObj.status === 'Failure' && statusObj.message && statusObj.message.includes('137')) {
                console.log(`[k8s] Job ${jobId} encerrado com sucesso (Exit 137).`);
            } else {
                console.log(`[k8s STATUS ERRO - ${jobId}]:`, statusObj.message || statusObj.reason);
            }
        } catch ( e ) {
            console.log(`[k8s STATUS RAW - ${jobId}]:`, message);
        }
        return;
    }
    socket.emit('output', message);
}

function handleTerminalClose(socket) {
    socket.emit('output', '\r\n[Sessão do terminal encerrada pelo usuário. O cluster continuará rodando até o tempo expirar.]\r\n');
}

function setupTerminalInput(socket, execWs) {
    // evita enviar uma letra duas vezes se for chamado novamente
    socket.removeAllListeners('input');
    socket.removeAllListeners('resize');

    socket.on('input', (data) => { 
        if (execWs && execWs.readyState === 1) { 
            execWs.send(Buffer.from('\x00' + data)); 
        } 
    });

    socket.on('resize', ({ cols, rows }) => {
        if (execWs && execWs.readyState === 1) {
            const resizeMsg = JSON.stringify({ Width: cols, Height: rows });
            execWs.send(Buffer.from('\x04' + resizeMsg));
        }
    });
}

async function handlePodError(err, socket, jobId, secretName) {
    console.error('Erro no ciclo de vida do Pod:', err);
    socket.emit('output', `\r\n[ERRO DO BACKEND]: ${err.message}\r\nIniciando limpeza...`);
    await k8sService.cleanupJob(jobId, secretName);
}
