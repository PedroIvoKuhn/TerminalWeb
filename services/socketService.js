const k8sService = require('./k8sService');
const sshService = require('./sshService');
const minioService = require('./minioService');
const sessionService = require('./sessionService');
const cloudBurstingService = require('./cloudBurstingService');

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
            const jobId = `job-${socket.id.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
            const secretName = `ssh-keys-${jobId}`;
            const currentUserId = socket.data.userId;

            socket.data.jobId = jobId;
            socket.data.activeBackupName = backupName || null;

            if (!currentUserId) {
                console.log("[Socket] Bloqueio: Usuário não identificado.");
                socket.emit('output', '⛔ Erro: Sessão inválida ou expirada. Recarregue a página no Moodle.\r\n');
                return;
            }

            socket.emit('output', `\r\nIniciando ${numMachines} nós usando a imagem ${image}...\r\n`);
            
            try {
                socket.emit('output', 'Gerando chaves e configuração SSH...\r\n');
                const keys = await sshService.generateSSHKeys();

                const expiresAt = sessionService.startSession(jobId, socket, numMachines, currentUserId, backupName);
                socket.emit('session:update', { expiresAt: expiresAt });

                // Criar a infraestrutura
                const clusterInfo = {
                    jobId, 
                    numMachines, 
                    image, 
                    keys, 
                    expiresAt,
                    userId: currentUserId,
                    activeBackupName: backupName,
                };
                const { masterPodName } = await k8sService.createClusterResources(clusterInfo);
                socket.emit('output', `Pods criados. Aguardando o nó mestre ficar pronto...\r\n`);

                await k8sService.waitForPodRunning(masterPodName);

                if (backupName) {
                    socket.emit('output', `📦 Restaurando backup: "${backupName}"... `);
                    try {
                        await minioService.restoreBackup(userId, masterPodName, backupName);
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
                    jobId: jobId,
                    masterPodName: masterPodName 
                });
                socket.emit('output', `\r\n✅ Conectado! Apelidos SSH configurados.\r\n`);
                socket.emit('output', `Tente: ssh worker-1 \r\n\r\n`);
            } catch (err) {
                await handlePodError(err, socket, jobId, secretName);
            }
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
                    jobId: jobId,
                    masterPodName: `master-${jobId}` 
                });

                if (!machineAliases.includes(requestedMachine)) {
                  socket.emit('output', `\r\n[ERRO] A máquina '${requestedMachine}' não existe neste cluster. Se você deseja mais máquinas crie uma nova sessão.\r\n`);
                  return; 
                }
            } catch (err) {
                await handlePodError(err, socket, jobId, secretName);
            }
        });

        socket.on('session:extend-response', async () => {
          await sessionService.extendSession(socket.data.jobId, 1000 * 60 * 60);
        });

        socket.on('session:extend-24h', async () => {
          await sessionService.extendSession(socket.data.jobId, 1000 * 60 * 60 * 24);
        });

        socket.on('update-active-backup', (novoNome) => {
            console.log(`[Socket] Backup ativo atualizado para: ${novoNome}`);
            socket.data.activeBackupName = novoNome;
        });

        socket.on("kill-session", async () => {
            const jobId = socket.data.jobId;
            if (!jobId) return;

            await sessionService.terminateSession(jobId);
        });

        socket.on('burst:get-info', () => {
            const provider = (process.env.CLOUD_PROVIDER || 'AWS').toUpperCase();
            socket.emit('burst:info', { provider });
        });

        socket.on('burst:start', async () => {
            await handleSessionBurst(socket);
        });

        socket.on("disconnect", async () => {
            socket.data.isDisconnected = true;
            socket.data.burstCancelled = true;
            const { jobId, execWs } = socket.data;

            if (execWs) {
                try {
                    execWs.close();
                } catch (error) {
                    execWs.terminate();
                }
                console.log(`[Socket] Conexão K8s-Exec fechada junto com o socket`);
            }

            if (jobId) {
                sessionService.removeSocket(jobId, socket);
            } else {
                // Limpa quaisquer nós de burst se o usuário fechar a página antes de iniciar o terminal
                await sessionService.cleanupPendingBurst(socket.id);
            }
        });
    });
};

async function connectTerminal(socket, jobId, masterPodName) {
    const execWs = await k8sService.connectPodToTerminal(masterPodName);
    socket.data.execWs = execWs;

    setupTerminalInput(socket, execWs);
    execWs.onmessage = (event) => handleTerminalOutput(event, socket, jobId);
    execWs.onclose = () => handleTerminalClose(socket);
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

async function handleSessionBurst(socket) {
    if (socket.data.isBursting) {
        socket.emit('burst:step', { step: 1, message: 'Operação de bursting já está em andamento.' });
        return;
    }

    const provider = (process.env.CLOUD_PROVIDER || 'AWS').toUpperCase();
    socket.data.isBursting = true;
    socket.data.burstCancelled = false;

    let pendingBurstInfo = null;

    try {
        console.log(`[Socket ${socket.id}] Iniciando solicitação de Cloud Bursting para ${provider}...`);
        socket.emit('burst:step', { step: 1, message: `Iniciando validação para nuvem ${provider}...` });

        const result = await cloudBurstingService.addNode({
            provider,
            tags: {
                socketId: socket.id,
                jobId: socket.data.jobId || `pending-${socket.id}`
            },
            onCreated: (createdNodeId, meta = {}) => {
                const nodeName = (meta && meta.nodeName) ? meta.nodeName : createdNodeId;
                const privateDns = (meta && meta.privateDns) ? meta.privateDns : null;
                pendingBurstInfo = {
                    nodeId: createdNodeId,
                    nodeName: nodeName,
                    privateDnsOrHost: privateDns,
                    provider
                };
                sessionService.registerPendingBurst(socket.id, pendingBurstInfo);
                console.log(`[BURST] Nó ${createdNodeId} (${nodeName}) criado e registrado como pendente para o socket ${socket.id}.`);

                // Se o socket desconectou enquanto a VM era provisionada, destrói imediatamente!
                if (socket.disconnected || socket.data.isDisconnected) {
                    console.warn(`[BURST] Socket ${socket.id} já desconectou! Limpando nó ${createdNodeId} imediatamente...`);
                    sessionService.cleanupPendingBurst(socket.id);
                }
            },
            isCancelled: () => {
                return socket.disconnected || socket.data.isDisconnected || socket.data.burstCancelled;
            },
            onProgress: (step, message) => {
                if (!socket.disconnected) {
                    socket.emit('burst:step', { step, message });
                }
            }
        });

        // Se o socket desconectou durante a espera do join
        if (socket.disconnected || socket.data.isDisconnected) {
            console.warn(`[BURST] Socket ${socket.id} desconectou antes da conclusão! Limpando nó pendente...`);
            await sessionService.cleanupPendingBurst(socket.id);
            return;
        }

        // Se o usuário já tiver uma sessão ativa vincula ao JobId
        if (socket.data.jobId) {
            sessionService.registerBurstNode(socket.data.jobId, result);
        } else {
            // Caso contrário, atualiza como pendente com nodeName oficial
            sessionService.registerPendingBurst(socket.id, result);
        }

        socket.data.hasBurstNode = true;
        socket.emit('burst:complete', {
            nodeId: result.nodeId,
            provider: result.provider
        });
        console.log(`[Socket ${socket.id}] Cloud Bursting concluído com sucesso. NodeId: ${result.nodeId}`);
    } catch (err) {
        console.error(`[Socket ${socket.id}] Erro no Cloud Bursting:`, err.message);

        // Se a máquina chegou a ser criada na nuvem mas a operação falhou depois (ou socket fechou), limpa imediatamente!
        if (pendingBurstInfo && pendingBurstInfo.nodeId) {
            console.log(`[BURST] Destruindo máquina ${pendingBurstInfo.nodeId} devido a erro/cancelamento no socket ${socket.id}...`);
            await sessionService.cleanupPendingBurst(socket.id);
        }

        if (!socket.disconnected) {
            socket.emit('burst:error', {
                message: err.message || 'Erro desconhecido ao provisionar nó na nuvem.'
            });
        }
    } finally {
        socket.data.isBursting = false;
    }
}
