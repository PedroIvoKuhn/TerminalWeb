const { 
    EC2Client, 
    RunInstancesCommand, 
    TerminateInstancesCommand, 
    DescribeInstancesCommand, 
    DescribeImagesCommand,
    GetCallerIdentityCommand,
    DescribeSecurityGroupsCommand,
    CreateSecurityGroupCommand,
    AuthorizeSecurityGroupIngressCommand
} = require("@aws-sdk/client-ec2");
const { STSClient, GetCallerIdentityCommand: STSGetCallerIdentityCommand } = require("@aws-sdk/client-sts");

function resolveAwsCredentials(credentials = {}) {
    const creds = {};
    if (credentials.accessKeyId && String(credentials.accessKeyId).trim()) {
        creds.accessKeyId = String(credentials.accessKeyId).trim();
    }
    if (credentials.secretAccessKey && String(credentials.secretAccessKey).trim()) {
        creds.secretAccessKey = String(credentials.secretAccessKey).trim();
    }
    if (credentials.sessionToken && String(credentials.sessionToken).trim()) {
        creds.sessionToken = String(credentials.sessionToken).trim();
    }
    return creds;
}

/**
 * Cria o cliente EC2 a partir das credenciais passadas
 */
function createEc2Client(credentials = {}) {
    const region = (credentials.region && String(credentials.region).trim()) || process.env.AWS_REGION || 'sa-east-1';
    const config = { region };
    const awsCreds = resolveAwsCredentials(credentials);

    if (awsCreds.accessKeyId && awsCreds.secretAccessKey) {
        config.credentials = awsCreds;
    }

    return new EC2Client(config);
}

/**
 * Testa e valida se as credenciais da AWS são válidas
 */
async function validateCredentials(credentials = {}) {
    const region = (credentials.region && String(credentials.region).trim()) || process.env.AWS_REGION || 'sa-east-1';
    const stsConfig = { region };
    const awsCreds = resolveAwsCredentials(credentials);

    if (awsCreds.accessKeyId && awsCreds.secretAccessKey) {
        stsConfig.credentials = awsCreds;
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

async function ensureSecurityGroup(client) {
    const groupName = 'terminalweb-burst-sg';
    let groupId = null;

    try {
        const describeRes = await client.send(new DescribeSecurityGroupsCommand({
            GroupNames: [groupName]
        }));
        if (describeRes.SecurityGroups && describeRes.SecurityGroups.length > 0) {
            groupId = describeRes.SecurityGroups[0].GroupId;
        }
    } catch (err) {
        if (err.name !== 'InvalidGroup.NotFound') {
            console.warn(`[AWS SG] Aviso ao consultar Security Group '${groupName}':`, err.message);
        }
    }

    if (!groupId) {
        try {
            console.log(`-> Criando Security Group '${groupName}' na AWS...`);
            const createRes = await client.send(new CreateSecurityGroupCommand({
                GroupName: groupName,
                Description: 'Security Group for TerminalWeb Cloud Bursting nodes (UDP 41641 WireGuard and UDP 4789 Calico)'
            }));
            groupId = createRes.GroupId;
            console.log(`[SUCESSO] Security Group criado com ID: ${groupId}`);
        } catch (createErr) {
            if (createErr.name === 'InvalidGroup.Duplicate') {
                const describeRes = await client.send(new DescribeSecurityGroupsCommand({
                    GroupNames: [groupName]
                }));
                groupId = describeRes.SecurityGroups[0].GroupId;
            } else {
                console.warn(`[AWS SG] Não foi possível criar Security Group dedicado: ${createErr.message}`);
                return null;
            }
        }
    }

    // Garante as regras de Ingress para WireGuard P2P direto e Calico VXLAN
    try {
        await client.send(new AuthorizeSecurityGroupIngressCommand({
            GroupId: groupId,
            IpPermissions: [
                {
                    IpProtocol: 'udp',
                    FromPort: 41641,
                    ToPort: 41641,
                    IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Tailscale WireGuard Direct P2P' }]
                },
                {
                    IpProtocol: 'udp',
                    FromPort: 4789,
                    ToPort: 4789,
                    IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Calico VXLAN Overlay' }]
                },
                {
                    IpProtocol: 'tcp',
                    FromPort: 22,
                    ToPort: 22,
                    IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'SSH Administration' }]
                }
            ]
        }));
        console.log(`[AWS SG] Regras de Ingress (UDP 41641, UDP 4789, TCP 22) aplicadas ao grupo ${groupId}.`);
    } catch (ruleErr) {
        if (ruleErr.name !== 'InvalidPermission.Duplicate') {
            console.warn(`[AWS SG] Aviso ao autorizar portas no SG: ${ruleErr.message}`);
        }
    }

    return groupId;
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
    const ctrImage = safeImage && (safeImage.startsWith('docker.io/') || safeImage.includes('.')) 
        ? safeImage 
        : (safeImage ? `docker.io/${safeImage}` : '');

    let script = `#!/bin/bash
exec > /var/log/burst-init.log 2>&1
set -x

echo "=== INICIANDO CONFIGURACAO DO BURST NODE AWS ==="
date

# 1. Define o hostname do sistema se informado
if [ -n "${nodeName}" ]; then
    hostnamectl set-hostname "${nodeName}" || true
    echo "${nodeName}" > /etc/hostname || true
    sed -i 's/preserve_hostname: false/preserve_hostname: true/g' /etc/cloud/cloud.cfg 2>/dev/null || true
    echo "127.0.0.1 ${nodeName}" >> /etc/hosts || true
fi

# 2. Habilita IP Forwarding e Loose rp_filter no Kernel para roteamento Calico sobre VPN
echo "--- Configurando Kernel e Sysctl para Calico VXLAN sobre Tailscale ---"
sysctl -w net.ipv4.ip_forward=1 || true
sysctl -w net.ipv4.conf.all.rp_filter=2 || true
sysctl -w net.ipv4.conf.default.rp_filter=2 || true
cat << 'SYSCTL_EOF' > /etc/sysctl.d/99-hybrid-calico.conf
net.ipv4.ip_forward = 1
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
SYSCTL_EOF

# 3. Garante curl instalado rapidamente sem update desnecessário se já existir
if ! command -v curl >/dev/null 2>&1; then
    while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
        echo "Aguardando lock do apt ser liberado..."
        sleep 2
    done
    apt-get update -y && apt-get install -y curl
fi

# 4. Instalando e Configurando o Tailscale
echo "--- Instalando Tailscale ---"
curl -fsSL https://tailscale.com/install.sh | sh
`;

    if (tailscaleKey) {
        const tsHostnameFlag = nodeName ? ` --hostname=${nodeName}` : '';
        script += `
# Força porta UDP 41641 fixa no Tailscale para coincidir com o Security Group e viabilizar P2P direto
mkdir -p /etc/default
cat << 'EOF_TS' > /etc/default/tailscaled
PORT="41641"
EOF_TS
systemctl restart tailscaled || true
sleep 2

tailscale up --authkey=${tailscaleKey}${tsHostnameFlag} --accept-routes --ssh
`;
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

# Clampa MSS para evitar drops por fragmentação de pacotes grandes TCP sobre VXLAN/WireGuard
iptables-legacy -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null || true
iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null || true

if command -v ufw &>/dev/null; then
    ufw allow 41641/udp 2>/dev/null || true
    ufw allow 4789/udp 2>/dev/null || true
    ufw allow in on tailscale0 to any port 4789 proto udp 2>/dev/null || true
    ufw route allow in on tailscale0 out on cali+ 2>/dev/null || true
    ufw route allow in on cali+ out on tailscale0 2>/dev/null || true
    ufw route allow in on tailscale0 out on vxlan.calico 2>/dev/null || true
    ufw route allow in on vxlan.calico out on tailscale0 2>/dev/null || true
fi

# --- Configuração de DNAT e Watchdog ANTES do Join (${masterHost}) ---
echo "--- Configurando regras de DNAT e Watchdog antes do join ---"
cat << 'WATCHDOG_EOF' > /usr/local/bin/burst-dnat-watchdog.sh
#!/bin/bash
MASTER_HOST="${masterHost}"

apply_rules() {
    for ipt in iptables-legacy iptables; do
        # 1. Garante que a regra de DNAT para o Service ClusterIP (10.152.183.1:443) esteja sempre na posição 1
        first_out=$($ipt -t nat -S OUTPUT 2>/dev/null | sed -n '2p')
        if ! echo "$first_out" | grep -E -q "10\.152\.183\.1(/32)?[[:space:]]"; then
            $ipt -t nat -I OUTPUT 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination $MASTER_HOST:16443 2>/dev/null || true
        fi

        first_pre=$($ipt -t nat -S PREROUTING 2>/dev/null | sed -n '2p')
        if ! echo "$first_pre" | grep -E -q "10\.152\.183\.1(/32)?[[:space:]]"; then
            $ipt -t nat -I PREROUTING 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination $MASTER_HOST:16443 2>/dev/null || true
        fi

        # 2. Garante que a regra de DNAT para o CoreDNS (ClusterIP 10.152.183.10:53) aponte para o DNS forwarder do Master via Tailscale (porta 5353)
        if ! $ipt -t nat -C OUTPUT -d 10.152.183.10 -p udp --dport 53 -j DNAT --to-destination $MASTER_HOST:5353 2>/dev/null; then
            $ipt -t nat -I OUTPUT 1 -d 10.152.183.10 -p udp --dport 53 -j DNAT --to-destination $MASTER_HOST:5353 2>/dev/null || true
        fi
        if ! $ipt -t nat -C PREROUTING -d 10.152.183.10 -p udp --dport 53 -j DNAT --to-destination $MASTER_HOST:5353 2>/dev/null; then
            $ipt -t nat -I PREROUTING 1 -d 10.152.183.10 -p udp --dport 53 -j DNAT --to-destination $MASTER_HOST:5353 2>/dev/null || true
        fi
        if ! $ipt -t nat -C OUTPUT -d 10.152.183.10 -p tcp --dport 53 -j DNAT --to-destination $MASTER_HOST:5353 2>/dev/null; then
            $ipt -t nat -I OUTPUT 1 -d 10.152.183.10 -p tcp --dport 53 -j DNAT --to-destination $MASTER_HOST:5353 2>/dev/null || true
        fi
        if ! $ipt -t nat -C PREROUTING -d 10.152.183.10 -p tcp --dport 53 -j DNAT --to-destination $MASTER_HOST:5353 2>/dev/null; then
            $ipt -t nat -I PREROUTING 1 -d 10.152.183.10 -p tcp --dport 53 -j DNAT --to-destination $MASTER_HOST:5353 2>/dev/null || true
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

        # 5. Permite tráfego UDP 41641 (WireGuard) e UDP 4789 (VXLAN) para conexão direta P2P na VPC
        if ! $ipt -C INPUT -p udp --dport 41641 -j ACCEPT 2>/dev/null; then
            $ipt -I INPUT 1 -p udp --dport 41641 -j ACCEPT 2>/dev/null || true
        fi
        if ! $ipt -C INPUT -p udp --dport 4789 -j ACCEPT 2>/dev/null; then
            $ipt -I INPUT 1 -p udp --dport 4789 -j ACCEPT 2>/dev/null || true
        fi

        # 6. Permite FORWARD bidirecional entre tailscale0 e as interfaces Calico (cali+ e vxlan.calico)
        for iface in cali+ vxlan.calico; do
            if ! $ipt -C FORWARD -i tailscale0 -o "$iface" -j ACCEPT 2>/dev/null; then
                $ipt -I FORWARD 1 -i tailscale0 -o "$iface" -j ACCEPT 2>/dev/null || true
            fi
            if ! $ipt -C FORWARD -i "$iface" -o tailscale0 -j ACCEPT 2>/dev/null; then
                $ipt -I FORWARD 1 -i "$iface" -o tailscale0 -j ACCEPT 2>/dev/null || true
            fi
        done

        # 7. Previne loop de roteamento/encapsulação circular Tailscale sobre interfaces Calico
        if ! $ipt -C OUTPUT -d 10.1.0.0/16 -p udp --dport 41641 -j DROP 2>/dev/null; then
            $ipt -I OUTPUT 1 -d 10.1.0.0/16 -p udp --dport 41641 -j DROP 2>/dev/null || true
        fi
        if ! $ipt -C OUTPUT -o vxlan.calico -p udp --dport 41641 -j DROP 2>/dev/null; then
            $ipt -I OUTPUT 1 -o vxlan.calico -p udp --dport 41641 -j DROP 2>/dev/null || true
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

# Aplica imediatamente a primeira execução das regras antes do join
for ipt in iptables-legacy iptables; do
    $ipt -t nat -I OUTPUT 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination ${masterHost}:16443 2>/dev/null || true
    $ipt -t nat -I PREROUTING 1 -d 10.152.183.1 -p tcp --dport 443 -j DNAT --to-destination ${masterHost}:16443 2>/dev/null || true
    $ipt -t nat -I OUTPUT 1 -d 10.152.183.10 -p udp --dport 53 -j DNAT --to-destination ${masterHost}:5353 2>/dev/null || true
    $ipt -t nat -I PREROUTING 1 -d 10.152.183.10 -p udp --dport 53 -j DNAT --to-destination ${masterHost}:5353 2>/dev/null || true
    $ipt -t nat -I OUTPUT 1 -d 10.152.183.10 -p tcp --dport 53 -j DNAT --to-destination ${masterHost}:5353 2>/dev/null || true
    $ipt -t nat -I PREROUTING 1 -d 10.152.183.10 -p tcp --dport 53 -j DNAT --to-destination ${masterHost}:5353 2>/dev/null || true
    $ipt -t nat -A OUTPUT -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination ${masterHost}:16443 2>/dev/null || true
    $ipt -t nat -A PREROUTING -d 10.220.107.0/24 -p tcp --dport 16443 -j DNAT --to-destination ${masterHost}:16443 2>/dev/null || true
    $ipt -t nat -A POSTROUTING -o tailscale0 -j MASQUERADE 2>/dev/null || true
    $ipt -I INPUT 1 -p udp --dport 41641 -j ACCEPT 2>/dev/null || true
    $ipt -I INPUT 1 -p udp --dport 4789 -j ACCEPT 2>/dev/null || true
    $ipt -I OUTPUT 1 -d 10.1.0.0/16 -p udp --dport 41641 -j DROP 2>/dev/null || true
    $ipt -I OUTPUT 1 -o vxlan.calico -p udp --dport 41641 -j DROP 2>/dev/null || true
    for iface in cali+ vxlan.calico; do
        $ipt -I FORWARD 1 -i tailscale0 -o "$iface" -j ACCEPT 2>/dev/null || true
        $ipt -I FORWARD 1 -i "$iface" -o tailscale0 -j ACCEPT 2>/dev/null || true
    done
done
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

# Configura o kubelet para anunciar o IP do Tailscale e hostname ao cluster antes do join
if [ -n "$TS_IP" ]; then
    echo "Configurando --node-ip=$TS_IP no kubelet..."
    mkdir -p /var/snap/microk8s/current/args
    echo "--node-ip=$TS_IP" >> /var/snap/microk8s/current/args/kubelet
    ${nodeName ? `echo "--hostname-override=${nodeName}" >> /var/snap/microk8s/current/args/kubelet` : ''}
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

# --- Garante que o kubelet anuncie o IP do Tailscale pos-join ---
if [ -n "$TS_IP" ]; then
    echo "--- Configurando --node-ip=$TS_IP pos-join ---"
    sed -i '/--node-ip=/d' /var/snap/microk8s/current/args/kubelet 2>/dev/null || true
    echo "--node-ip=$TS_IP" >> /var/snap/microk8s/current/args/kubelet
    ${nodeName ? `
    sed -i '/--hostname-override=/d' /var/snap/microk8s/current/args/kubelet 2>/dev/null || true
    echo "--hostname-override=${nodeName}" >> /var/snap/microk8s/current/args/kubelet
    ` : ''}
    systemctl restart snap.microk8s.daemon-kubelite 2>/dev/null || systemctl restart snap.microk8s.daemon-kubelet 2>/dev/null || snap restart microk8s
fi

${safeImage ? `
# --- Pre-download antecipado da imagem Docker em background (após estabilização do containerd) ---
echo "--- Iniciando pre-download da imagem ${ctrImage} em background ---"
nohup microk8s ctr --namespace k8s.io images pull "${ctrImage}" > /var/log/burst-preload.log 2>&1 &
` : ''}

# --- Configuracao do Heartbeat Watchdog (${masterHost}) ---
echo "--- Configurando Heartbeat Watchdog ---"
cat << 'HEARTBEAT_EOF' > /usr/local/bin/burst-heartbeat-watchdog.sh
#!/bin/bash
MASTER_HOST="${masterHost}"
MAX_FAILURES=5
FAIL_COUNT=0

# Carencia inicial de 3 minutos para estabilizacao de rede e pods pos-join
sleep 180

echo "[HEARTBEAT] Iniciando monitoramento de conectividade com o master em $MASTER_HOST..."

while true; do
    # Testa se a API do MicroK8s no Master responde via Tailscale VPN
    # MicroK8s retorna HTTP 401 para requisições anônimas em /healthz, indicando que o master está 100% vivo e respondendo
    HTTP_CODE=\$(curl -k -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "https://\${MASTER_HOST}:16443/healthz" 2>/dev/null || echo "000")
    if [ "\$HTTP_CODE" = "200" ] || [ "\$HTTP_CODE" = "401" ] || [ "\$HTTP_CODE" = "403" ]; then
        FAIL_COUNT=0
    else
        FAIL_COUNT=\$((FAIL_COUNT + 1))
        echo "[HEARTBEAT] Falha de conexao com o backend (\$FAIL_COUNT/\$MAX_FAILURES, HTTP \$HTTP_CODE) em \$(date)"
        
        if [ "\$FAIL_COUNT" -ge "\$MAX_FAILURES" ]; then
            echo "[HEARTBEAT CRITICO] Master inacessivel por \$MAX_FAILURES minutos consecutivos. Iniciando auto-terminacao..."
            sync
            poweroff
            exit 0
        fi
    fi

    sleep 60
done
HEARTBEAT_EOF

chmod +x /usr/local/bin/burst-heartbeat-watchdog.sh
nohup /usr/local/bin/burst-heartbeat-watchdog.sh >/var/log/burst-heartbeat.log 2>&1 &

echo "=== CONFIGURACAO CONCLUIDA COM SUCESSO ==="
date
`;
    }

    return Buffer.from(script).toString('base64');
}

async function addNode(joinCommand = '', credentials = {}, options = {}) {
    const { onProgress, tags = {}, onCreated, imageToPreload } = options;
    const client = createEc2Client(credentials);
    const instanceType = credentials.instanceType || process.env.INSTANCE_TYPE || 't3.small';
    const keyPairName = credentials.keyPairName || process.env.AWS_KEY_PAIR_NAME;

    console.log("-> Buscando a AMI mais recente (Ubuntu 22.04 LTS)...");
    const amiId = await getLatestUbuntuAmi(client);
    console.log(`-> AMI encontrada: ${amiId}`);

    const nodeName = options.nodeName || options.nodeId || `burst-node-${Date.now()}`;
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
        InstanceInitiatedShutdownBehavior: 'terminate',
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
        const securityGroupId = await ensureSecurityGroup(client);
        if (securityGroupId) {
            params.SecurityGroupIds = [securityGroupId];
        }
    } catch (sgErr) {
        console.warn(`[AWS SG] Falha ao configurar Security Group dedicado: ${sgErr.message}`);
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
        if (error.name !== 'AuthFailure' && error.name !== 'CredentialsProviderError' && error.Code !== 'AuthFailure') {
            console.error("[ERRO] Falha ao listar as instâncias:", error);
        }
        throw error;
    }
}

module.exports = {
    validateCredentials,
    addNode,
    removeNode,
    listBurstNodes
};