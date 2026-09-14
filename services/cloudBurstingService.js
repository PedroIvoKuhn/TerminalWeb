require('dotenv').config();
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const os = require('os');

const awsBurster = require('./cloud/awsService');
const azureBurster = require('./cloud/azureService');

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
    const resolvedCredentials = { ...getEnvCredentials(name), ...credentials };
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
 * Aguarda ativamente até que o nó de burst apareça no MicroK8s
 */
async function waitForNodeInCluster(nodePrefixOrName, timeoutMs = 420000, onProgress, isCancelled) {
    const startTime = Date.now();
    console.log(`[BURST] Monitorando cluster: aguardando nó '${nodePrefixOrName}' aparecer no MicroK8s (timeout: ${timeoutMs / 1000}s)...`);

    let sawInTailscale = false;
    let lastProgressNotice = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        if (isCancelled && isCancelled()) {
            console.log(`[BURST] Operação cancelada / socket fechado para o nó ${nodePrefixOrName}.`);
            return { joined: false, ready: false, cancelled: true };
        }

        const elapsedSec = Math.round((Date.now() - startTime) / 1000);

        // 1. Verifica se o nó já apareceu no Tailscale para dar feedback ao usuário
        if (!sawInTailscale) {
            try {
                const { stdout: tsOut } = await execAsync('tailscale status');
                if (tsOut.includes(nodePrefixOrName)) {
                    sawInTailscale = true;
                    console.log(`[BURST] Nó ${nodePrefixOrName} conectado com sucesso à rede Tailscale!`);
                    if (onProgress) onProgress(3, `Nó conectado à VPN Tailscale! Instalando MicroK8s na nuvem e executando join...`);
                }
            } catch (e) {}
        }

        // 2. Consulta os nós do MicroK8s
        try {
            const { stdout } = await execAsync('microk8s kubectl get nodes -o json');
            const data = JSON.parse(stdout);
            const nodes = data.items || [];

            const foundNode = nodes.find(n => {
                const name = n.metadata?.name || '';
                return name.toLowerCase().includes(nodePrefixOrName.toLowerCase());
            });

            if (foundNode) {
                const name = foundNode.metadata.name;
                const readyCondition = foundNode.status?.conditions?.find(c => c.type === 'Ready');
                const isReady = readyCondition && readyCondition.status === 'True';

                if (isReady) {
                    console.log(`[BURST] Nó ${name} está no cluster e em estado Ready!`);
                    if (onProgress) onProgress(4, `Nó ${name} pronto e integrado ao cluster MicroK8s!`);
                    return { joined: true, ready: true, nodeName: name };
                } else {
                    console.log(`[BURST] Nó ${name} detectado no cluster! Aguardando kubelet ficar Ready...`);
                    if (onProgress) onProgress(4, `Nó ${name} detectado no cluster! Aguardando inicialização completa...`);
                    return { joined: true, ready: false, nodeName: name };
                }
            }
        } catch (e) {}

        // Notifica progresso periódico a cada ~25 segundos
        if (Date.now() - lastProgressNotice > 25000 && onProgress) {
            lastProgressNotice = Date.now();
            const msg = sawInTailscale
                ? `Nó conectado na VPN. Instalando pacotes e realizando join (${elapsedSec}s decorridos)...`
                : `Aguardando boot da máquina e conexão à VPN (${elapsedSec}s decorridos)...`;
            onProgress(3, msg);
        }

        await new Promise(r => setTimeout(r, 6000));
    }

    console.warn(`[BURST AVISO] Timeout (${timeoutMs / 1000}s) aguardando nó ${nodePrefixOrName} no cluster.`);
    return { joined: false, ready: false };
}

/**
 * Provisiona um novo nó na nuvem informada usando as credenciais passadas
 * @param {Object} options
 * @param {string} options.provider - 'AWS' | 'AZURE'
 * @param {Object} [options.credentials] - Credenciais da nuvem (se omitido, usa .env)
 * @param {string} [options.customJoinCommand] - Comando de join pré-gerado (opcional)
 * @param {Function} [options.onProgress] - Callback para notificar progresso (step, message)
 * @param {Function} [options.onCreated] - Callback chamado assim que o nó é instanciado na nuvem
 * @param {Function} [options.isCancelled] - Função que verifica se a operação foi cancelada
 * @param {Object} [options.tags] - Metadados de tags (jobId, socketId, etc.)
 */
async function addNode({ provider, credentials, customJoinCommand, onProgress, onCreated, isCancelled, tags = {} } = {}) {
    const { name, module } = resolveProvider(provider);
    const resolvedCredentials = { ...getEnvCredentials(name), ...(credentials || {}) };

    if (onProgress) onProgress(1, `Validando credenciais na ${name}...`);

    // Validação prévia de credenciais
    const authCheck = await module.validateCredentials(resolvedCredentials);
    if (!authCheck.valid) {
        throw new Error(`Falha na validação das credenciais na ${name}: ${authCheck.error}`);
    }

    if (onProgress) onProgress(2, `Gerando token do MicroK8s e criando máquina virtual na ${name}...`);
    const joinCommand = customJoinCommand || await generateJoinCommand();

    console.log(`[BURST] Adicionando nó na nuvem ${name}...`);
    const nodeId = await module.addNode(joinCommand, resolvedCredentials, { onProgress, tags, onCreated });

    if (isCancelled && isCancelled()) {
        throw new Error(`Operação cancelada antes do monitoramento do nó ${nodeId}.`);
    }

    if (onProgress) onProgress(3, `Instância ${nodeId} criada! Aguardando boot e join no cluster...`);

    // Aguarda ativamente até que o nó apareça no cluster (timeout de 7 minutos)
    const clusterResult = await waitForNodeInCluster(nodeId, 420000, onProgress, isCancelled);
    if (clusterResult.cancelled) {
        throw new Error(`Operação cancelada pelo usuário enquanto aguardava o nó ${nodeId}.`);
    }
    if (!clusterResult.joined) {
        throw new Error(`A máquina virtual ${nodeId} foi criada na ${name}, mas o MicroK8s não concluiu o join dentro do tempo limite. Verifique os logs em /var/log/burst-init.log na instância.`);
    }

    return {
        nodeId,
        nodeName: clusterResult.nodeName || nodeId,
        provider: name,
        credentials: resolvedCredentials
    };
}

/**
 * Remove o nó do Kubernetes e destrói o recurso na nuvem de forma assíncrona
 */
async function removeNode({ nodeId, nodeName, provider, credentials, privateDnsOrHost } = {}) {
    const { name, module } = resolveProvider(provider);
    const resolvedCredentials = { ...getEnvCredentials(name), ...(credentials || {}) };

    const hostToRemove = privateDnsOrHost || nodeName || nodeId;
    if (hostToRemove) {
        console.log(`[BURST] Ejetando nó (${hostToRemove}) do Kubernetes local...`);
        try {
            await execAsync(`microk8s kubectl delete node ${hostToRemove}`);
            console.log(`[BURST] Nó ${hostToRemove} excluído com sucesso do MicroK8s.`);
        } catch (e) {
            console.warn(`[BURST AVISO] Não foi possível remover nó do Kubernetes: ${e.message}`);
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
    const resolvedCredentials = { ...getEnvCredentials(name), ...(credentials || {}) };
    return await module.listBurstNodes(resolvedCredentials);
}

module.exports = {
    getEnvCredentials,
    validateCredentials,
    addNode,
    removeNode,
    listBurstNodes,
    generateJoinCommand
};