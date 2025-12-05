const { k8sExec, namespace } = require('../config/kubernetes');
const k8sService = require('./k8sService');
const sshService = require('./sshService');
const sessionService = require('./sessionService');

module.exports = (io) => {
    io.on('connection', (socket) => {
        socket.on('start-session', async ({numMachines, mpiImage}) => {
            const jobId = `mpi-job-${socket.id.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
            const secretName = `ssh-keys-${jobId}`;
            socket.data.jobId = jobId;

            socket.emit('output', `\r\nIniciando ${numMachines} nós para o job ${jobId} usando a imagem ${mpiImage}...\r\n`);
            
            try {
                // Gerar Chaves
                socket.emit('output', 'Gerando chaves e configuração SSH...\r\n');
                const keys = await sshService.generateSSHKeys();

                // Criar a infraestrutura
                const { masterPodName } = await k8sService.createClusterResources(jobId, numMachines, mpiImage, keys);
                socket.emit('output', `Pods criados. Aguardando o nó mestre (${masterPodName}) ficar pronto...\r\n`);

                // Esperar ficar pronto
                await k8sService.waitForPodRunning(masterPodName);

                const expiresAt = sessionService.startSession(jobId, socket);
                socket.emit('session:update', { expiresAt: expiresAt });

                const machineAliases = ['master'];
                for (let i = 1; i < numMachines; i++) {
                    machineAliases.push(`worker-${i}`);
                }

                socket.emit('session-ready', { aliases: machineAliases });

                socket.emit('output', `\r\n✅ Conectado! Apelidos SSH configurados.\r\n`);
                socket.emit('output', `Tente: ssh worker-1 hostname\r\n\r\n`);

                const command = ['/bin/bash'];
                const execWs = await k8sExec.exec(
                    namespace, 
                    masterPodName, 
                    'mpi-container', 
                    command, 
                    process.stdout, 
                    process.stderr, 
                    process.stdin, 
                    true);
                
                socket.on('input', (data) => { 
                    if (execWs && execWs.readyState === 1) { 
                        execWs.send(Buffer.from('\x00' + data)); 
                    } 
                });

                execWs.onmessage = (event) => { 
                    socket.emit('output', event.data.toString().substring(1)); 
                };

                execWs.onclose = async () => { 
                    socket.emit('output', '\r\n[Sessão no Pod encerrada]');
                    await k8sService.cleanupJob(jobId, secretName); 
                };

            } catch (err) {
                console.error('Erro no ciclo de vida do Pod:', err);
                socket.emit('output', `\r\n[ERRO DO BACKEND]: ${err.message}\r\nIniciando limpeza...`);
                await k8sService.cleanupJob(jobId, secretName);
            }
        });

        socket.on('session:extend-response', () => {
            const newExpiresAt = sessionService.extendSession(socket.data.jobId);
                if (newExpiresAt) {
                    socket.emit('session:update', { expiresAt: newExpiresAt });
                }
        });

        socket.on('disconnect', async () => {
            sessionService.clearSession(socket.data.jobId);
            if (socket.data.jobId) {
                const secretName = `ssh-keys-${socket.data.jobId}`;
                await k8sService.cleanupJob(socket.data.jobId, secretName);
            }
        });
    });
};