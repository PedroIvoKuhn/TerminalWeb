const { k8sExec, namespace } = require('../config/kubernetes');
const k8sService = require('./k8sService');
const sshService = require('./sshService');
const sessionService = require('./sessionService');
const { V1TopologySelectorTerm } = require('@kubernetes/client-node');

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

                await connectTerminal(socket, jobId, masterPodName);
            } catch (err) {
                await handlePodError(err, socket, jobId, secretName);
            }
        });

        socket.on('session:extend-response', () => {
          handleExtendSession(socket, 1000 * 60); // 1 minuto 
        });

        socket.on('session:extend-24h', () => {
          console.log('chamando handle');
          handleExtendSession(socket, 1000 * 60 * 60 * 24);
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

                await connectTerminal(socket, jobId, masterPodName);
            } catch (err) {
                await handlePodError(err, socket, jobId, secretName);
            }
        });

        socket.on("kill-session", async () => {
            const jobId = socket.data.jobId;
            if (!jobId) return;

            const secretName = `ssh-keys-${jobId}`;
            sessionService.clearSession(jobId);
            await k8sService.cleanupJob(jobId, secretName);
            socket.emit("session:expired")
        })
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
    socket.on('input', (data) => { 
        if (execWs && execWs.readyState === 1) { 
            execWs.send(Buffer.from('\x00' + data)); 
        } 
    });
}

async function handlePodError(err, socket, jobId, secretName) {
    console.error('Erro no ciclo de vida do Pod:', err);
    socket.emit('output', `\r\n[ERRO DO BACKEND]: ${err.message}\r\nIniciando limpeza...`);
    await k8sService.cleanupJob(jobId, secretName);
}

function handleExtendSession(socket, timeExtend) {
  const newExpiresAt = sessionService.extendSession(socket.data.jobId, timeExtend);
    if (newExpiresAt) {
      socket.emit('session:update', { expiresAt: newExpiresAt });
    }
}
