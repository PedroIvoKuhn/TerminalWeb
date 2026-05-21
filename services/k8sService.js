const k8s = require('@kubernetes/client-node');
const { k8sApi, namespace, kc, k8sExec } = require('../config/kubernetes');

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

function generateSshConfig(numMachines, jobId, masterPodName, serviceName) {
    let sshConfig = '';
    for (let i = 0; i < numMachines; i++) {
        const isMaster = i === 0;
        const alias = isMaster ? 'master' : `worker-${i}`;
        const fqdn = `${alias}.${serviceName}.${namespace}.svc.cluster.local`;
        sshConfig += `Host ${alias}\n    HostName ${fqdn}\n    User aluno\n\n`;
    }
    sshConfig += `Host *\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n`;
    return sshConfig;
}

// Funções exportadas

async function waitForPodRunning(name) {
    const watcher = new k8s.Watch(kc);
    
    return new Promise((resolve, reject) => {
        let req;
        let timeoutId;

        const cleanup = () => {
            clearTimeout(timeoutId);
            if (req) {
                req.abort();
            }
        };

        const watchCallback = (type, apiObj) => {
            if (apiObj.status && apiObj.status.phase === 'Running') {
                //console.log(`Pod ${name} está 'Running'.`);
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
        });

        timeoutId = setTimeout(() => {
            const timeoutError = new Error(`Tempo limite excedido esperando pelo Pod ${name}`);
            console.error(timeoutError.message);
            cleanup();
            reject(timeoutError);
        }, 90000);
    });
}

async function createClusterResources(clusterInfo) {
    const { jobId, image, keys, expiresAt, numMachines, userId, activeBackupName } = clusterInfo;
    const masterPodName = `master-${jobId}`;
    const serviceName = `svc-${jobId}`;
    const secretName = `ssh-keys-${jobId}`;

    try {
        // Tenta deletar o secret se ele já existir (ignora erro se não existir)
        await k8sApi.deleteNamespacedSecret(secretName, namespace);
        await k8sApi.deleteNamespacedService(serviceName, namespace);
    } catch (e) {
        // Ignora erro 404 (Not Found), qualquer outro erro mostra no log
        if (e.body && e.body.code !== 404) console.log("Aviso de limpeza:", e.body.message);
    }

    // Cria o secret
    const sshConfig = generateSshConfig(numMachines, jobId, masterPodName, serviceName);
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

    // Criar os Pods
    const podPromises = [];
    for (let i = 0; i < numMachines; i++) {
        const podK8sName = i === 0 ? masterPodName : `worker-${i}-${jobId}`;
        const networkHostname = i === 0 ? 'master' : `worker-${i}`;
        const podManifest = {
            metadata: {
                name: podK8sName,
                labels: { 'job-id': jobId, 'role': i === 0 ? 'master' : 'worker' },
                annotations: {
                  'terminalWeb/expiresAt': expiresAt.toString(),
                  'terminalWeb/numMachines': numMachines.toString(),
                  'terminalWeb/userId': userId.toString(),
                  'terminalWeb/activeBackupName': activeBackupName.toString(),
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
                    imagePullPolicy: 'Always',
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
        //console.log(`Criando Pod: ${podName}`);
        podPromises.push(k8sApi.createNamespacedPod(namespace, podManifest));
    }
    await Promise.all(podPromises);
    return { masterPodName };
}

async function cleanupJob(jobId, secretName) {
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
};
