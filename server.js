require("dotenv").config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const k8s = require('@kubernetes/client-node');
const forge = require('node-forge');
const fs = require('fs');
const lti = require('ltijs').Provider;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const kc = new k8s.KubeConfig();

process.env.KUBERNETES_SERVICE_HOST ? kc.loadFromCluster() : kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sExec = new k8s.Exec(kc);
const namespace = process.env.K8S_NAMESPACE || 'default';
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/xterm-addon-fit')));

async function startServer() {
    if (process.env.NODE_ENV === "development"){
        app.get('/', (req, res) => {
            const userName = "userDev";
            const mpiImage = process.env.DEFAULT_MPI_IMAGE;
            const templatePath = path.join(__dirname, 'views', 'index.html');
            
            fs.readFile(templatePath, 'utf8', (err, html) => {
                if (err) return res.status(500).send("Erro ao carregar index.html.");

                let finalHtml = html.replace('{{NOME_USUARIO}}', userName);
                finalHtml = finalHtml.replaceAll('{{MPI_IMAGE}}', mpiImage);
                res.send(finalHtml);
            })
        });
    } else {
        await lti.setup(process.env.LTI_ENCRYPTION_KEY,
            {
                url: process.env.MONGO_DB_URI,
                connection: {
                    useNewUrlParser: true,
                    useUnifiedTopology: true
                }
            },
            {
                cookies: {
                    secure: process.env.NODE_ENV === 'production',
                    sameSite: 'None'
                },
                devMode: process.env.NODE_ENV !== 'production'
            }
        );

        await lti.deploy({ port: PORT + 1});
        app.use(lti.app);

        await lti.registerPlatform({
            url: process.env.LTI_PLATFORM_URL,
            name: process.env.LTI_PLATFORM_NAME,
            clientId: process.env.LTI_CLIENT_ID,
            authenticationEndpoint: process.env.LTI_AUTH_ENDPOINT,
            accesstokenEndpoint: process.env.LTI_TOKEN_ENDPOINT,
            authConfig: {
                method: 'JWK_SET',
                key: process.env.LTI_KEYSET_ENDPOINT
            }
        });

        lti.onConnect(async (token, req, res) => {
            console.log('Usuário conectado:', token.user);
            const userName = token.user.name || 'Usuário Desconhecido';
            let mpiImage = process.env.DEFAULT_MPI_IMAGE;
            
            //Captura o nome da imagem
            const custImagem = token.platformContext.custom ? token.platformContext.custom.imagem : undefined;
            if (custImagem && custImagem.toLowerCase() !== 'default') {              
                mpiImage = custImagem;
            }

            const templatePath = path.join(__dirname, 'views', 'index.html');
            fs.readFile(templatePath, 'utf8', (err, html) => {
                if (err) return res.status(500).send("Erro ao carregar index.html.");
                let finalHtml = html.replace('{{NOME_USUARIO}}', userName);
                finalHtml = finalHtml.replaceAll('{{MPI_IMAGE}}', mpiImage);
                res.send(finalHtml);
            });
        });
    }

    server.listen(PORT, () => {
        console.log(`Servidor rodando em http://localhost:${PORT}`);
    });
}

function generateSSHKeys() {
    return new Promise((resolve, reject) => {
        forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, keypair) => {
            if (err) {
                return reject(err);
            }
            const privateKeyPem = forge.pki.privateKeyToPem(keypair.privateKey);
            const publicKeySsh = forge.ssh.publicKeyToOpenSSH(keypair.publicKey, 'mpiuser@host');
            resolve({ privateKey: privateKeyPem, publicKey: publicKeySsh });
        });
    });
}

async function waitForPodRunning(api, name, namespace) {
    //console.log(`Aguardando Pod ${name} ficar 'Running'...`);
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

io.on('connection', (socket) => {
    //console.log(`Frontend conectado: ${socket.id}`);

    socket.on('start-session', async ({numMachines, mpiImage}) => {
        const jobId = `mpi-job-${socket.id.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const masterPodName = `master-${jobId}`;
        const serviceName = `svc-${jobId}`;
        const secretName = `ssh-keys-${jobId}`;
        socket.data.jobId = jobId;

        socket.emit('output', `\r\nIniciando ${numMachines} nós para o job ${jobId} usando a imagem ${mpiImage}...\r\n`);
        
        try {
            socket.emit('output', 'Gerando chaves e configuração SSH...\r\n');
            const { privateKey, publicKey } = await generateSSHKeys();
            
            let sshConfig = '';
            for (let i = 0; i < numMachines; i++) {
                const isMaster = i === 0;
                const podName = isMaster ? masterPodName : `worker-${i}-${jobId}`;
                const alias = isMaster ? 'master' : `worker-${i}`;
                const fqdn = `${podName}.${serviceName}.${namespace}.svc.cluster.local`;
                sshConfig += `Host ${alias}\n    HostName ${fqdn}\n    User mpiuser\n\n`;
            }
            sshConfig += `Host *\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n`;

            const secretManifest = {
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
            //console.log(`Criando Secret: ${secretName}`);
            await k8sApi.createNamespacedSecret(namespace, secretManifest);

            const serviceManifest = {
                 apiVersion: 'v1',
                 kind: 'Service',
                 metadata: { name: serviceName },
                 spec: { clusterIP: 'None', selector: { 'mpi-job-id': jobId } }
            };
            //console.log(`Criando Headless Service: ${serviceName}`);
            await k8sApi.createNamespacedService(namespace, serviceManifest);

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
                            resources: {
                                requests: {
                                    cpu: "100m",
                                    memory: "128Mi"
                                },
                                limits: {
                                    cpu: "1",
                                    memory: "2048Mi"
                                }
                            },
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
            socket.emit('output', `Pods criados. Aguardando o nó mestre (${masterPodName}) ficar pronto...\r\n`);

            await waitForPodRunning(k8sApi, masterPodName, namespace);
            const machineAliases = ['master'];
            for (let i = 1; i < numMachines; i++) {
                machineAliases.push(`worker-${i}`);
            }
            
            socket.emit('session-ready', { aliases: machineAliases });

            socket.emit('output', `\r\n✅ Conectado! Apelidos SSH configurados.\r\n`);
            socket.emit('output', `Tente: ssh worker-1\r\n\r\n`);
            
            const command = ['/bin/bash'];
            const execWs = await k8sExec.exec(namespace, masterPodName, 'mpi-container', command, process.stdout, process.stderr, process.stdin, true);
            
            socket.on('input', (data) => { if (execWs && execWs.readyState === 1) { execWs.send(Buffer.from('\x00' + data)); } });
            execWs.onmessage = (event) => { socket.emit('output', event.data.toString().substring(1)); };
            execWs.onclose = () => { socket.emit('output', '\r\n[Sessão no Pod encerrada]'); cleanupJob(jobId, secretName); };

        } catch (err) {
            console.error('Erro no ciclo de vida do Pod:', err);
            socket.emit('output', `\r\n[ERRO DO BACKEND]: ${err.message}\r\nIniciando limpeza...`);
            await cleanupJob(jobId, secretName);
        }
    });

    socket.on('disconnect', async () => {
        //console.log(`Frontend ${socket.id} desconectado.`);
        if (socket.data.jobId) {
            const secretName = `ssh-keys-${socket.data.jobId}`;
            await cleanupJob(socket.data.jobId, secretName);
        }
    });
});

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

startServer().catch(err => console.error("Falha ao iniciar o servidor:", err));