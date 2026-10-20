const k8s = require('@kubernetes/client-node');
const os = require('os');
const { k8sApi, k8sNetworkingApi, namespace, kc, k8sExec } = require('../config/kubernetes');

// Gerenciamento de portas hostPort para comunicação segura entre nós via Tailscale
const activeHostPorts = new Map();

function allocatePorts(jobId, count) {
    const ports = [];
    let candidate = 22100;
    while (ports.length < count && candidate < 30000) {
        let inUse = false;
        for (const list of activeHostPorts.values()) {
            if (list.includes(candidate)) { inUse = true; break; }
        }
        if (!inUse) ports.push(candidate);
        candidate++;
    }
    activeHostPorts.set(jobId, ports);
    return ports;
}

function releasePorts(jobId) {
    activeHostPorts.delete(jobId);
}

function getLocalTailscaleIp() {
    const interfaces = os.networkInterfaces();
    if (interfaces['tailscale0']) {
        const ip = interfaces['tailscale0'].find(i => i.family === 'IPv4' || i.family === 4)?.address;
        if (ip) return ip;
    }
    return '100.90.80.70';
}

// --  Funções privadas

function getSecretManifest(secretName, privateKey, publicKey, sshConfig) {
    return {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: secretName },
        type: 'Opaque',
        data: {
            'id_rsa': Buffer.from(privateKey).toString('base64'),
            'id_rsa.pub': Buffer.from(publicKey).toString('base64'),
            'authorized_keys': Buffer.from(publicKey).toString('base64'),
            'config': Buffer.from(sshConfig).toString('base64')
        }
    };
}

function generateSshConfig(machineTargets) {
    let sshConfig = '';
    for (const target of machineTargets) {
        sshConfig += `Host ${target.alias} ${target.fqdn}\n    HostName ${target.host}\n`;
        if (target.port && target.port !== 22) {
            sshConfig += `    Port ${target.port}\n`;
        }
        sshConfig += `    User aluno\n\n`;
    }
    sshConfig += `Host *\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n`;
    return sshConfig;
}

// Funções exportadas

async function waitForPodRunning(name, timeoutMs = 90000) {
    // 1. Checa imediatamente se o pod já está Running
    try {
        const directCheck = await k8sApi.readNamespacedPod(name, namespace);
        if (directCheck.body && directCheck.body.status && directCheck.body.status.phase === 'Running') {
            return;
        }
    } catch (e) {
        // Se ainda não existir ou der erro temporário, segue para o watcher
    }

    const watcher = new k8s.Watch(kc);
    
    return new Promise((resolve, reject) => {
        let req;
        let timeoutId;

        const cleanup = () => {
            clearTimeout(timeoutId);
            if (req) {
                try { req.abort(); } catch (e) {}
            }
        };

        const watchCallback = (type, apiObj) => {
            if (apiObj.status && apiObj.status.phase === 'Running') {
                cleanup();
                resolve();
            }
        };

        const errorCallback = (err) => {
            if (err && (err.message === 'aborted' || err.code === 'ECONNRESET')) {
                return;
            }
            console.error('Real Watcher error:', err);
            cleanup();
            reject(err);
        };
        
        watcher.watch(
            `/api/v1/namespaces/${namespace}/pods`,
            { fieldSelector: `metadata.name=${name}` },
            watchCallback,
            errorCallback
        ).then(r => {
            req = r;
        }).catch(err => {
            cleanup();
            reject(err);
        });

        timeoutId = setTimeout(() => {
            const timeoutError = new Error(`Tempo limite excedido esperando pelo Pod ${name}`);
            console.error(timeoutError.message);
            cleanup();
            reject(timeoutError);
        }, timeoutMs);
    });
}

async function getJobPodsStatus(jobId) {
    try {
        const response = await k8sApi.listNamespacedPod(
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            `job-id=${jobId}`
        );
        const pods = response.body.items || [];
        const statusMap = {};
        for (const pod of pods) {
            const name = pod.metadata.name;
            const phase = (pod.status && pod.status.phase) || 'Pending';
            const isRunning = phase === 'Running';
            let alias = 'master';
            if (name.startsWith('worker-')) {
                const parts = name.split('-');
                alias = `${parts[0]}-${parts[1]}`;
            }
            statusMap[alias] = {
                podName: name,
                phase: phase,
                ready: isRunning
            };
        }
        return statusMap;
    } catch (err) {
        console.error(`Erro ao obter status dos pods do job ${jobId}:`, err.message);
        return {};
    }
}

async function createClusterResources(clusterInfo) {
    const { jobId, image, keys, expiresAt, numMachines, numCloud, numLocal, isHybrid, userId, activeBackupName, hasDedicatedNode, burstNodes } = clusterInfo;
    const masterPodName = `master-${jobId}`;
    const serviceName = `svc-${jobId}`;
    const secretName = `ssh-keys-${jobId}`;
    const netpolName = `netpol-${jobId}`;

    const tenantTag = userId ? `user-${String(userId).toLowerCase().replace(/[^a-z0-9-_]/g, '-').slice(0, 63)}` : null;

    // Determina o particionamento do Cluster Híbrido:
    const hybridActive = Boolean(isHybrid && hasDedicatedNode && tenantTag && typeof numLocal === 'number' && typeof numCloud === 'number');
    const localPodsCount = hybridActive ? numLocal : (hasDedicatedNode ? 0 : numMachines);

    const burstNodeList = Array.isArray(burstNodes) ? burstNodes : [];
    const localTsIp = getLocalTailscaleIp();
    const allocatedPorts = hasDedicatedNode ? allocatePorts(jobId, numMachines) : [];

    // Mapeia os endpoints (host e porta) de cada pod para garantir comunicação perfeita
    const machineTargets = [];
    for (let i = 0; i < numMachines; i++) {
        const isMaster = i === 0;
        const alias = isMaster ? 'master' : `worker-${i}`;
        const fqdn = `${alias}.${serviceName}.${namespace}.svc.cluster.local`;
        const isCloudPod = hybridActive ? (i >= localPodsCount) : (hasDedicatedNode && Boolean(tenantTag));

        let host = fqdn;
        let port = 22;

        if (hasDedicatedNode) {
            port = allocatedPorts[i] || (22100 + i);
            if (isCloudPod) {
                const cloudIdx = hybridActive ? (i - localPodsCount) : i;
                const assignedBurst = burstNodeList[cloudIdx % (burstNodeList.length || 1)];
                host = assignedBurst?.internalIp || localTsIp;
            } else {
                host = localTsIp;
            }
        }

        machineTargets.push({ alias, fqdn, host, port, isCloudPod });
    }

    try {
        // Tenta deletar os recursos se já existirem (ignora erro se não existir)
        await k8sApi.deleteNamespacedSecret(secretName, namespace);
        await k8sApi.deleteNamespacedService(serviceName, namespace);
        await k8sNetworkingApi.deleteNamespacedNetworkPolicy(netpolName, namespace);
    } catch (e) {
        // Ignora erro 404 (Not Found), qualquer outro erro mostra no log
        if (e.body && e.body.code !== 404) console.log("Aviso de limpeza prévia:", e.body ? e.body.message : e.message);
    }

    // Cria o secret com configuração SSH adaptativa (suporta local, nuvem e híbrido via Tailscale)
    const sshConfig = generateSshConfig(machineTargets);
    const secretManifest = getSecretManifest(secretName, keys.privateKey, keys.publicKey, sshConfig);
    await k8sApi.createNamespacedSecret(namespace, secretManifest);

    // Cria o service
    const serviceManifest = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: serviceName },
        spec: { clusterIP: 'None', selector: { 'job-id': jobId } }
    };
    await k8sApi.createNamespacedService(namespace, serviceManifest);

    // Cria a NetworkPolicy para isolamento de rede permitindo tráfego SSH entre pods autorizados
    const netpolManifest = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
            name: netpolName,
            labels: { 'job-id': jobId }
        },
        spec: {
            podSelector: {
                matchLabels: { 'job-id': jobId }
            },
            policyTypes: ['Ingress'],
            ingress: [
                {
                    from: [
                        {
                            podSelector: {
                                matchLabels: { 'job-id': jobId }
                            }
                        }
                    ]
                },
                {
                    ports: [
                        { protocol: 'TCP', port: 22 }
                    ]
                }
            ]
        }
    };
    try {
        await k8sNetworkingApi.createNamespacedNetworkPolicy(namespace, netpolManifest);
        console.log(`[K8S] NetworkPolicy ${netpolName} aplicada para isolar o job ${jobId}.`);
    } catch (netErr) {
        console.warn(`[K8S AVISO] Erro ao criar NetworkPolicy ${netpolName}:`, netErr.body ? netErr.body.message : netErr.message);
    }

    const podPromises = [];
    for (let i = 0; i < numMachines; i++) {
        const podK8sName = i === 0 ? masterPodName : `worker-${i}-${jobId}`;
        const networkHostname = i === 0 ? 'master' : `worker-${i}`;
        const podLabels = { 'job-id': jobId, 'role': i === 0 ? 'master' : 'worker' };
        if (tenantTag) {
            podLabels['tenant'] = tenantTag;
        }

        const podManifest = {
            metadata: {
                name: podK8sName,
                labels: podLabels,
                annotations: {
                  'terminalWeb/expiresAt': expiresAt.toString(),
                  'terminalWeb/numMachines': numMachines.toString(),
                  'terminalWeb/userId': userId.toString(),
                  'terminalWeb/activeBackupName': (activeBackupName || '').toString(),
                }
            },
            spec: {
                securityContext: {
                    fsGroup: 1000
                },
                hostname: networkHostname,
                subdomain: serviceName,
                serviceAccountName: 'terminal-backend-sa',
                containers: [{
                    name: 'container',
                    image: image,
                    imagePullPolicy: 'IfNotPresent', // Em prod tem que ser "Always", para sempre atualizar a imagem
                    ports: hasDedicatedNode ? [
                        {
                            name: 'ssh-hostport',
                            containerPort: 22,
                            hostPort: machineTargets[i].port
                        }
                    ] : [
                        {
                            name: 'ssh',
                            containerPort: 22
                        }
                    ],
                    resources: {
                        requests: {
                            cpu: '200m',
                            memory: '256Mi'
                        },
                        limits: {
                            cpu: '1000m',
                            memory: '1536Mi'
                        }
                    },
                    volumeMounts: [
                        {
                            name: 'ssh-keys-volume',
                            mountPath: '/home/aluno/.ssh/id_rsa',
                            subPath: 'id_rsa'
                        },
                        {
                            name: 'ssh-keys-volume',
                            mountPath: '/home/aluno/.ssh/id_rsa.pub',
                            subPath: 'id_rsa.pub'
                        },
                        {
                            name: 'ssh-keys-volume',
                            mountPath: '/home/aluno/.ssh/authorized_keys',
                            subPath: 'authorized_keys'
                        },
                        {
                            name: 'ssh-keys-volume',
                            mountPath: '/home/aluno/.ssh/config',
                            subPath: 'config'
                        }
                    ]
                }],
                volumes: [{
                    name: 'ssh-keys-volume',
                    secret: {
                        secretName: secretName,
                        defaultMode: 0o600,
                    }
                }],
                restartPolicy: 'Never'
            }
        };

        if (hasDedicatedNode) {
            // Agrupa hostnames por IP único para evitar avisos ou rejeição de duplicate IP no Kubernetes
            const aliasMap = new Map();
            for (const t of machineTargets) {
                if (!aliasMap.has(t.host)) {
                    aliasMap.set(t.host, new Set());
                }
                aliasMap.get(t.host).add(t.alias);
                aliasMap.get(t.host).add(t.fqdn);
            }
            podManifest.spec.hostAliases = Array.from(aliasMap.entries()).map(([ip, names]) => ({
                ip,
                hostnames: Array.from(names)
            }));
        }

        // Define se este pod específico vai para a máquina dedicada na nuvem
        const isCloudPod = hybridActive ? (i >= localPodsCount) : (hasDedicatedNode && Boolean(tenantTag));

        if (isCloudPod && tenantTag) {
            const cloudIdx = hybridActive ? (i - localPodsCount) : i;
            const assignedBurst = burstNodeList[cloudIdx % (burstNodeList.length || 1)];

            podManifest.spec.tolerations = [
                {
                    key: 'tenant',
                    operator: 'Equal',
                    value: tenantTag,
                    effect: 'NoSchedule'
                }
            ];
            podManifest.spec.affinity = {
                nodeAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: {
                        nodeSelectorTerms: [{
                            matchExpressions: [{
                                key: 'tenant',
                                operator: 'In',
                                values: [tenantTag]
                            }]
                        }]
                    }
                }
            };

            // Fixa o pod no nó remoto correspondente para casar perfeitamente com o IP mapeado no SSH
            if (assignedBurst && assignedBurst.nodeName) {
                podManifest.spec.nodeSelector = {
                    'kubernetes.io/hostname': assignedBurst.nodeName
                };
            }
        } else if (!isCloudPod && hasDedicatedNode) {
            // Em clusters híbridos, garante que o pod local rode na máquina que possui a interface Tailscale (ubuntu10)
            podManifest.spec.nodeSelector = {
                'kubernetes.io/hostname': 'ubuntu10'
            };
        }

        //console.log(`Criando Pod: ${podName}`);
        podPromises.push(k8sApi.createNamespacedPod(namespace, podManifest));
    }
    await Promise.all(podPromises);
    return { masterPodName };
}

async function cleanupJob(jobId, secretName) {
    releasePorts(jobId);
    //console.log(`Iniciando limpeza para o job: ${jobId}`);
    try {
        if (secretName) {
            //console.log(`Deletando Secret: ${secretName}`);
            await k8sApi.deleteNamespacedSecret(secretName, namespace);
        }
        //console.log(`Deletando pods com label job-id=${jobId}`);
        await k8sApi.deleteCollectionNamespacedPod(
            namespace, 
            undefined,                      // pretty
            undefined,                   // _continue
            undefined,                      // dryRun
            undefined,               // fieldSelector
            undefined,          // gracePeriodSeconds
            `job-id=${jobId}`    // labelSelector
        );
        //console.log(`Deletando service svc-${jobId}`);
        await k8sApi.deleteNamespacedService(`svc-${jobId}`, namespace);

        // Deletando NetworkPolicy netpol-${jobId}
        try {
            await k8sNetworkingApi.deleteNamespacedNetworkPolicy(`netpol-${jobId}`, namespace);
        } catch (netErr) {
            if (netErr.body && netErr.body.code !== 404) {
                console.warn(`Aviso ao deletar NetworkPolicy netpol-${jobId}:`, netErr.body ? netErr.body.message : netErr.message);
            }
        }
        //console.log(`Limpeza para ${jobId} concluída.`);
    } catch (err) {
        if (err.body && err.body.code !== 404) {
            console.error(`Erro durante a limpeza do job ${jobId}:`, err.body ? err.body.message : err);
        }
    }
}

async function getActiveJobs() {
  try {
    const response = await k8sApi.listNamespacedPod(
      namespace,
      undefined, // 2. pretty
      undefined, // 3. allowWatchBookmarks
      undefined, // 4. _continue
      undefined, // 5. fieldSelector
      `role=master` // 6. labelSelector
    );

    const pods = response.body.items;
    const activeSessionsData = [];

    for (const pod of pods) {
      const labels = pod.metadata.labels || {};
      const annotations = pod.metadata.annotations || {};

      const jobId = labels["job-id"];
      const expiresAtStr = annotations["terminalWeb/expiresAt"];
      const numMachinesStr =  annotations["terminalWeb/numMachines"];
      const userId = annotations["terminalWeb/userId"];
      const activeBackupName = annotations["terminalWeb/activeBackupName"];

      if (jobId && expiresAtStr) {
        activeSessionsData.push({
          jobId: jobId,
          expiresAt: parseInt(expiresAtStr, 10),
          numMachines: parseInt(numMachinesStr, 10) || 2,
          userId: userId,
          activeBackupName: activeBackupName,
        })
      }
    }
    
    return activeSessionsData;
  } catch (error) {
    console.error("Erro ao buscar sessões ativas no K8s:", error);
    return [];
  }
}

async function updateJobExpiration(jobId, newExpiresAt) {
    try {
        const podName = `master-${jobId}`;
        
        const patch = {
            metadata: {
                annotations: {
                    'terminalWeb/expiresAt': newExpiresAt.toString()
                }
            }
        };

        const options = { 
            headers: { 'Content-Type': 'application/strategic-merge-patch+json' } 
        };

        await k8sApi.patchNamespacedPod(
            podName, 
            namespace, 
            patch, 
            undefined, undefined, undefined, undefined, undefined, 
            options
        );
        
        console.log(`[K8s] Annotation atualizada com sucesso para o Job ${jobId}`);
    } catch (err) {
        console.error(`[ERRO K8s] Falha ao atualizar a expiração do Job ${jobId}:`, err);
    }
}

async function connectPodToTerminal(
    masterPodName, 
    command = ['/bin/bash'], 
    stdoutStream = process.stdout, 
    stderrStream = process.stderr, 
    stdinStream = process.stdin, 
    isTty = true
) {
    return await k8sExec.exec(
        namespace, 
        masterPodName, 
        'container', 
        command, 
        stdoutStream, 
        stderrStream, 
        stdinStream, 
        isTty
    );
}

module.exports = { 
    waitForPodRunning, 
    cleanupJob, 
    createClusterResources, 
    getActiveJobs, 
    updateJobExpiration,
    connectPodToTerminal,
    getJobPodsStatus,
};
