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

function buildUserDataScript(joinCommand = '', tailscaleKey = process.env.TAILSCALE_AUTH_KEY, nodeName = '', imageToPreload = null) {
    const masterHost = (joinCommand.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/) || [])[0] || '100.90.80.70';
    const safeImage = (imageToPreload || '').trim().replace(/[^a-zA-Z0-9_.:\/\-]/g, '');

    let script = `#!/bin/bash
exec > /var/log/burst-init.log 2>&1
set -x

echo "=== INICIANDO CONFIGURACAO DO BURST NODE AWS ==="
date

# Define o hostname do sistema se informado
if [ -n "${nodeName}" ]; then
    hostnamectl set-hostname "${nodeName}" || true
    echo "${nodeName}" > /etc/hostname || true
    sed -i 's/preserve_hostname: false/preserve_hostname: true/g' /etc/cloud/cloud.cfg 2>/dev/null || true
    echo "127.0.0.1 ${nodeName}" >> /etc/hosts || true
fi

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
        const tsHostnameFlag = nodeName ? ` --hostname=${nodeName}` : '';
        script += `tailscale up --authkey=${tailscaleKey}${tsHostnameFlag} --accept-routes --ssh\n`;
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

# Garante iptables-legacy ativo para compatibilidade com MicroK8s/Calico
echo "--- Configurando iptables-legacy ---"
update-alternatives --set iptables /usr/sbin/iptables-legacy || true
update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy || true
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

# Configura o kubelet para anunciar o IP do Tailscale e hostname ao cluster
if [ -n "$TS_IP" ]; then
    echo "Configurando --node-ip=$TS_IP no kubelet..."
    mkdir -p /var/snap/microk8s/current/args
    echo "--node-ip=$TS_IP" >> /var/snap/microk8s/current/args/kubelet
    ${nodeName ? `echo "--hostname-override=${nodeName}" >> /var/snap/microk8s/current/args/kubelet` : ''}
    systemctl restart snap.microk8s.daemon-kubelet 2>/dev/null || true
fi

mkdir -p /home/ubuntu/.kube
chown -f -R ubuntu:ubuntu /home/ubuntu/.kube || true

${safeImage ? `
# --- Pre-download antecipado da imagem Docker em background ---
echo "--- Iniciando pre-download da imagem ${safeImage} em background ---"
nohup microk8s crictl pull "${safeImage}" > /var/log/burst-preload.log 2>&1 &
` : ''}

# --- Executando Join com MicroK8s Master ---
echo "--- INICIANDO JOIN COM MICROK8S ---"
date
for i in {1..10}; do
    echo "Tentativa $i de join..."
    ${finalJoin} && break || sleep 5
done

echo "--- JOIN FINALIZADO ---"
date

# --- Garante que o kubelet anuncie o IP do Tailscale pos-join ---
if [ -n "$TS_IP" ]; then
    echo "--- Configurando --node-ip=$TS_IP pos-join ---"
    sed -i '/--node-ip=/d' /var/snap/microk8s/current/args/kubelet 2>/dev/null || true
    echo "--node-ip=$TS_IP" >> /var/snap/microk8s/current/args/kubelet
    ${nodeName ? `
    sed -i '/--hostname-override=/d' /var/snap/microk8s/current/args/kubelet 2>/dev/null || true
    echo "--hostname-override=${nodeName}" >> /var/snap/microk8s/current/args/kubelet
    ` : ''}
    systemctl restart snap.microk8s.daemon-kubelet 2>/dev/null || true
fi

# --- Configuracao de DNAT e Watchdog para Kubernetes Service (${masterHost}) ---
echo "--- Configurando regras de DNAT e Watchdog pos-join ---"
cat << 'WATCHDOG_EOF' > /usr/local/bin/burst-dnat-watchdog.sh
#!/bin/bash
MASTER_HOST="${masterHost}"

apply_rules() {
    for ipt in iptables-legacy iptables; do
        # 1. Garante que a regra de DNAT para o Service ClusterIP esteja sempre na posicao 1 do OUTPUT
        first_out=$($ipt -t nat -S OUTPUT 2>/dev/null | sed -n '2p')
        if ! echo "$first_out" | grep -q "10.152.183.1"; then
            $ipt -t nat -I OUTPUT 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination $MASTER_HOST:16443 2>/dev/null || true
        fi

        # 2. Garante que a regra de DNAT para o Service ClusterIP esteja sempre na posicao 1 do PREROUTING
        first_pre=$($ipt -t nat -S PREROUTING 2>/dev/null | sed -n '2p')
        if ! echo "$first_pre" | grep -q "10.152.183.1"; then
            $ipt -t nat -I PREROUTING 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination $MASTER_HOST:16443 2>/dev/null || true
        fi

        # 3. Garante DNAT da faixa privada para evitar timeout caso kube-proxy direcione para outros masters
        if ! $ipt -t nat -C OUTPUT -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination $MASTER_HOST:16443 2>/dev/null; then
            $ipt -t nat -A OUTPUT -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination $MASTER_HOST:16443 2>/dev/null || true
        fi
        if ! $ipt -t nat -C PREROUTING -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination $MASTER_HOST:16443 2>/dev/null; then
            $ipt -t nat -A PREROUTING -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination $MASTER_HOST:16443 2>/dev/null || true
        fi

        # 4. Masquerade na interface tailscale0
        if ! $ipt -t nat -C POSTROUTING -o tailscale0 -j MASQUERADE 2>/dev/null; then
            $ipt -t nat -A POSTROUTING -o tailscale0 -j MASQUERADE 2>/dev/null || true
        fi
    done
}

while true; do
    apply_rules
    sleep 3
done
WATCHDOG_EOF

chmod +x /usr/local/bin/burst-dnat-watchdog.sh
nohup /usr/local/bin/burst-dnat-watchdog.sh >/var/log/burst-watchdog.log 2>&1 &

# Executa imediatamente a primeira aplicacao das regras
for ipt in iptables-legacy iptables; do
    $ipt -t nat -I OUTPUT 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination ${masterHost}:16443 2>/dev/null || true
    $ipt -t nat -I PREROUTING 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination ${masterHost}:16443 2>/dev/null || true
    $ipt -t nat -A OUTPUT -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination ${masterHost}:16443 2>/dev/null || true
    $ipt -t nat -A PREROUTING -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination ${masterHost}:16443 2>/dev/null || true
    $ipt -t nat -A POSTROUTING -o tailscale0 -j MASQUERADE 2>/dev/null || true
done
echo "=== CONFIGURACAO CONCLUIDA COM SUCESSO ==="
date
`;
    }

    return Buffer.from(script).toString('base64');
}

async function addNode(joinCommand = '', credentials = {}, options = {}) {
    const { onProgress, tags = {}, onCreated, imageToPreload } = options;
    const client = createEc2Client(credentials);
    const instanceType = credentials.instanceType || process.env.INSTANCE_TYPE || 't2.micro';
    const keyPairName = credentials.keyPairName || process.env.AWS_KEY_PAIR_NAME;

    console.log("-> Buscando a AMI mais recente (Ubuntu 22.04 LTS)...");
    const amiId = await getLatestUbuntuAmi(client);
    console.log(`-> AMI encontrada: ${amiId}`);

    const nodeName = `burst-node-${Date.now()}`;
    const userData = buildUserDataScript(joinCommand, credentials.tailscaleAuthKey, nodeName, imageToPreload);

    const instanceTags = [
        { Key: 'Name', Value: nodeName },
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
        const instance = response.Instances[0];
        const instanceId = instance.InstanceId;
        const privateDns = (instance.PrivateDnsName || '').split('.')[0];

        console.log(`[SUCESSO] Instância criada! ID: ${instanceId} (NodeName: ${nodeName}, Hostname: ${privateDns})`);
        if (onCreated) {
            onCreated(instanceId, { nodeName, privateDns });
        }
        if (onProgress) onProgress(3, `Instância criada (${nodeName} / ${instanceId}). Conectando via Tailscale e iniciando MicroK8s...`);

        return {
            nodeId: instanceId,
            nodeName: nodeName,
            privateDns: privateDns,
            expectedNames: [nodeName, instanceId, privateDns].filter(Boolean)
        };
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
                const nameTag = (i.Tags || []).find(t => t.Key === 'Name');
                const jobIdTag = (i.Tags || []).find(t => t.Key === 'JobId');
                instances.push({
                    id: i.InstanceId,
                    name: nameTag ? nameTag.Value : i.InstanceId,
                    jobId: jobIdTag ? jobIdTag.Value : null,
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