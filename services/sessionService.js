const k8sService = require('./k8sService');
const minioService = require('./minioService');

// Configurações de Tempo (em milissegundos)
/*
const INITIAL_DURATION = 20 * 60 * 1000 + 6 * 1000;             // 1 minuto
const WARNING_BEFORE =  20 * 60 * 1000;              // 55 Segundos antes de acabar
// */

const INITIAL_DURATION = 2 * 60 * 60 * 1000;  // 2 Horas
const WARNING_BEFORE = 20 * 60 * 1000;        // 20 Minutos antes de acabar
// */
// Armazena os timers ativos: { jobId: { killTimer, warnTimer, expiresAt } }
const activeSessions = {};

function startSession(jobId, socket, numMachines, userId, backupName, platformId = 'moodle') {
    const now = Date.now();
    const expiresAt = now + INITIAL_DURATION;
    
    // Salva os dados da sessão
    activeSessions[jobId] = {
        sockets: new Set([socket]),
        numMachines: numMachines,
        expiresAt: expiresAt,
        userId: userId,
        platformId: platformId || 'moodle',
        activeBackupName: backupName,
        terminals: {}, // armazena { execWs, buffer, disconnectTimer } por máquina
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
    session.sockets.forEach(socket => {
      socket.emit("session:warning");
    });
  }
}

async function extendSession(jobId, timeExtend) {
    const session = activeSessions[jobId];
    if (!session) return false;

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

async function terminateSession(jobId, fallbackSession = null) {
    const session = activeSessions[jobId] || fallbackSession;
    if (session && session.sockets) {
      session.sockets.forEach(socket => {
        socket.emit('session:expired');
        socket.disconnect(true); 
      });
    }
    
    try {
        const secretName = `ssh-keys-${jobId}`;
        const masterPodName = `master-${jobId}`;

        if (session && session.userId && session.activeBackupName && masterPodName) {
          try {
            await minioService.saveBackup(session.userId, masterPodName, session.activeBackupName);
          } catch (err) {
            console.error(`[Auto-Save] Falha ao salvar no encerramento:`, err.message);
          }
        }

        await k8sService.cleanupJob(jobId, secretName);
    } catch (err) {
        console.error(`[ERRO] Falha ao limpar K8s do job ${jobId}:`, err);
    }

    clearSession(jobId);
}

function clearSession(jobId) {
    if (activeSessions[jobId]) {
        clearTimeout(activeSessions[jobId].warnTimer);
        clearTimeout(activeSessions[jobId].killTimer);
        if (activeSessions[jobId].terminals) {
            for (const key of Object.keys(activeSessions[jobId].terminals)) {
                const termEntry = activeSessions[jobId].terminals[key];
                if (termEntry && termEntry.execWs) {
                    try { termEntry.execWs.close(); } catch (e) {}
                }
            }
        }
        delete activeSessions[jobId];
    }
}

async function syncSessionsK8s() {
  const sessionsK8s = await k8sService.getActiveJobs();

  for (const session of sessionsK8s) {
    const timeLeft = session.expiresAt - Date.now();
    if (timeLeft <= 0) {
      await terminateSession(session.jobId, session);
    } else {
      const warnTimeLeft = timeLeft - WARNING_BEFORE; 
      
      activeSessions[session.jobId] = {
        expiresAt: session.expiresAt,
        numMachines: session.numMachines,
        userId: session.userId,
        platformId: session.platformId || 'moodle',
        activeBackupName: session.activeBackupName,
        terminals: {},
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
            }, 0)
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

function getSessionByUserId(userId, platformId = null) {
  if (!userId) return null;
  const userIdStr = String(userId);
  for (const [jobId, session] of Object.entries(activeSessions)) {
    if (session.userId && String(session.userId) === userIdStr) {
      if (platformId && session.platformId && String(session.platformId) !== String(platformId)) {
        continue;
      }
      return { jobId, ...session };
    }
  }
  return null;
}

function verifyUserPod(userId, podName) {
  if (process.env.NODE_ENV === 'development' && (!userId || userId === 'devUser')) {
    return true;
  }
  if (!userId || !podName) return false;

  for (const [jobId, session] of Object.entries(activeSessions)) {
    if (String(session.userId) === String(userId)) {
      if (podName.includes(jobId) || podName === `master-${jobId}` || podName.startsWith(`worker-`)) {
        return true;
      }
    }
  }
  return false;
}

function getTerminal(jobId, machine = 'master') {
  const session = activeSessions[jobId];
  if (!session) return null;
  if (!session.terminals) session.terminals = {};
  return session.terminals[machine] || null;
}

function setTerminal(jobId, machine = 'master', termEntry) {
  const session = activeSessions[jobId];
  if (!session) return;
  if (!session.terminals) session.terminals = {};
  session.terminals[machine] = termEntry;
}

function appendTerminalBuffer(jobId, machine = 'master', text) {
  const session = activeSessions[jobId];
  if (!session) return;
  if (!session.terminals) session.terminals = {};
  if (!session.terminals[machine]) {
    session.terminals[machine] = { execWs: null, buffer: '' };
  }
  const current = session.terminals[machine].buffer || '';
  // Mantém no máximo os últimos 200KB (~3000 linhas de histórico/processos)
  session.terminals[machine].buffer = (current + text).slice(-200000);
}

module.exports = { 
  startSession, 
  extendSession, 
  restoreSession, 
  terminateSession, 
  syncSessionsK8s, 
  removeSocket, 
  verifyUserPod, 
  getSessionByUserId,
  getTerminal,
  setTerminal,
  appendTerminalBuffer
};
