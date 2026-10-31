#!/usr/bin/env bash
# ==============================================================================
# Script de Configuração de Nó Físico Local para Rede Híbrida (Calico + Tailscale)
# Execute este script diretamente no nó físico desejado (ex: ubuntu11) com sudo.
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[ERRO] Este script deve ser executado como root ou com sudo!${NC}"
    exit 1
fi

echo -e "${BOLD}${BLUE}=== Configurando Nó Físico para Rede Híbrida (Calico VXLAN + Tailscale) ===${NC}"

# 1. Verifica Tailscale
if ! command -v tailscale &>/dev/null; then
    echo -e "${YELLOW}[1/4] Instalando Tailscale...${NC}"
    curl -fsSL https://tailscale.com/install.sh | sh
fi

if ! ip link show dev tailscale0 &>/dev/null; then
    echo -e "${YELLOW}[!] A interface tailscale0 não foi encontrada.${NC}"
    echo -e "Conectando ao Tailscale (autentique se necessário)..."
    tailscale up --accept-routes --ssh || true
fi

TS_IP=$(tailscale ip -4 2>/dev/null || ip -4 addr show dev tailscale0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}' || echo "")
if [ -n "$TS_IP" ]; then
    echo -e "${GREEN}[OK] Tailscale ativo com IP: ${TS_IP}${NC}"
else
    echo -e "${RED}[ERRO] Não foi possível obter o IP do Tailscale.${NC}"
    exit 1
fi

# 2. Configurações de Kernel (Sysctl)
echo -e "${BLUE}[2/4] Aplicando parâmetros de kernel (ip_forward=1 e rp_filter=2)...${NC}"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
sysctl -w net.ipv4.conf.all.rp_filter=2 >/dev/null
sysctl -w net.ipv4.conf.default.rp_filter=2 >/dev/null
sysctl -w net.ipv4.conf.tailscale0.rp_filter=2 2>/dev/null || true

cat << 'EOF' > /etc/sysctl.d/99-hybrid-calico.conf
net.ipv4.ip_forward = 1
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
EOF
echo -e "${GREEN}[OK] Parâmetros de kernel aplicados e persistidos em /etc/sysctl.d/99-hybrid-calico.conf.${NC}"

# 3. Regras de Firewall (iptables e iptables-legacy)
echo -e "${BLUE}[3/4] Aplicando regras de firewall iptables...${NC}"
APPLY_IPTABLES() {
    local ipt="$1"
    if command -v "$ipt" &>/dev/null; then
        # Anti-loop crítico: bloqueia discovery do Tailscale WireGuard via interfaces de pods/vxlan
        if ! $ipt -C OUTPUT -d 10.1.0.0/16 -p udp --dport 41641 -j DROP 2>/dev/null; then
            $ipt -I OUTPUT 1 -d 10.1.0.0/16 -p udp --dport 41641 -j DROP 2>/dev/null || true
        fi
        if ! $ipt -C OUTPUT -o vxlan.calico -p udp --dport 41641 -j DROP 2>/dev/null; then
            $ipt -I OUTPUT 1 -o vxlan.calico -p udp --dport 41641 -j DROP 2>/dev/null || true
        fi

        # Permite VXLAN (UDP 4789)
        if ! $ipt -C INPUT -i tailscale0 -p udp --dport 4789 -j ACCEPT 2>/dev/null; then
            $ipt -I INPUT 1 -i tailscale0 -p udp --dport 4789 -j ACCEPT 2>/dev/null || true
        fi

        # Encaminhamento entre Tailscale e interfaces Calico
        for iface in "cali+" "vxlan.calico"; do
            if ! $ipt -C FORWARD -i tailscale0 -o "$iface" -j ACCEPT 2>/dev/null; then
                $ipt -I FORWARD 1 -i tailscale0 -o "$iface" -j ACCEPT 2>/dev/null || true
            fi
            if ! $ipt -C FORWARD -i "$iface" -o tailscale0 -j ACCEPT 2>/dev/null; then
                $ipt -I FORWARD 1 -i "$iface" -o tailscale0 -j ACCEPT 2>/dev/null || true
            fi
        done
    fi
}

APPLY_IPTABLES iptables
APPLY_IPTABLES iptables-legacy
echo -e "${GREEN}[OK] Regras de iptables aplicadas com sucesso.${NC}"

# 4. Ajuste de MTU caso vxlan.calico já exista no host
echo -e "${BLUE}[4/4] Verificando interface vxlan.calico...${NC}"
if ip link show dev vxlan.calico &>/dev/null; then
    ip link set dev vxlan.calico mtu 1200 2>/dev/null || true
    echo -e "${GREEN}[OK] MTU de vxlan.calico ajustado para 1200.${NC}"
else
    echo -e "${YELLOW}[INFO] Interface vxlan.calico será criada automaticamente pelo calico-node com MTU 1200.${NC}"
fi

echo -e "\n${BOLD}${GREEN}✔ Nó físico pronto para a rede híbrida Pod-to-Pod!${NC}"
echo -e "Agora, no nó master (ubuntu10), reinicie o pod do Calico deste nó com:"
echo -e "  ${BOLD}microk8s kubectl delete pod -n kube-system -l k8s-app=calico-node --field-selector spec.nodeName=$(hostname)${NC}\n"

