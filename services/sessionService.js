const k8sService = require('./k8sService');

// Configurações de Tempo (em milissegundos)

const INITIAL_DURATION = 60 * 1000;             // 1 minuto
const WARNING_BEFORE = 55 * 1000;               // 55 Segundos antes de acabar
// */
/*
const INITIAL_DURATION = 2 * 60 * 60 * 1000;  // 2 Horas
const WARNING_BEFORE = 20 * 60 * 1000;        // 20 Minutos antes de acabar
// */
// Armazena os timers ativos: { jobId: { killTimer, warnTimer, expiresAt } }
const activeSessions = {};

function startSession(jobId, socket, numMachines) {
    const now = Date.now();
    const expiresAt = now + INITIAL_DURATION;
    
    console.log(`[SESSION] Iniciando monitoramento para ${jobId}. Expira em: ${new Date(expiresAt).toLocaleTimeString()}`);

    // Salva os dados da sessão
    activeSessions[jobId] = {
        socket: socket,
        numMachines: numMachines,
        expiresAt: expiresAt,
        // 1. Timer do Aviso
        warnTimer: setTimeout(() => {
            sendWarning(jobId);
        }, INITIAL_DURATION - WARNING_BEFORE),
        // 2. Timer da Morte (Kill)
        killTimer: setTimeout(() => {
            terminateSession(jobId);
        }, INITIAL_DURATION)
    };

    return expiresAt;
}

function sendWarning(jobId) {
    const session = activeSessions[jobId];
    if (session && session.socket) {
        console.log(`[SESSION] Enviando aviso de expiração para ${jobId}`);
        session.socket.emit('session:warning', { 
            timeLeft: WARNING_BEFORE / 60000 
        });
    }
}

function extendSession(jobId, timeExtend) {
    const session = activeSessions[jobId];
    if (!session) return false;

    console.log(`[SESSION] Estendendo sessão ${jobId}`);

    // 1. Limpa os timers antigos para não dispararem errado
    clearTimeout(session.warnTimer);
    clearTimeout(session.killTimer);

    // 2. Calcula novos tempos
    const now = Date.now();
    const maxTime = 1000 * 60 * 60 * 24;
    let newExpiration = session.expiresAt + timeExtend;
    if ((newExpiration - now) > maxTime) newExpiration = now + maxTime; 

    // Calcula quanto tempo falta a partir de AGORA até a nova expiração
    const timeRemaining = newExpiration - now;

    // Atualiza o objeto
    session.expiresAt = newExpiration;

    // 3. Recria os timers
    session.warnTimer = setTimeout(() => {
        sendWarning(jobId);
    }, timeRemaining - WARNING_BEFORE);

    session.killTimer = setTimeout(() => {
        terminateSession(jobId);
    }, timeRemaining);
    
    return newExpiration;
}

function restoreSession(jobId, newSocket) {
    const session = activeSessions[jobId];
    if(!session) return false;
    session.socket = newSocket;
    const { expiresAt, numMachines } = session;
    return { expiresAt, numMachines };
}

async function terminateSession(jobId) {
    const session = activeSessions[jobId];
    if (session) {
        console.log(`[SESSION] Tempo esgotado para ${jobId}. Encerrando...`);
        
        // Avisa o usuário se ele ainda estiver conectado
        session.socket.emit('session:expired');
        session.socket.disconnect(true); // Força desconexão
        
        // Limpa recursos do Kubernetes
        const secretName = `ssh-keys-${jobId}`;
        await k8sService.cleanupJob(jobId, secretName);

        // Remove da memória
        clearSession(jobId);
    }
}

// Função para limpar a memória se o usuário sair voluntariamente
function clearSession(jobId) {
    if (activeSessions[jobId]) {
        clearTimeout(activeSessions[jobId].warnTimer);
        clearTimeout(activeSessions[jobId].killTimer);
        delete activeSessions[jobId];
    }
}

module.exports = { startSession, extendSession, restoreSession, clearSession };
