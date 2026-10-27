const k8sService = require('./k8sService');
const sshService = require('./sshService');
const minioService = require('./minioService');
const sessionService = require('./sessionService');

module.exports = (io) => {
    io.on('connection', (socket) => {
        const session = socket.request.session;
        let userId = session ? session.userId : null;
        let platformId = session ? session.platformId : null;

        if (!userId && process.env.NODE_ENV === 'development') {
            userId = 'devUser';
            platformId = 'devPlatform';
        }

        socket.data.userId = userId;
        socket.data.platformId = platformId;
        socket.data.activeBackupName = null;

        // Se o aluno já tiver um ambiente ativo no cluster (em qualquer computador/navegador), avisa para reconectar
        if (userId) {
            const existingSession = sessionService.getSessionByUserId(userId, platformId);
            if (existingSession) {
                socket.emit('session:active-found', {
                    jobId: existingSession.jobId,
                    numMachines: existingSession.numMachines,
                    expiresAt: existingSession.expiresAt,
                    activeBackupName: existingSession.activeBackupName
                });
            }
        }

        socket.on('start-session', async (data) => {
            let { numMachines, image, backupName } = data;
            const currentUserId = socket.data.userId;
            const currentPlatformId = socket.data.platformId;

            if (!currentUserId) {
                socket.emit('output', '⛔ Erro: Sessão inválida ou expirada. Recarregue a página no Moodle.\r\n');
                return;
            }

            // Se já existir sessão ativa para este aluno no cluster, reconecta diretamente
            const existingSession = sessionService.getSessionByUserId(currentUserId, currentPlatformId);
            if (existingSession) {
                socket.emit('session:active-found', {
                    jobId: existingSession.jobId,
                    numMachines: existingSession.numMachines,
                    expiresAt: existingSession.expiresAt,
                    activeBackupName: existingSession.activeBackupName
                });
                return;
            }

            const safeUser = String(currentUserId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
            const jobId = `job-${safeUser}-${Date.now().toString(36)}`;
            const secretName = `ssh-keys-${jobId}`;

            socket.data.jobId = jobId;
            socket.data.activeBackupName = backupName || null;

            socket.emit('output', `\r\nIniciando ${numMachines} nós usando a imagem ${image}...\r\n`);
            
            try {
                socket.emit('output', 'Gerando chaves e configuração SSH...\r\n');
                const keys = await sshService.generateSSHKeys();

                const expiresAt = sessionService.startSession(jobId, socket, numMachines, currentUserId, backupName, currentPlatformId);
                socket.emit('session:update', { expiresAt: expiresAt });

                // Criar a infraestrutura
                const clusterInfo = {
                    jobId, 
                    numMachines, 
                    image, 
                    keys, 
                    expiresAt,
                    userId: currentUserId,
                    platformId: currentPlatformId,
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

                await connectTerminal(io, socket, jobId, 'master', masterPodName);
                
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

                await connectTerminal(io, socket, jobId, requestedMachine, podName);
                
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
            socket.data.activeBackupName = novoNome;
        });

        socket.on("kill-session", async () => {
            const jobId = socket.data.jobId;
            if (!jobId) return;

            await sessionService.terminateSession(jobId);
        });

        socket.on("disconnect", async () => {
            const { jobId } = socket.data;
            if (!jobId) return;
            sessionService.removeSocket(jobId, socket);
        });
    });
};

async function connectTerminal(io, socket, jobId, machineName, podName) {
    socket.data.jobId = jobId;
    socket.data.machine = machineName;

    const roomName = `term:${jobId}:${machineName}`;

    // Encerra qualquer aba ou PC anterior conectado nesta mesma máquina
    const existingSocketIds = io.sockets.adapter.rooms.get(roomName);
    if (existingSocketIds) {
        const socketIdsToDisconnect = Array.from(existingSocketIds).filter(id => id !== socket.id);
        for (const oldId of socketIdsToDisconnect) {
            const oldSocket = io.sockets.sockets.get(oldId);
            if (oldSocket) {
                oldSocket.emit('session:superseded', {
                    message: 'Nova aba aberta em outro local.<br>A conexão atual foi encerrada.'
                });
                oldSocket.leave(roomName);
                oldSocket.disconnect(true);
            }
        }
    }

    socket.join(roomName);

    let termEntry = sessionService.getTerminal(jobId, machineName);

    // Se já existe uma conexão ativa com o shell deste pod e ainda está aberta:
    if (termEntry && termEntry.execWs && termEntry.execWs.readyState === 1) {
        // Restaura imediatamente todo o buffer de visualização do terminal para o aluno nesta aba/computador
        if (termEntry.buffer) {
            socket.emit('output', termEntry.buffer);
        }

        setupTerminalInput(socket, termEntry.execWs);
        return;
    }

    // Cria nova conexão se não existir ou se tiver sido fechada
    const execWs = await k8sService.connectPodToTerminal(podName, ['/bin/bash']);
    const previousBuffer = termEntry ? termEntry.buffer : '';

    termEntry = {
        execWs: execWs,
        buffer: previousBuffer
    };
    sessionService.setTerminal(jobId, machineName, termEntry);

    // Se havia histórico visual prévio, envia para a tela do aluno
    if (previousBuffer) {
        socket.emit('output', previousBuffer);
    }

    setupTerminalInput(socket, execWs);

    execWs.onmessage = (event) => {
        const buffer = Buffer.from(event.data);
        const channel = buffer[0];
        const message = buffer.toString('utf-8').substring(1);

        if (channel === 3) return;

        // Armazena no buffer persistente para manter a visualização de comandos e processos
        sessionService.appendTerminalBuffer(jobId, machineName, message);

        // Envia para todas as abas e dispositivos conectados neste mesmo pod
        io.to(roomName).emit('output', message);
    };

    execWs.onclose = () => {
        io.to(roomName).emit('output', '\r\n[Sessão do terminal encerrada pelo cluster.]\r\n');
        const term = sessionService.getTerminal(jobId, machineName);
        if (term) term.execWs = null;
    };
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
