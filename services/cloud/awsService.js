const { 
    EC2Client, 
    RunInstancesCommand, 
    TerminateInstancesCommand, 
    DescribeInstancesCommand, 
    DescribeImagesCommand,
    GetCallerIdentityCommand 
} = require("@aws-sdk/client-ec2");
const { STSClient, GetCallerIdentityCommand: STSGetCallerIdentityCommand } = require("@aws-sdk/client-sts");

/**
 * Cria o cliente EC2 a partir das credenciais passadas
 */
function createEc2Client(credentials = {}) {
    const region = credentials.region || process.env.AWS_REGION || 'sa-east-1';
    const config = { region };

    if (credentials.accessKeyId && credentials.secretAccessKey) {
        config.credentials = {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken
        };
    }

    return new EC2Client(config);
}

/**
 * Testa e valida se as credenciais da AWS são válidas
 */
async function validateCredentials(credentials = {}) {
    const region = credentials.region || process.env.AWS_REGION || 'sa-east-1';
    const stsConfig = { region };

    if (credentials.accessKeyId && credentials.secretAccessKey) {
        stsConfig.credentials = {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken
        };
    }

    try {
        const sts = new STSClient(stsConfig);
        const identity = await sts.send(new STSGetCallerIdentityCommand({}));
        return {
            valid: true,
            account: identity.Account,
            arn: identity.Arn
        };
    } catch (error) {
        return {
            valid: false,
            error: error.message
        };
    }
}

async function getLatestUbuntuAmi(client) {
    try {
        const command = new DescribeImagesCommand({
            Owners: ['099720109477'],
            Filters: [
                { Name: 'name', Values: ['ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*'] },
                { Name: 'state', Values: ['available'] },
                { Name: 'architecture', Values: ['x86_64'] }
            ]
        });

        const response = await client.send(command);
        const sortedImages = response.Images.sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate));
        return sortedImages[0].ImageId;
    } catch (error) {
        console.error("Erro ao buscar a AMI do Ubuntu:", error);
        throw error;
    }
}

function buildUserDataScript(joinCommand = '', tailscaleKey = process.env.TAILSCALE_AUTH_KEY) {
    const masterHost = (joinCommand.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/) || [])[0] || '100.90.80.70';

    let script = `#!/bin/bash
exec > /var/log/burst-init.log 2>&1
set -x

echo "=== INICIANDO CONFIGURACAO DO BURST NODE AWS ==="
date

# Garante curl instalado rapidamente sem update desnecessário se já existir
if ! command -v curl >/dev/null 2>&1; then
    while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
        echo "Aguardando lock do apt ser liberado..."
        sleep 2
    done
    apt-get update -y && apt-get install -y curl
fi

# --- Instalando e Configurando o Tailscale ---
echo "--- Instalando Tailscale ---"
curl -fsSL https://tailscale.com/install.sh | sh
`;

    if (tailscaleKey) {
        script += `tailscale up --authkey=${tailscaleKey} --accept-routes --ssh\n`;
        script += `
# Aguarda IP do Tailscale ser configurado na interface
TS_IP=""
for i in {1..30}; do
    TS_IP=$(tailscale ip -4 || true)
    if [ -n "$TS_IP" ]; then
        echo "Tailscale conectado com IP: $TS_IP"
        break
    fi
    sleep 2
done

# Redireciona chamadas ao Kubernetes ClusterIP e LAN privada para o IP do Master via Tailscale
echo "--- Configurando iptables DNAT para Kubernetes Service ---"
iptables -t nat -I OUTPUT 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination ${masterHost}:16443
iptables -t nat -I PREROUTING 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination ${masterHost}:16443
iptables -t nat -I OUTPUT 1 -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination ${masterHost}:16443
iptables -t nat -I PREROUTING 1 -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination ${masterHost}:16443
iptables -t nat -A POSTROUTING -o tailscale0 -j MASQUERADE
`;
    } else {
        console.warn("AVISO: TAILSCALE_AUTH_KEY não definido. Instância subirá sem VPN.");
    }

    if (joinCommand) {
        let finalJoin = joinCommand.includes('--worker') ? joinCommand : `${joinCommand} --worker`;
        script += `
# --- Instalando o MicroK8s ---
echo "--- Instalando MicroK8s snap ---"
for i in {1..5}; do
    snap install microk8s --classic --channel=1.32/stable && break || sleep 5
done

usermod -aG microk8s ubuntu

# Configura o kubelet para anunciar o IP do Tailscale ao cluster
if [ -n "$TS_IP" ]; then
    echo "Configurando --node-ip=$TS_IP no kubelet..."
    mkdir -p /var/snap/microk8s/current/args
    echo "--node-ip=$TS_IP" >> /var/snap/microk8s/current/args/kubelet
fi

mkdir -p /home/ubuntu/.kube
chown -f -R ubuntu:ubuntu /home/ubuntu/.kube || true

# --- Executando Join com MicroK8s Master ---
echo "--- INICIANDO JOIN COM MICROK8S ---"
date
for i in {1..10}; do
    echo "Tentativa $i de join..."
    ${finalJoin} && break || sleep 5
done

echo "--- JOIN FINALIZADO ---"
date
`;
    }

    return Buffer.from(script).toString('base64');
}

async function addNode(joinCommand = '', credentials = {}, options = {}) {
    const { onProgress, tags = {}, onCreated } = options;
    const client = createEc2Client(credentials);
    const instanceType = credentials.instanceType || process.env.INSTANCE_TYPE || 't2.micro';
    const keyPairName = credentials.keyPairName || process.env.AWS_KEY_PAIR_NAME;

    console.log("-> Buscando a AMI mais recente (Ubuntu 22.04 LTS)...");
    const amiId = await getLatestUbuntuAmi(client);
    console.log(`-> AMI encontrada: ${amiId}`);

    const userData = buildUserDataScript(joinCommand, credentials.tailscaleAuthKey);

    const instanceTags = [
        { Key: 'Name', Value: `burst-node-${Date.now()}` },
        { Key: 'Role', Value: 'CloudBurstingWorker' },
        { Key: 'ManagedBy', Value: 'TerminalWeb' }
    ];

    if (tags.jobId) instanceTags.push({ Key: 'JobId', Value: String(tags.jobId) });
    if (tags.socketId) instanceTags.push({ Key: 'SocketId', Value: String(tags.socketId) });

    const params = {
        ImageId: amiId,
        InstanceType: instanceType,
        MinCount: 1,
        MaxCount: 1,
        UserData: userData,
        TagSpecifications: [
            {
                ResourceType: 'instance',
                Tags: instanceTags
            }
        ]
    };

    if (keyPairName) {
        params.KeyName = keyPairName;
    }

    try {
        const command = new RunInstancesCommand(params);
        const response = await client.send(command);
        const instanceId = response.Instances[0].InstanceId;
        console.log(`[SUCESSO] Instância criada! ID: ${instanceId}`);
        if (onCreated) {
            onCreated(instanceId);
        }
        if (onProgress) onProgress(3, `Instância criada (${instanceId}). Conectando via Tailscale e iniciando MicroK8s...`);
        return instanceId;
    } catch (error) {
        console.error("[ERRO] Falha ao criar a instância:", error);
        throw error;
    }
}

async function removeNode(instanceId, credentials = {}) {
    const client = createEc2Client(credentials);
    try {
        console.log(`-> Solicitando encerramento da instância ${instanceId}...`);
        const command = new TerminateInstancesCommand({ InstanceIds: [instanceId] });
        const response = await client.send(command);

        const state = response.TerminatingInstances[0].CurrentState.Name;
        console.log(`[SUCESSO] Instância ${instanceId} agora está em estado: ${state}`);
        return true;
    } catch (error) {
        console.error(`[ERRO] Falha ao remover a instância ${instanceId}:`, error);
        throw error;
    }
}

async function listBurstNodes(credentials = {}) {
    const client = createEc2Client(credentials);
    try {
        const command = new DescribeInstancesCommand({
            Filters: [
                { Name: 'tag:Role', Values: ['CloudBurstingWorker'] },
                { Name: 'instance-state-name', Values: ['running', 'pending'] }
            ]
        });
        const response = await client.send(command);

        const instances = [];
        response.Reservations.forEach(r => {
            r.Instances.forEach(i => {
                instances.push({
                    id: i.InstanceId,
                    state: i.State.Name,
                    type: i.InstanceType,
                    launchTime: i.LaunchTime,
                    publicIp: i.PublicIpAddress || 'N/A',
                    privateDns: (i.PrivateDnsName || '').split('.')[0]
                });
            });
        });

        return instances;
    } catch (error) {
        console.error("[ERRO] Falha ao listar as instâncias:", error);
        throw error;
    }
}

module.exports = {
    validateCredentials,
    addNode,
    removeNode,
    listBurstNodes
};