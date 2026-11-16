#!/usr/bin/env bash
# Script Universal de Reconfiguração de Rede para Nós do Cluster (Dual-IP: DHCP UFPel + Estático Cluster)
# Mantém DHCP para Internet/UFPel e IP estático 10.220.107.X/24 para MicroK8s/dqlite.

set -euo pipefail

echo "=================================================="
echo " [$(hostname)] Reconfigurando Rede (DHCP + Cluster IP)"
echo "=================================================="

# 1. Detectar interface física
IFACE=$(ip -br link | awk '$1 !~ /^(lo|docker|tailscale|vxlan|cali)/ {print $1; exit}')
if [ -z "$IFACE" ]; then
    echo "[-] Erro: Nenhuma interface física encontrada!"
    exit 1
fi
MAC=$(cat "/sys/class/net/$IFACE/address" 2>/dev/null || ip link show "$IFACE" | awk '/ether/ {print $2}')
echo "[+] Interface física detectada: $IFACE ($MAC)"

# 2. Calcular o IP estático do cluster baseado no hostname (ex: ubuntu08 -> 10.220.107.108)
HOSTNAME_STR=$(hostname)
DIGITS=$(echo "$HOSTNAME_STR" | grep -o '[0-9]\+' | tail -n 1 || true)
if [ -n "$DIGITS" ]; then
    NUM=$((10#$DIGITS))
    CLUSTER_IP="10.220.107.$((100 + NUM))"
else
    # Fallback se não conseguir calcular pelo nome
    CLUSTER_IP=$(ip -4 -br addr show "$IFACE" 2>/dev/null | grep -o '10\.220\.107\.[0-9]\+' | head -n 1 || true)
fi

if [ -z "$CLUSTER_IP" ]; then
    echo "[-] Aviso: Não foi possível determinar o IP 10.220.107.X do cluster para este nó."
    ADDRESSES_BLOCK=""
else
    echo "[+] IP do Cluster MicroK8s (dqlite): $CLUSTER_IP/24"
    ADDRESSES_BLOCK="      addresses:
        - $CLUSTER_IP/24"
fi

# 3. Backup do Netplan
NETPLAN_FILE="/etc/netplan/50-cloud-init.yaml"
if [ -f "$NETPLAN_FILE" ]; then
    if [ ! -f "${NETPLAN_FILE}.bak" ]; then
        echo "[+] Criando backup: ${NETPLAN_FILE}.bak"
        cp -p "$NETPLAN_FILE" "${NETPLAN_FILE}.bak"
    fi
fi

# 4. Gerar nova configuração Netplan com DHCP (Internet) + IP Estático (Cluster)
echo "[+] Gravando configuração Netplan Dual-IP..."
cat << EOF > "$NETPLAN_FILE"
network:
  version: 2
  renderer: networkd
  ethernets:
    $IFACE:
      dhcp4: true
      dhcp-identifier: mac
$ADDRESSES_BLOCK
EOF
chmod 600 "$NETPLAN_FILE"

# 5. Limpar leases antigos do systemd-networkd
echo "[+] Limpando cache de leases antigos..."
rm -f /run/systemd/netif/leases/* 2>/dev/null || true

# 6. Aplicar Netplan
echo "[+] Aplicando Netplan..."
netplan apply

# 7. Aguardar e testar conectividade
echo "[+] Aguardando 10 segundos para atribuição do DHCP..."
sleep 10

SUCCESS=0
for i in {1..15}; do
    NEW_IP=$(ip -4 -br addr show "$IFACE" 2>/dev/null | grep -o '10\.15\.113\.[0-9]\+' || true)
    if [ -n "$NEW_IP" ] && ping -c 2 -W 2 8.8.8.8 >/dev/null 2>&1; then
        SUCCESS=1
        break
    fi
    echo "    Tentativa $i/15: Aguardando IP DHCP da UFPel e internet..."
    sleep 2
done

# 8. Garantir que o Kubelet do MicroK8s utilize o IP estático do cluster (10.220.107.X)
# e não o IP dinâmico DHCP da UFPel (10.15.113.X), prevenindo incompatibilidade com os certificados TLS.
if [ -n "$CLUSTER_IP" ] && [ -f /var/snap/microk8s/current/args/kubelet ]; then
    echo "[+] Configurando --node-ip=$CLUSTER_IP no MicroK8s Kubelet..."
    sed -i '/--node-ip=/d' /var/snap/microk8s/current/args/kubelet 2>/dev/null || true
    echo "--node-ip=$CLUSTER_IP" >> /var/snap/microk8s/current/args/kubelet
    systemctl restart snap.microk8s.daemon-kubelet 2>/dev/null || systemctl restart snap.microk8s.daemon-kubelite 2>/dev/null || true
    echo "[+] MicroK8s Kubelet reiniciado com --node-ip=$CLUSTER_IP."
fi

echo ""
echo "=================================================="
if [ $SUCCESS -eq 1 ]; then
    echo " SUCESSO! Nó reconfigurado com Dual-IP e Internet ativa!"
    echo " Hostname       : $(hostname)"
    echo " Interface      : $IFACE ($MAC)"
    echo " IP DHCP (UFPel): $NEW_IP"
    echo " IP Cluster k8s : ${CLUSTER_IP:-Nenhum}"
    echo " Gateway Default: $(ip route show default 2>/dev/null | awk '{print $3}')"
else
    echo " AVISO: O IP DHCP ou internet 8.8.8.8 ainda não responderam totalmente."
fi
echo "=================================================="
