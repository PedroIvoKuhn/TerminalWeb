const { ClientSecretCredential } = require("@azure/identity");
const { ComputeManagementClient } = require("@azure/arm-compute");
const { NetworkManagementClient } = require("@azure/arm-network");
const { ResourceManagementClient } = require("@azure/arm-resources");

/**
 * Cria os clientes e contexto da Azure a partir das credenciais passadas
 */
function getAzureContext(credentials = {}) {
    const tenantId = (credentials.tenantId || process.env.AZURE_TENANT_ID || '').trim();
    const clientId = (credentials.clientId || process.env.AZURE_CLIENT_ID || '').trim();
    const clientSecret = (credentials.clientSecret || process.env.AZURE_CLIENT_SECRET || '').trim();
    const subscriptionId = (credentials.subscriptionId || process.env.AZURE_SUBSCRIPTION_ID || '').trim();

    if (!tenantId || !clientId || !clientSecret || !subscriptionId) {
        throw new Error("Credenciais do Azure estão incompletas.");
    }

    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

    return {
        resourceGroupName: (credentials.resourceGroupName || process.env.AZURE_RESOURCE_GROUP || 'CloudBurstingRG').trim(),
        location: (credentials.location || process.env.AZURE_LOCATION || 'eastus').trim(),
        vmSize: (credentials.vmSize || process.env.AZURE_VM_SIZE || 'Standard_B2s').trim(),
        vnetName: 'BurstVNet',
        subnetName: 'BurstSubnet',
        subscriptionId,
        credential,
        computeClient: new ComputeManagementClient(credential, subscriptionId),
        networkClient: new NetworkManagementClient(credential, subscriptionId),
        resourceClient: new ResourceManagementClient(credential, subscriptionId)
    };
}

/**
 * Valida as credenciais da Azure tentando consultar o Resource Group
 */
async function validateCredentials(credentials = {}) {
    try {
        const ctx = getAzureContext(credentials);
        // Tenta listar ou checar a existência do Resource Group como teste de autenticação
        await ctx.resourceClient.resourceGroups.checkExistence(ctx.resourceGroupName);
        return {
            valid: true,
            subscriptionId: ctx.subscriptionId,
            resourceGroup: ctx.resourceGroupName
        };
    } catch (error) {
        return {
            valid: false,
            error: error.message
        };
    }
}

async function ensureInfrastructure(ctx) {
    console.log("-> Registrando Providers da Azure (se necessário)...");
    await ctx.resourceClient.providers.register('Microsoft.Network');
    await ctx.resourceClient.providers.register('Microsoft.Compute');

    await ctx.resourceClient.resourceGroups.createOrUpdate(ctx.resourceGroupName, {
        location: ctx.location
    });

    await ctx.networkClient.virtualNetworks.beginCreateOrUpdateAndWait(ctx.resourceGroupName, ctx.vnetName, {
        location: ctx.location,
        addressSpace: {
            addressPrefixes: ['10.0.0.0/16']
        }
    });

    await ctx.networkClient.subnets.beginCreateOrUpdateAndWait(ctx.resourceGroupName, ctx.vnetName, ctx.subnetName, {
        addressPrefix: '10.0.0.0/24'
    });
}

function buildUserDataScript(joinCommand = '', tailscaleKey = process.env.TAILSCALE_AUTH_KEY, nodeName = '', imageToPreload = null) {
    const masterHost = (joinCommand.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/) || [])[0] || '100.90.80.70';
    const safeImage = (imageToPreload || '').trim().replace(/[^a-zA-Z0-9_.:\/\-]/g, '');

    let script = `#!/bin/bash
exec > /var/log/burst-init.log 2>&1
set -x

echo "=== INICIANDO CONFIGURACAO DO BURST NODE ==="
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

# Garante iptables-legacy ativo para compatibilidade com MicroK8s/Calico
echo "--- Configurando iptables-legacy ---"
update-alternatives --set iptables /usr/sbin/iptables-legacy || true
update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy || true
`;
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
    if curl -k -f -s --connect-timeout 5 --max-time 10 "https://\${MASTER_HOST}:16443/healthz" >/dev/null 2>&1; then
        FAIL_COUNT=0
    else
        FAIL_COUNT=\$((FAIL_COUNT + 1))
        echo "[HEARTBEAT] Falha de conexao com o backend (\$FAIL_COUNT/\$MAX_FAILURES) em \$(date)"
        
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

async function getOrCreatePublicIp(ctx) {
    console.log("-> Verificando IPs Públicos existentes na Azure para reutilização...");
    const existingIps = [];
    try {
        for await (const ip of ctx.networkClient.publicIPAddresses.list(ctx.resourceGroupName)) {
            existingIps.push(ip);
        }
    } catch (err) {
        console.warn(`[BURST AVISO] Erro ao listar IPs públicos: ${err.message}`);
    }

    // 1. Procura um IP público que já esteja livre (sem interface de rede associada)
    const freeIp = existingIps.find(ip => !ip.ipConfiguration);
    if (freeIp) {
        console.log(`[BURST] Reutilizando IP Público existente livre: ${freeIp.name} (${freeIp.ipAddress || 'alocado'})`);
        return freeIp;
    }

    // 2. Se houver IPs associados a NICs órfãs (onde a VM não existe mais), limpa a NIC para liberar o IP
    for (const ip of existingIps) {
        if (ip.ipConfiguration && ip.ipConfiguration.id) {
            const match = ip.ipConfiguration.id.match(/networkInterfaces\/([^\/]+)/);
            if (match) {
                const nicName = match[1];
                try {
                    const nic = await ctx.networkClient.networkInterfaces.get(ctx.resourceGroupName, nicName);
                    if (!nic.virtualMachine) {
                        console.log(`[BURST] Encontrada NIC órfã ${nicName} segurando o IP ${ip.name}. Excluindo NIC para liberar o IP...`);
                        await ctx.networkClient.networkInterfaces.beginDeleteAndWait(ctx.resourceGroupName, nicName);
                        console.log(`[BURST] IP Público ${ip.name} liberado com sucesso para reutilização!`);
                        const updatedIp = await ctx.networkClient.publicIPAddresses.get(ctx.resourceGroupName, ip.name);
                        return updatedIp;
                    }
                } catch (e) {
                    console.warn(`[BURST AVISO] Não foi possível verificar/limpar NIC ${nicName}: ${e.message}`);
                }
            }
        }
    }

    // 3. Se não houver nenhum IP livre no RG e a cota permitir, cria um novo
    const poolIpName = `burst-pool-ip-${Date.now()}`;
    console.log(`-> Criando novo IP Público no pool: ${poolIpName}...`);
    return await ctx.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(ctx.resourceGroupName, poolIpName, {
        location: ctx.location,
        publicIPAllocationMethod: 'Static',
        sku: { name: 'Standard' }
    });
}

async function addNode(joinCommand = '', credentials = {}, options = {}) {
    const { onProgress, tags = {}, onCreated, imageToPreload } = options;
    const ctx = getAzureContext(credentials);

    console.log("-> Garantindo infraestrutura básica (RG, VNet, Subnet) na Azure...");
    if (onProgress) onProgress(2, "Garantindo infraestrutura básica (RG, VNet, Subnet) na Azure...");
    await ensureInfrastructure(ctx);

    const nodeId = `burst-node-${Date.now()}`;
    const nicName = `${nodeId}-nic`;

    // Reutiliza IP Público existente livre para não estourar a cota da região
    const publicIp = await getOrCreatePublicIp(ctx);

    console.log(`-> Criando Interface de Rede (NIC): ${nicName} com IP Público ${publicIp.name}...`);
    const subnet = await ctx.networkClient.subnets.get(ctx.resourceGroupName, ctx.vnetName, ctx.subnetName);
    
    const nic = await ctx.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(ctx.resourceGroupName, nicName, {
        location: ctx.location,
        ipConfigurations: [{
            name: 'ipconfig1',
            subnet: { id: subnet.id },
            publicIPAddress: { id: publicIp.id }
        }]
    });

    const encodedUserData = buildUserDataScript(joinCommand, credentials.tailscaleAuthKey, nodeId, imageToPreload);
    console.log(`-> Criando Máquina Virtual: ${nodeId}...`);
    if (onProgress) onProgress(2, `Criando Máquina Virtual ${nodeId} na Azure...`);
    
    const adminPassword = `Burst@${Math.random().toString(36).slice(2)}${Date.now()}!`;

    const vmTags = {
        Role: "CloudBurstingWorker",
        ManagedBy: "TerminalWeb"
    };
    if (tags.jobId) vmTags.JobId = String(tags.jobId);
    if (tags.socketId) vmTags.SocketId = String(tags.socketId);

    const vmParameters = {
        location: ctx.location,
        hardwareProfile: {
            vmSize: ctx.vmSize
        },
        osProfile: {
            computerName: nodeId,
            adminUsername: 'ubuntu',
            adminPassword: adminPassword,
            customData: encodedUserData
        },
        storageProfile: {
            imageReference: {
                publisher: 'Canonical',
                offer: '0001-com-ubuntu-server-jammy',
                sku: '22_04-lts-gen2',
                version: 'latest'
            },
            osDisk: {
                name: `${nodeId}-osdisk`,
                caching: 'ReadWrite',
                createOption: 'FromImage',
                managedDisk: {
                    storageAccountType: 'Standard_LRS'
                }
            }
        },
        networkProfile: {
            networkInterfaces: [{ id: nic.id, primary: true }]
        },
        tags: vmTags
    };

    try {
        await ctx.computeClient.virtualMachines.beginCreateOrUpdateAndWait(ctx.resourceGroupName, nodeId, vmParameters);
        console.log(`[SUCESSO] Instância Azure criada! ID/Nome: ${nodeId}`);
        if (onCreated) {
            onCreated(nodeId, { nodeName: nodeId });
        }
        if (onProgress) onProgress(3, `Instância criada (${nodeId}). Conectando via Tailscale e iniciando MicroK8s...`);
        return {
            nodeId: nodeId,
            nodeName: nodeId,
            expectedNames: [nodeId]
        };
    } catch (error) {
        console.error("[ERRO] Falha ao criar a instância no Azure:", error);
        // Em caso de falha na criação da VM, limpa a NIC criada para não deixar resíduo
        try {
            await ctx.networkClient.networkInterfaces.beginDeleteAndWait(ctx.resourceGroupName, nicName);
        } catch (_) {}
        throw error;
    }
}

async function removeNode(nodeId, credentials = {}) {
    const ctx = getAzureContext(credentials);
    console.log(`-> Solicitando encerramento da VM ${nodeId} e recursos associados no Azure...`);
    
    // 1. Exclui a VM
    try {
        await ctx.computeClient.virtualMachines.beginDeleteAndWait(ctx.resourceGroupName, nodeId);
        console.log(`[BURST] VM ${nodeId} excluída.`);
    } catch (vmErr) {
        console.warn(`[BURST AVISO] VM ${nodeId} já excluída ou inexistente: ${vmErr.message}`);
    }

    // 2. Exclui a NIC (desassocia o IP público automaticamente, deixando-o livre no pool para o próximo nó)
    try {
        await ctx.networkClient.networkInterfaces.beginDeleteAndWait(ctx.resourceGroupName, `${nodeId}-nic`);
        console.log(`[BURST] Interface de rede ${nodeId}-nic excluída (IP público liberado para reutilização).`);
    } catch (nicErr) {
        console.warn(`[BURST AVISO] NIC ${nodeId}-nic já excluída ou inexistente: ${nicErr.message}`);
    }

    // 3. Exclui o disco OS
    try {
        await ctx.computeClient.disks.beginDeleteAndWait(ctx.resourceGroupName, `${nodeId}-osdisk`);
        console.log(`[BURST] Disco ${nodeId}-osdisk excluído.`);
    } catch (diskErr) {
        console.warn(`[BURST AVISO] Disco ${nodeId}-osdisk já excluído ou inexistente: ${diskErr.message}`);
    }

    console.log(`[SUCESSO] Instância ${nodeId} e seus recursos limpos do Azure.`);
    return true;
}

async function listBurstNodes(credentials = {}) {
    const ctx = getAzureContext(credentials);
    try {
        const instances = [];
        const vms = ctx.computeClient.virtualMachines.list(ctx.resourceGroupName);
        
        for await (const vm of vms) {
            if (vm.tags && vm.tags.Role === 'CloudBurstingWorker') {
                const vmDetails = await ctx.computeClient.virtualMachines.instanceView(ctx.resourceGroupName, vm.name);
                const states = vmDetails.statuses.map(s => s.code);
                const isRunning = states.includes('PowerState/running');
                const isCreating = states.includes('ProvisioningState/creating');

                if (states.includes('ProvisioningState/deleting') || states.includes('ProvisioningState/deleted')) {
                    continue;
                }

                let currentState = 'unknown';
                if (isRunning) currentState = 'running';
                else if (isCreating) currentState = 'pending';
                else currentState = states[1] || states[0] || 'stopped';

                instances.push({
                    id: vm.name,
                    state: currentState,
                    type: vm.hardwareProfile.vmSize,
                    launchTime: 'N/A',
                    publicIp: 'N/A',
                    privateDns: vm.name
                });
            }
        }

        return instances;
    } catch (error) {
        console.error("[ERRO] Falha ao listar as instâncias no Azure:", error);
        throw error;
    }
}

module.exports = {
    validateCredentials,
    addNode,
    removeNode,
    listBurstNodes
};