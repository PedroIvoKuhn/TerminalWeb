const k8s = require('@kubernetes/client-node');
const { k8sApi, namespace, kc } = require('../config/kubernetes');

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
        const podName = isMaster ? masterPodName : `worker-${i}-${jobId}`;
        const alias = isMaster ? 'master' : `worker-${i}`;
        const fqdn = `${podName}.${serviceName}.${namespace}.svc.cluster.local`;
        sshConfig += `Host ${alias}\n    HostName ${fqdn}\n    User mpiuser\n\n`;
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

async function createClusterResources(jobId, numMachines, mpiImage, keys) {
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
    const sshConfig = generateSshConfig(numMachines, jobId, masterPodName, secretName);
    const secretManifest = getSecretManifest(secretName, keys.privateKey, keys.publicKey, sshConfig);
    await k8sApi.createNamespacedSecret(namespace, secretManifest);

    // Cria o service
    const serviceManifest = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: serviceName },
        spec: { clusterIP: 'None', selector: { 'mpi-job-id': jobId } }
    };
    await k8sApi.createNamespacedService(namespace, serviceManifest);

    // Criar os Pods
    const podPromises = [];
    for (let i = 0; i < numMachines; i++) {
        const podName = i === 0 ? masterPodName : `worker-${i}-${jobId}`;
        const podManifest = {
            metadata: {
                name: podName,
                labels: { 'mpi-job-id': jobId, 'mpi-role': i === 0 ? 'master' : 'worker' }
            },
            spec: {
                securityContext: {
                    fsGroup: 1000
                },
                hostname: podName,
                subdomain: serviceName,
                serviceAccountName: 'terminal-backend-sa',
                containers: [{
                    name: 'mpi-container',
                    image: mpiImage,
                    imagePullPolicy: 'IfNotPresent',
                    volumeMounts: [
                        {
                            name: 'ssh-keys-volume',
                            mountPath: '/home/mpiuser/.ssh/id_rsa',
                            subPath: 'id_rsa'
                        },
                        {
                            name: 'ssh-keys-volume',
                            mountPath: '/home/mpiuser/.ssh/id_rsa.pub',
                            subPath: 'id_rsa.pub'
                        },
                        {
                            name: 'ssh-keys-volume',
                            mountPath: '/home/mpiuser/.ssh/authorized_keys',
                            subPath: 'authorized_keys'
                        },
                        {
                            name: 'ssh-keys-volume',
                            mountPath: '/home/mpiuser/.ssh/config',
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
        //console.log(`Deletando pods com label mpi-job-id=${jobId}`);
        await k8sApi.deleteCollectionNamespacedPod(
            namespace, 
            undefined,                      // pretty
            undefined,                   // _continue
            undefined,                      // dryRun
            undefined,               // fieldSelector
            undefined,          // gracePeriodSeconds
            `mpi-job-id=${jobId}`    // labelSelector
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

module.exports = { waitForPodRunning, cleanupJob, createClusterResources };