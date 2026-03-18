const { k8sExec, namespace } = require('../config/kubernetes');
const k8sService = require('./k8sService');
const sshService = require('./sshService');
const sessionService = require('./sessionService');

module.exports = (io) => {
    io.on('connection', (socket) => {
        socket.on('start-session', async ({numMachines, image}) => {
            const jobId = `job-${socket.id.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
            const secretName = `ssh-keys-${jobId}`;
            socket.data.jobId = jobId;

            socket.emit('output', `\r\nIniciando ${numMachines} nós usando a imagem ${image}...\r\n`);
            
            try {
                // Gerar Chaves
                socket.emit('output', 'Gerando chaves e configuração SSH...\r\n');
                const keys = await sshService.generateSSHKeys();

                // Criar a infraestrutura
                const { masterPodName } = await k8sService.createClusterResources(jobId, numMachines, image, keys);
                socket.emit('output', `Pods criados. Aguardando o nó mestre ficar pronto...\r\n`);

                // Esperar ficar pronto
                await k8sService.waitForPodRunning(masterPodName);

                const expiresAt = sessionService.startSession(jobId, socket, numMachines);
                socket.emit('session:update', { expiresAt: expiresAt });

                const machineAliases = ['master'];
                for (let i = 1; i < numMachines; i++) {
                    machineAliases.push(`worker-${i}`);
                }

                socket.emit('session-ready', { 
                    aliases: machineAliases,
                    jobId: jobId });

                socket.emit('output', `\r\n✅ Conectado! Apelidos SSH configurados.\r\n`);
                socket.emit('output', `Tente: ssh worker-1 \r\n\r\n`);

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
                
                socket.on('input', (data) => { 
                    if (execWs && execWs.readyState === 1) { 
                        execWs.send(Buffer.from('\x00' + data)); 
                    } 
                });

                execWs.onmessage = (event) => { 
                    socket.emit('output', event.data.toString().substring(1)); 
                };

                execWs.onclose = async () => { 
                    socket.emit('output', '\r\n[Sessão do terminal encerrada pelo usuário. O cluster continuará rodando até o tempo expirar.]\r\n');
                    socket.emit('output', 'Dê um F5 (Atualizar a página) para abrir um novo terminal neste mesmo cluster.\r\n'); 
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

        socket.on('restore-session', async ({ jobId }) => {
            const secretName = `ssh-keys-${jobId}`;
            const masterPodName = `master-${jobId}`;
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

                socket.emit('session-ready', { 
                    aliases: machineAliases,
                    jobId: jobId });

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

                socket.on('input', (data) => { 
                    if (execWs && execWs.readyState === 1) { 
                        execWs.send(Buffer.from('\x00' + data)); 
                    } 
                });

                execWs.onmessage = (event) => { 
                    socket.emit('output', event.data.toString().substring(1)); 
                };

                execWs.onclose = async () => { 
                    socket.emit('output', '\r\n[Sessão do terminal encerrada pelo usuário. O cluster continuará rodando até o tempo expirar.]\r\n');
                    socket.emit('output', 'Dê um F5 (Atualizar a página) para abrir um novo terminal neste mesmo cluster.\r\n');
                };
            } catch (err) {
                console.error('Erro no ciclo de vida do Pod:', err);
                socket.emit('output', `\r\n[ERRO DO BACKEND]: ${err.message}\r\nIniciando limpeza...`);
                await k8sService.cleanupJob(jobId, secretName);
            }
        });
    });
};