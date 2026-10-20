const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
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

// Armazena nós de burst provisionados antes de iniciar a sessão (indexados por userId ou socket.id)
const pendingBursts = {};
const pendingTimers = {};
const socketToOwner = {};

function registerPendingBurst(ownerKey, burstInfo, socketId) {
    if (pendingTimers[ownerKey]) {
        clearTimeout(pendingTimers[ownerKey]);
        delete pendingTimers[ownerKey];
    }
    if (socketId) {
        socketToOwner[socketId] = ownerKey;
    }
    if (!pendingBursts[ownerKey]) {
        pendingBursts[ownerKey] = [];
    }
    const idx = pendingBursts[ownerKey].findIndex(b => b.nodeId === burstInfo.nodeId);
    if (idx >= 0) {
        pendingBursts[ownerKey][idx] = { ...pendingBursts[ownerKey][idx], ...burstInfo };
    } else {
        pendingBursts[ownerKey].push(burstInfo);
    }
}

function getPendingBursts(ownerKeyOrSocketId) {
    const ownerKey = socketToOwner[ownerKeyOrSocketId] || ownerKeyOrSocketId;
    return pendingBursts[ownerKey] || pendingBursts[ownerKeyOrSocketId] || [];
}

function reclaimPendingBurst(socket) {
    const ownerKey = socket.data?.userId || socket.id;
    if (pendingTimers[ownerKey]) {
        console.log(`[BURST] Socket ${socket.id} reconectou para usuário '${ownerKey}'. Cancelando timer de limpeza de nós pendentes.`);
        clearTimeout(pendingTimers[ownerKey]);
        delete pendingTimers[ownerKey];
    }
    socketToOwner[socket.id] = ownerKey;
    return pendingBursts[ownerKey] || [];
}

function schedulePendingBurstCleanup(socket, graceMs = 60000) {
    const ownerKey = socketToOwner[socket.id] || socket.data?.userId || socket.id;
    delete socketToOwner[socket.id];
    const bursts = pendingBursts[ownerKey];
    if (!bursts || bursts.length === 0) return;

    if (pendingTimers[ownerKey]) {
        clearTimeout(pendingTimers[ownerKey]);
    }
    console.log(`[BURST] Socket ${socket.id} desconectou. Carência de ${Math.round(graceMs / 1000)}s antes de limpar ${bursts.length} nó(s) pendente(s) do usuário '${ownerKey}'...`);
    pendingTimers[ownerKey] = setTimeout(async () => {
        delete pendingTimers[ownerKey];
        await cleanupPendingBurst(ownerKey);
    }, graceMs);
}

async function cleanupPendingBurst(ownerKeyOrSocketId) {
    const ownerKey = socketToOwner[ownerKeyOrSocketId] || ownerKeyOrSocketId;
    if (pendingTimers[ownerKey]) {
        clearTimeout(pendingTimers[ownerKey]);
        delete pendingTimers[ownerKey];
    }
    const bursts = pendingBursts[ownerKey];
    if (bursts && bursts.length > 0) {
        console.log(`[BURST] Carência expirou ou cancelamento: limpando ${bursts.length} nó(s) de burst pendente(s) para '${ownerKey}'...`);
        delete pendingBursts[ownerKey];
        delete pendingBursts[ownerKeyOrSocketId];
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

    const ownerKey = socketToOwner[socket.id] || userId || socket.id;
    if (pendingTimers[ownerKey]) {
        clearTimeout(pendingTimers[ownerKey]);
        delete pendingTimers[ownerKey];
    }

    // Vincula quaisquer nós de burst provisionados antes da inicialização do terminal
    const sessionBurstNodes = pendingBursts[ownerKey] || pendingBursts[socket.id] || [];
    delete pendingBursts[ownerKey];
    delete pendingBursts[socket.id];
    delete socketToOwner[socket.id];

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

    const { expiresAt, numMachines, burstNodes } = session;
    return { expiresAt, numMachines, burstNodes: burstNodes || [] };
}

function getActiveSession(jobId) {
    return activeSessions[jobId] || null;
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

let isCleaningUpOrphans = false;

async function cleanupOrphanBurstNodes() {
  if (isCleaningUpOrphans) return;
  isCleaningUpOrphans = true;

  try {
    const activeJobIds = new Set(Object.keys(activeSessions));
    const activeNodeNames = new Set();

    // 1. Mapeia nós de sessões ativas
    for (const session of Object.values(activeSessions)) {
      if (session.burstNodes) {
        for (const bn of session.burstNodes) {
          if (bn.nodeName) activeNodeNames.add(String(bn.nodeName).toLowerCase());
          if (bn.nodeId) activeNodeNames.add(String(bn.nodeId).toLowerCase());
        }
      }
    }

    // 2. Mapeia nós pendentes (criados antes da sessão iniciar no socket)
    for (const bursts of Object.values(pendingBursts)) {
      for (const bn of bursts) {
        if (bn.nodeName) activeNodeNames.add(String(bn.nodeName).toLowerCase());
        if (bn.nodeId) activeNodeNames.add(String(bn.nodeId).toLowerCase());
      }
    }

    // 3. Limpeza de nós órfãos diretamente no Kubernetes
    try {
      const { stdout } = await execAsync('microk8s kubectl get nodes -o json');
      const data = JSON.parse(stdout);
      const k8sNodes = data.items || [];

      for (const n of k8sNodes) {
        const nodeName = n.metadata?.name || '';
        const lowerName = nodeName.toLowerCase();
        const isBurstNode = lowerName.startsWith('burst-node-') || 
                            n.metadata?.labels?.['Role'] === 'CloudBurstingWorker' ||
                            Boolean(n.metadata?.labels?.['tenant']);

        if (isBurstNode && !activeNodeNames.has(lowerName)) {
          // Se o nó foi criado há menos de 5 minutos, concede uma carência
          // para não ejetar nó recém-criado em caso de reinício do nodemon ou reload de página
          const creationTime = n.metadata?.creationTimestamp ? new Date(n.metadata.creationTimestamp).getTime() : 0;
          const nodeAgeMs = Date.now() - creationTime;
          if (creationTime > 0 && nodeAgeMs < 5 * 60 * 1000) {
            console.log(`[SYNC] Nó recente ${nodeName} (${Math.round(nodeAgeMs / 1000)}s de vida) preservado na janela de carência.`);
            continue;
          }

          console.log(`[SYNC] Encontrado nó órfão no Kubernetes: ${nodeName}. Ejetando do cluster...`);
          try {
            await execAsync(`microk8s kubectl delete node ${nodeName}`);
            console.log(`[SYNC] Nó órfão ${nodeName} excluído com sucesso do Kubernetes.`);
          } catch (delErr) {
            console.warn(`[SYNC AVISO] Falha ao excluir nó órfão ${nodeName} do K8s:`, delErr.message);
          }
        }
      }
    } catch (k8sErr) {
      console.warn(`[SYNC AVISO] Falha ao consultar nós do Kubernetes:`, k8sErr.message);
    }

    // 4. Limpeza de instâncias órfãs remanescentes na Nuvem (Azure e AWS)
    const cloudProviders = ['AZURE', 'AWS'];
    for (const provider of cloudProviders) {
      try {
        const burstNodes = await cloudBurstingService.listBurstNodes({ provider });
        for (const node of burstNodes) {
          const nodeJobId = node.jobId || node.tags?.JobId;
          if (!nodeJobId || String(nodeJobId).startsWith('pending-') || !activeJobIds.has(nodeJobId)) {
            const targetId = node.id || node.name;
            console.log(`[SYNC] Encontrado nó órfão ${targetId} (${nodeJobId}) na nuvem ${provider}. Removendo...`);
            try {
              await cloudBurstingService.removeNode({
                nodeId: targetId,
                nodeName: targetId,
                provider
              });
            } catch (err) {
              console.warn(`[SYNC AVISO] Erro ao remover nó órfão ${targetId} da nuvem ${provider}:`, err.message);
            }
          }
        }
      } catch (_) {
        // Silenciosamente ignora provedores que não possuem credenciais configuradas no momento
      }
    }

    // 5. Limpeza de recursos órfãos na nuvem (IPs públicos livres / NICs ociosas) para garantir custo zero
    try {
      if (process.env.AZURE_SUBSCRIPTION_ID) {
        await cloudBurstingService.cleanupOrphanResources({ provider: 'AZURE' });
      }
    } catch (orphanResErr) {
      // Ignora caso credenciais não estejam no .env
    }
  } catch (outerErr) {
    console.warn(`[SYNC AVISO] Falha durante sincronização de órfãos:`, outerErr.message);
  } finally {
    isCleaningUpOrphans = false;
  }
}

// Reconciliação periódica em background a cada 10 minutos
setInterval(() => {
  cleanupOrphanBurstNodes().catch(() => {});
}, 10 * 60 * 1000);

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
    reclaimPendingBurst,
    schedulePendingBurstCleanup,
    cleanupPendingBurst,
    registerBurstNode,
    hasBurstNodes,
    getBurstNodes,
    getActiveSession
};