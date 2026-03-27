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
        sockets: new Set([socket]),
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
  if (session && session.sockets) {
    console.log(`[SESSION] Enviando aviso de expiração para ${jobId}`);
    session.sockets.forEach(socket => {
      socket.emit("session:warning");
    });
  }
}

async function extendSession(jobId, timeExtend) {
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
    await k8sService.updateJobExpiration(jobId, newExpiration);

    // 3. Recria os timers
    session.warnTimer = setTimeout(() => {
        sendWarning(jobId);
    }, timeRemaining - WARNING_BEFORE);

    session.killTimer = setTimeout(() => {
        terminateSession(jobId);
    }, timeRemaining);
    
    // Manda o aviso para todos os sockets
    if (session.sockets) {
        session.sockets.forEach(socket => {
            socket.emit('session:update', { expiresAt: newExpiration });
        });
    }
}

function restoreSession(jobId, newSocket) {
    const session = activeSessions[jobId];
    if(!session) return false;

    session.sockets.add(newSocket);

    const { expiresAt, numMachines } = session;
    return { expiresAt, numMachines };
}

async function terminateSession(jobId) {
    const session = activeSessions[jobId];
    if (session && session.sockets) {
      session.sockets.forEach(socket => {
        socket.emit('session:expired');
        socket.disconnect(true); 
      });
    }
    
    try {
        const secretName = `ssh-keys-${jobId}`;
        await k8sService.cleanupJob(jobId, secretName);
        console.log(`[SESSION] K8s limpo com sucesso para ${jobId}.`);
    } catch (err) {
        console.error(`[ERRO] Falha ao limpar K8s do job ${jobId}:`, err);
    }

    clearSession(jobId);
}

function clearSession(jobId) {
    if (activeSessions[jobId]) {
        clearTimeout(activeSessions[jobId].warnTimer);
        clearTimeout(activeSessions[jobId].killTimer);
        delete activeSessions[jobId];
    }
}

async function syncSessionsK8s() {
  const sessionsK8s = await k8sService.getActiveJobs();

  for (const session of sessionsK8s) {
    const timeLeft = session.expiresAt - Date.now();
    if (timeLeft <= 0) {
      terminateSession(session.jobId);
    } else {
      console.log(`[SYNC] Restaurando timers`);
      
      const warnTimeLeft = timeLeft - WARNING_BEFORE; 
      
      activeSessions[session.jobId] = {
        expiresAt: session.expiresAt,
        numMachines: session.numMachines,
        sockets: new Set(),
        
        killTimer: setTimeout(() => {
          terminateSession(session.jobId);
        }, timeLeft),
       
        warnTimer: warnTimeLeft > 0 
          ? setTimeout(() => {
              sendWarning(session.jobId); 
            }, warnTimeLeft)
          : setTimeout(() => {
              sendWarning(session.jobId);
            }, null)
      };
    }
  }
}

function removeSocket(jobId, socketToRemove) {
  const session = activeSessions[jobId];
  if ( session && session.sockets) {
    session.sockets.delete(socketToRemove);
  }
}

module.exports = { startSession, extendSession, restoreSession, terminateSession, syncSessionsK8s, removeSocket };
