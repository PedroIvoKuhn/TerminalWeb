const k8sService = require('./k8sService');
const minioService = require('./minioService');
const cloudBurstingService = require('./cloudBurstingService');

// Configurações de Tempo (em milissegundos)
/*
const INITIAL_DURATION = 20 * 60 * 1000 + 6 * 1000;             // 1 minuto
const WARNING_BEFORE =  20 * 60 * 1000;              // 55 Segundos antes de acabar
// */

const INITIAL_DURATION = 2 * 60 * 60 * 1000;  // 2 Horas
const WARNING_BEFORE = 20 * 60 * 1000;        // 20 Minutos antes de acabar
// */
// Armazena os timers ativos: { jobId: { killTimer, warnTimer, expiresAt, burstNodes } }
const activeSessions = {};

// Armazena nós de burst provisionados antes de iniciar a sessão (indexados por socket.id)
const pendingBursts = {};

function registerPendingBurst(socketId, burstInfo) {
    if (!pendingBursts[socketId]) {
        pendingBursts[socketId] = [];
    }
    const idx = pendingBursts[socketId].findIndex(b => b.nodeId === burstInfo.nodeId);
    if (idx >= 0) {
        pendingBursts[socketId][idx] = { ...pendingBursts[socketId][idx], ...burstInfo };
    } else {
        pendingBursts[socketId].push(burstInfo);
    }
}

function getPendingBursts(socketId) {
    return pendingBursts[socketId] || [];
}

async function cleanupPendingBurst(socketId) {
    const bursts = pendingBursts[socketId];
    if (bursts && bursts.length > 0) {
        console.log(`[BURST] Limpando ${bursts.length} nó(s) de burst pendente(s) para socket ${socketId}...`);
        delete pendingBursts[socketId];
        for (const burst of bursts) {
            try {
                await cloudBurstingService.removeNode(burst);
            } catch (err) {
                console.error(`[BURST] Erro ao limpar nó pendente ${burst.nodeId}:`, err.message);
            }
        }
    }
}

function registerBurstNode(jobId, burstInfo) {
    const session = activeSessions[jobId];
    if (session) {
        if (!session.burstNodes) session.burstNodes = [];
        session.burstNodes.push(burstInfo);
    }
}

function startSession(jobId, socket, numMachines, userId, backupName) {
    const now = Date.now();
    const expiresAt = now + INITIAL_DURATION;
    
    console.log(`[SESSION] Iniciando monitoramento para ${jobId}. Expira em: ${new Date(expiresAt).toLocaleTimeString()}`);

    // Vincula quaisquer nós de burst provisionados antes da inicialização do terminal
    const sessionBurstNodes = pendingBursts[socket.id] || [];
    delete pendingBursts[socket.id];

    // Salva os dados da sessão
    activeSessions[jobId] = {
        sockets: new Set([socket]),
        numMachines: numMachines,
        expiresAt: expiresAt,
        userId: userId,
        activeBackupName: backupName,
        burstNodes: sessionBurstNodes,
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
        const masterPodName = `master-${jobId}`;

        if (session.userId && session.activeBackupName && masterPodName) {
          console.log(`[Auto-Save] Salvando automaticamente em: ${session.activeBackupName}`);
          try {
            await minioService.saveBackup(session.userId, masterPodName, session.activeBackupName);
            console.log(`[Auto-Save] Sucesso!`);
          } catch (err) {
            console.error(`[Auto-Save] Falha ao salvar no encerramento:`, err.message);
          }
        }

        if (session && session.burstNodes && session.burstNodes.length > 0) {
          console.log(`[BURST] Encerrando ${session.burstNodes.length} nó(s) de burst da sessão ${jobId}...`);
          for (const burstNode of session.burstNodes) {
            try {
              await cloudBurstingService.removeNode(burstNode);
              console.log(`[BURST] Nó ${burstNode.nodeId} destruído com sucesso.`);
            } catch (burstErr) {
              console.error(`[BURST] Erro ao destruir nó de burst ${burstNode.nodeId}:`, burstErr.message);
            }
          }
        }

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
      console.log(`[SYNC] Restaurando sessões`);
      
      const warnTimeLeft = timeLeft - WARNING_BEFORE; 
      
      activeSessions[session.jobId] = {
        expiresAt: session.expiresAt,
        numMachines: session.numMachines,
        userId: session.userId,
        activeBackupName: session.activeBackupName,
        burstNodes: [],
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

  // Limpa quaisquer nós de burst órfãos deixados na nuvem em reinicializações anteriores
  await cleanupOrphanBurstNodes();
}

async function cleanupOrphanBurstNodes() {
  try {
    const provider = (process.env.CLOUD_PROVIDER || 'AWS').toUpperCase();
    console.log(`[SYNC] Verificando nós de burst órfãos na nuvem ${provider}...`);
    const burstNodes = await cloudBurstingService.listBurstNodes({ provider });
    
    const activeJobIds = new Set(Object.keys(activeSessions));

    for (const node of burstNodes) {
      const nodeJobId = node.jobId || node.tags?.JobId;
      if (!nodeJobId || String(nodeJobId).startsWith('pending-') || !activeJobIds.has(nodeJobId)) {
        const targetId = node.id || node.name;
        console.log(`[SYNC] Encontrado nó órfão ${targetId} (${nodeJobId}). Removendo...`);
        try {
          await cloudBurstingService.removeNode({
            nodeId: targetId,
            nodeName: targetId,
            provider
          });
        } catch (err) {
          console.warn(`[SYNC AVISO] Erro ao remover nó órfão ${targetId}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.warn(`[SYNC AVISO] Falha ao verificar nós órfãos na inicialização:`, err.message);
  }
}

function removeSocket(jobId, socketToRemove) {
  const session = activeSessions[jobId];
  if ( session && session.sockets) {
    session.sockets.delete(socketToRemove);
  }
}

function hasBurstNodes(jobId) {
  const session = activeSessions[jobId];
  return Boolean(session && session.burstNodes && session.burstNodes.length > 0);
}

function getBurstNodes(jobId) {
  const session = activeSessions[jobId];
  return (session && session.burstNodes) ? session.burstNodes : [];
}

module.exports = { 
    startSession, 
    extendSession, 
    restoreSession, 
    terminateSession, 
    syncSessionsK8s, 
    removeSocket,
    registerPendingBurst,
    getPendingBursts,
    cleanupPendingBurst,
    registerBurstNode,
    hasBurstNodes,
    getBurstNodes
};