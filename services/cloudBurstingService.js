require('dotenv').config();
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const os = require('os');

const awsBurster = require('./cloud/awsService');
const azureBurster = require('./cloud/azureService');
const cryptoService = require('./cryptoService');

const providers = {
    AWS: awsBurster,
    AZURE: azureBurster
};

/**
 * Obtém o módulo burster do provedor especificado
 */
function resolveProvider(providerName) {
    const name = (providerName || process.env.CLOUD_PROVIDER || 'AWS').toUpperCase();
    const burster = providers[name];

    if (!burster) {
        throw new Error(`Provedor de nuvem desconhecido ou não suportado: ${providerName}`);
    }

    return { name, module: burster };
}

/**
 * Carrega as credenciais padrão a partir do .env de acordo com o provedor
 * @param {string} providerName 
 */
function getEnvCredentials(providerName) {
    const name = (providerName || process.env.CLOUD_PROVIDER || 'AWS').toUpperCase();
    if (name === 'AWS') {
        return {
            region: process.env.AWS_REGION || 'sa-east-1',
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            sessionToken: process.env.AWS_SESSION_TOKEN,
            instanceType: process.env.INSTANCE_TYPE || 't2.micro',
            keyPairName: process.env.AWS_KEY_PAIR_NAME,
            tailscaleAuthKey: process.env.TAILSCALE_AUTH_KEY
        };
    } else if (name === 'AZURE') {
        return {
            tenantId: (process.env.AZURE_TENANT_ID || '').trim(),
            clientId: (process.env.AZURE_CLIENT_ID || '').trim(),
            clientSecret: (process.env.AZURE_CLIENT_SECRET || '').trim(),
            subscriptionId: (process.env.AZURE_SUBSCRIPTION_ID || '').trim(),
            resourceGroupName: (process.env.AZURE_RESOURCE_GROUP || 'CloudBurstingRG').trim(),
            location: (process.env.AZURE_LOCATION || 'eastus').trim(),
            vmSize: (process.env.AZURE_VM_SIZE || 'Standard_B2s').trim(),
            tailscaleAuthKey: process.env.TAILSCALE_AUTH_KEY
        };
    }
    return {};
}

/**
 * Valida as credenciais da nuvem antes de tentar qualquer operação
 * @param {string} provider - 'AWS' | 'AZURE'
 * @param {Object} credentials - Objeto com as credenciais
 */
async function validateCredentials(provider, credentials = {}) {
    const { name, module } = resolveProvider(provider);
    const plainCredentials = cryptoService.decryptCredentials(credentials);
    const resolvedCredentials = { ...getEnvCredentials(name), ...(plainCredentials || {}) };
    return await module.validateCredentials(resolvedCredentials);
}

/**
 * Gera o comando de join do MicroK8s substituindo pelo IP da interface Tailscale de forma assíncrona
 */
async function generateJoinCommand() {
    console.log("[BURST] Gerando token de join do MicroK8s local...");
    const { stdout, stderr } = await execAsync('microk8s add-node');
    const addNodeOutput = stdout || stderr;

    const interfaces = os.networkInterfaces();
    let tailscaleIp = null;
    if (interfaces['tailscale0']) {
        tailscaleIp = interfaces['tailscale0'].find(i => i.family === 'IPv4' || i.family === 4)?.address;
    }

    // Se o microk8s add-node já retornou uma linha explícita com o IP do Tailscale, usa ela
    if (tailscaleIp) {
        const lines = addNodeOutput.split('\n');
        const directMatch = lines.find(l => l.trim().startsWith(`microk8s join ${tailscaleIp}:`));
        if (directMatch) {
            console.log(`[BURST] Encontrado comando de join direto para Tailscale: ${directMatch.trim()}`);
            return "sudo " + directMatch.trim();
        }
    }

    const match = addNodeOutput.match(/microk8s join [^\n|\\]+/);
    if (!match) {
        throw new Error("Não foi possível gerar um comando de join válido: " + addNodeOutput);
    }

    let joinCommand = "sudo " + match[0].trim();
    if (tailscaleIp) {
        joinCommand = joinCommand.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, tailscaleIp);
    }

    return joinCommand;
}

/**
 * Aplica isolamento de tenant em um nó do Kubernetes (Label e Taint)
 */
async function applyTenantIsolation(nodeName, userId) {
    if (!userId || !nodeName) return;
    const tenantTag = `user-${String(userId).toLowerCase().replace(/[^a-z0-9-_]/g, '-').slice(0, 63)}`;
    console.log(`[BURST] Isolando nó ${nodeName} exclusivamente para ${tenantTag}...`);
    try {
        await execAsync(`microk8s kubectl label node ${nodeName} tenant=${tenantTag} --overwrite`);
        await execAsync(`microk8s kubectl taint nodes ${nodeName} tenant=${tenantTag}:NoSchedule --overwrite`);
        console.log(`[BURST] Nó ${nodeName} isolado com sucesso (Label tenant=${tenantTag} e Taint aplicados).`);
    } catch (isolateErr) {
        console.warn(`[BURST AVISO] Falha ao aplicar Label/Taint no nó ${nodeName}:`, isolateErr.message);
    }
}

/**
 * Aguarda ativamente até que múltiplos nós de burst apareçam no MicroK8s e fiquem Ready
 */
async function waitForMultipleNodesInCluster(targetsList, timeoutMs = 450000, onProgress, isCancelled) {
    const startTime = Date.now();
    const pendingTargets = [...targetsList];
    const readyNodes = [];
    const seenInTailscale = new Set();
    const calicoRestarted = new Set();
    let lastProgressNotice = Date.now();

    console.log(`[BURST] Monitorando cluster: aguardando ${targetsList.length} nó(s) [${targetsList.map(t => t.targetId).join(', ')}] (timeout: ${timeoutMs / 1000}s)...`);

    while (Date.now() - startTime < timeoutMs) {
        if (isCancelled && isCancelled()) {
            return { allJoined: false, cancelled: true };
        }

        const elapsedSec = Math.round((Date.now() - startTime) / 1000);

        // 1. Checa Tailscale
        try {
            const { stdout: tsOut } = await execAsync('tailscale status');
            const tsLower = tsOut.toLowerCase();
            for (const t of targetsList) {
                if (!seenInTailscale.has(t.targetId)) {
                    const matched = t.expectedNames.some(name => tsLower.includes(name.toLowerCase()));
                    if (matched) {
                        seenInTailscale.add(t.targetId);
                        console.log(`[BURST] Nó ${t.targetId} conectado à rede Tailscale! (${seenInTailscale.size}/${targetsList.length})`);
                        if (onProgress) {
                            onProgress(3, `${seenInTailscale.size}/${targetsList.length} nó(s) conectado(s) à VPN Tailscale! Instalando MicroK8s...`);
                        }
                    }
                }
            }
        } catch (e) {}

        // 2. Checa nós do MicroK8s
        try {
            const { stdout } = await execAsync('microk8s kubectl get nodes -o json');
            const data = JSON.parse(stdout);
            const nodes = data.items || [];

            for (let i = pendingTargets.length - 1; i >= 0; i--) {
                const target = pendingTargets[i];
                const foundNode = nodes.find(n => {
                    const name = (n.metadata?.name || '').toLowerCase();
                    return target.expectedNames.some(t => {
                        const lowT = t.toLowerCase();
                        return name.includes(lowT) || lowT.includes(name);
                    });
                });

                if (foundNode) {
                    const name = foundNode.metadata.name;
                    const readyCondition = foundNode.status?.conditions?.find(c => c.type === 'Ready');
                    const isReady = readyCondition && readyCondition.status === 'True';
                    const internalIp = foundNode.status?.addresses?.find(a => a.type === 'InternalIP')?.address;
                    const vpnIpReady = Boolean(internalIp && internalIp.startsWith('100.'));

                    if (isReady && vpnIpReady) {
                        console.log(`[BURST] Nó ${name} (${target.targetId}) pronto no cluster com IP VPN ${internalIp}!`);
                        readyNodes.push({
                            targetId: target.targetId,
                            nodeId: target.targetId,
                            nodeName: name,
                            internalIp
                        });
                        pendingTargets.splice(i, 1);
                        if (onProgress) {
                            onProgress(4, `${readyNodes.length}/${targetsList.length} nó(s) pronto(s) e integrado(s) ao cluster!`);
                        }
                    } else {
                        // Se o calico-node falhou nos primeiros segundos por causa de inicialização assíncrona,
                        // reinicia o pod calico-node deste nó para não aguardar timeout
                        if (!calicoRestarted.has(name) && elapsedSec >= 20) {
                            calicoRestarted.add(name);
                            console.log(`[BURST] Nó ${name} aguardando rede. Reiniciando pod calico-node para inicialização imediata...`);
                            execAsync(`microk8s kubectl delete pod -n kube-system -l k8s-app=calico-node --field-selector spec.nodeName=${name}`).catch(() => {});
                        }
                    }
                }
            }

            if (pendingTargets.length === 0) {
                console.log(`[BURST] Todos os ${targetsList.length} nós estão prontos e integrados ao cluster!`);
                return { allJoined: true, readyNodes };
            }
        } catch (e) {}

        // Notifica progresso periódico a cada ~25s
        if (Date.now() - lastProgressNotice > 25000 && onProgress) {
            lastProgressNotice = Date.now();
            const msg = `Aguardando nós no cluster (${readyNodes.length}/${targetsList.length} prontos, ${elapsedSec}s decorridos)...`;
            onProgress(3, msg);
        }

        await new Promise(r => setTimeout(r, 6000));
    }

    return {
        allJoined: false,
        readyNodes,
        missingTargets: pendingTargets.map(t => t.targetId)
    };
}

/**
 * Aguarda ativamente até que o nó de burst apareça no MicroK8s (wrapper)
 */
async function waitForNodeInCluster(nodePrefixOrNames, timeoutMs = 420000, onProgress, isCancelled) {
    const targets = (Array.isArray(nodePrefixOrNames) ? nodePrefixOrNames : [nodePrefixOrNames])
        .map(t => String(t).trim().toLowerCase())
        .filter(Boolean);
    const res = await waitForMultipleNodesInCluster([{ targetId: targets[0] || 'burst-node', expectedNames: targets }], timeoutMs, onProgress, isCancelled);
    if (res.cancelled) return { joined: false, ready: false, cancelled: true };
    if (!res.allJoined) return { joined: false, ready: false };
    return { joined: true, ready: true, nodeName: res.readyNodes[0]?.nodeName };
}

/**
 * Provisiona novos nós na nuvem informada (1 ou 2 máquinas) usando as credenciais passadas
 * @param {Object} options
 * @param {string} options.provider - 'AWS' | 'AZURE'
 * @param {Object} [options.credentials] - Credenciais da nuvem (se omitido, usa .env)
 * @param {number} [options.vmCount=1] - Quantidade de instâncias a provisionar (1 ou 2)
 * @param {string} [options.customJoinCommand] - Comando de join pré-gerado (opcional)
 * @param {Function} [options.onProgress] - Callback para notificar progresso (step, message)
 * @param {Function} [options.onCreated] - Callback chamado assim que cada nó é instanciado na nuvem
 * @param {Function} [options.isCancelled] - Função que verifica se a operação foi cancelada
 * @param {Object} [options.tags] - Metadados de tags (jobId, socketId, etc.)
 * @param {string} [options.imageToPreload] - Imagem Docker para pré-download na nuvem
 */
async function addNode({ provider, credentials, customJoinCommand, onProgress, onCreated, isCancelled, tags = {}, imageToPreload, vmCount = 1 } = {}) {
    const { name, module } = resolveProvider(provider);
    const plainCredentials = cryptoService.decryptCredentials(credentials);
    const resolvedCredentials = { ...getEnvCredentials(name), ...(plainCredentials || {}) };
    const targetCount = Math.min(Math.max(parseInt(vmCount, 10) || 1, 1), 2);

    if (onProgress) onProgress(1, `Validando credenciais na ${name}...`);

    // Validação prévia de credenciais
    const authCheck = await module.validateCredentials(resolvedCredentials);
    if (!authCheck.valid) {
        throw new Error(`Falha na validação das credenciais na ${name}: ${authCheck.error}`);
    }

    // Se for Azure, garante infraestrutura básica (RG, VNet, Subnet) de forma atômica antes de criar as VMs
    if (name === 'AZURE' && typeof module.ensureInfrastructure === 'function') {
        if (onProgress) onProgress(2, `Garantindo infraestrutura básica na Azure...`);
        await module.ensureInfrastructure(resolvedCredentials);
    }

    const baseTs = Date.now();

    if (targetCount === 1) {
        if (onProgress) onProgress(2, `Gerando token do MicroK8s e criando máquina virtual na ${name}...`);
        const joinCommand = customJoinCommand || await generateJoinCommand();

        console.log(`[BURST] Adicionando 1 nó na nuvem ${name}...${imageToPreload ? ` (Preload: ${imageToPreload})` : ''}`);
        const addResult = await module.addNode(joinCommand, resolvedCredentials, {
            onProgress,
            tags,
            onCreated,
            imageToPreload,
            skipEnsureInfra: name === 'AZURE'
        });
        const nodeId = typeof addResult === 'object' ? addResult.nodeId : addResult;
        const nodeName = typeof addResult === 'object' ? (addResult.nodeName || addResult.nodeId) : addResult;
        const expectedNames = typeof addResult === 'object' && Array.isArray(addResult.expectedNames)
            ? addResult.expectedNames
            : [nodeId, nodeName].filter(Boolean);

        if (isCancelled && isCancelled()) {
            throw new Error(`Operação cancelada antes do monitoramento do nó ${nodeId}.`);
        }

        if (onProgress) onProgress(3, `Instância criada! Aguardando boot e join no cluster...`);

        const clusterResult = await waitForMultipleNodesInCluster([{ targetId: nodeId, expectedNames }], 420000, onProgress, isCancelled);
        if (clusterResult.cancelled) {
            throw new Error(`Operação cancelada pelo usuário enquanto aguardava o nó ${nodeId}.`);
        }
        if (!clusterResult.allJoined) {
            throw new Error(`A máquina virtual ${nodeId} foi criada na ${name}, mas o MicroK8s não concluiu o join dentro do tempo limite. Verifique os logs em /var/log/burst-init.log na instância.`);
        }

        const effectiveNodeName = clusterResult.readyNodes[0]?.nodeName || nodeName || nodeId;
        const internalIp = clusterResult.readyNodes[0]?.internalIp;
        await applyTenantIsolation(effectiveNodeName, tags.userId);

        const singleNode = {
            nodeId,
            nodeName: effectiveNodeName,
            internalIp,
            provider: name,
            credentials: cryptoService.encryptCredentials(resolvedCredentials)
        };

        return {
            ...singleNode,
            count: 1,
            nodes: [singleNode]
        };
    } else {
        // targetCount === 2
        console.log(`[BURST] Modo 2 VMs ativado na nuvem ${name}.`);
        if (onProgress) onProgress(2, `Gerando tokens do MicroK8s e criando 2 máquinas virtuais na ${name}...`);

        const joinCommand1 = await generateJoinCommand();
        const joinCommand2 = await generateJoinCommand();

        const node1Name = `burst-node-${baseTs}-1`;
        const node2Name = `burst-node-${baseTs}-2`;

        console.log(`[BURST] Adicionando 2 nós (${node1Name}, ${node2Name}) na nuvem ${name}...${imageToPreload ? ` (Preload: ${imageToPreload})` : ''}`);

        const [addResult1, addResult2] = await Promise.all([
            module.addNode(joinCommand1, resolvedCredentials, {
                onProgress,
                tags,
                onCreated,
                imageToPreload,
                nodeName: node1Name,
                nodeId: node1Name,
                skipEnsureInfra: name === 'AZURE'
            }),
            module.addNode(joinCommand2, resolvedCredentials, {
                onProgress,
                tags,
                onCreated,
                imageToPreload,
                nodeName: node2Name,
                nodeId: node2Name,
                skipEnsureInfra: name === 'AZURE'
            })
        ]);

        if (isCancelled && isCancelled()) {
            throw new Error(`Operação cancelada antes do monitoramento das máquinas virtuais.`);
        }

        if (onProgress) onProgress(3, `2 instâncias criadas! Aguardando boot e join no cluster MicroK8s...`);

        const targetsList = [
            {
                targetId: addResult1.nodeId || node1Name,
                expectedNames: (addResult1 && Array.isArray(addResult1.expectedNames))
                    ? addResult1.expectedNames
                    : [addResult1.nodeId, addResult1.nodeName, node1Name].filter(Boolean)
            },
            {
                targetId: addResult2.nodeId || node2Name,
                expectedNames: (addResult2 && Array.isArray(addResult2.expectedNames))
                    ? addResult2.expectedNames
                    : [addResult2.nodeId, addResult2.nodeName, node2Name].filter(Boolean)
            }
        ];

        const clusterResult = await waitForMultipleNodesInCluster(targetsList, 450000, onProgress, isCancelled);
        if (clusterResult.cancelled) {
            throw new Error(`Operação cancelada pelo usuário durante o monitoramento dos nós.`);
        }
        if (!clusterResult.allJoined) {
            const missing = clusterResult.missingTargets ? clusterResult.missingTargets.join(', ') : 'nós';
            throw new Error(`As máquinas foram criadas na ${name}, mas o join não concluiu a tempo para os nós: ${missing}.`);
        }

        for (const joinedNode of clusterResult.readyNodes) {
            await applyTenantIsolation(joinedNode.nodeName, tags.userId);
        }

        const finalNodes = clusterResult.readyNodes.map(n => ({
            nodeId: n.nodeId || n.nodeName,
            nodeName: n.nodeName,
            internalIp: n.internalIp,
            provider: name,
            credentials: cryptoService.encryptCredentials(resolvedCredentials)
        }));

        return {
            count: finalNodes.length,
            nodes: finalNodes,
            nodeId: finalNodes[0].nodeId,
            nodeName: finalNodes[0].nodeName,
            provider: name,
            credentials: cryptoService.encryptCredentials(resolvedCredentials)
        };
    }
}

/**
 * Remove o nó do Kubernetes e destrói o recurso na nuvem de forma assíncrona
 */
async function removeNode({ nodeId, nodeName, provider, credentials, privateDnsOrHost } = {}) {
    const { name, module } = resolveProvider(provider);
    const plainCredentials = cryptoService.decryptCredentials(credentials);
    const resolvedCredentials = { ...getEnvCredentials(name), ...(plainCredentials || {}) };

    const hostnamesToRemove = [privateDnsOrHost, nodeName, nodeId].filter(Boolean);
    for (const host of hostnamesToRemove) {
        try {
            console.log(`[BURST] Tentando ejetar nó (${host}) do Kubernetes local...`);
            await execAsync(`microk8s kubectl delete node ${host}`);
            console.log(`[BURST] Nó ${host} excluído com sucesso do MicroK8s.`);
            break;
        } catch (e) {
            // Se o nó não existir com este nome específico, tenta o próximo candidato
        }
    }

    if (nodeId) {
        console.log(`[BURST] Destruindo instância ${nodeId} na ${name}...`);
        return await module.removeNode(nodeId, resolvedCredentials);
    }
}

/**
 * Lista todos os nós de burst ativos na nuvem informada
 */
async function listBurstNodes({ provider, credentials } = {}) {
    const { name, module } = resolveProvider(provider);
    const plainCredentials = cryptoService.decryptCredentials(credentials);
    const resolvedCredentials = { ...getEnvCredentials(name), ...(plainCredentials || {}) };
    return await module.listBurstNodes(resolvedCredentials);
}

/**
 * Limpa recursos órfãos na nuvem (como IPs públicos ou interfaces de rede ociosas)
 */
async function cleanupOrphanResources({ provider, credentials } = {}) {
    const { name, module } = resolveProvider(provider);
    if (typeof module.cleanupOrphanResources === 'function') {
        const plainCredentials = cryptoService.decryptCredentials(credentials);
        const resolvedCredentials = { ...getEnvCredentials(name), ...(plainCredentials || {}) };
        return await module.cleanupOrphanResources(resolvedCredentials);
    }
}

module.exports = {
    getEnvCredentials,
    validateCredentials,
    addNode,
    removeNode,
    listBurstNodes,
    generateJoinCommand,
    cleanupOrphanResources
};