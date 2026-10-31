#!/usr/bin/env bash
# ==============================================================================
# Script de Configuração e Bootstrap do Calico CNI para Cluster Híbrido MicroK8s
# (Rede Plana Pod-to-Pod sobre Tailscale VPN)
# ==============================================================================
# Este script ajusta:
# 1. Parâmetros de kernel (ip_forward e rp_filter=2) para evitar descarte de pacotes
# 2. MTU do Calico (veth_mtu: 1200) para evitar fragmentação no túnel duplo VXLAN+Wireguard
# 3. Autodetecção de IP do Calico na interface tailscale0 com CALICO_IPV4POOL_VXLAN=Always
# 4. Ajuste imediato do MTU da interface vxlan.calico no host
# 5. Regras de firewall (iptables) para tráfego VXLAN (UDP 4789) e FORWARD na tailscale0
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[AVISO]${NC} $1"; }
log_error() { echo -e "${RED}[ERRO]${NC} $1"; }
log_header() { echo -e "\n${CYAN}${BOLD}=== $1 ===${NC}"; }

# Detecta kubectl / microk8s kubectl
if command -v microk8s &> /dev/null; then
    KUBECTL="microk8s kubectl"
elif command -v kubectl &> /dev/null; then
    KUBECTL="kubectl"
else
    log_error "Nem 'microk8s kubectl' nem 'kubectl' foram encontrados no PATH."
    exit 1
fi

log_header "1. Configurando Parâmetros de Rede do Kernel (Host Local)"

# Ativa IP Forwarding e Loose Reverse Path Filtering (rp_filter=2)
# rp_filter=2 permite roteamento assimétrico necessário entre o overlay VXLAN e a malha Tailscale
if [ "$(id -u)" -eq 0 ]; then
    sysctl -w net.ipv4.ip_forward=1 || true
    sysctl -w net.ipv4.conf.all.rp_filter=2 || true
    sysctl -w net.ipv4.conf.default.rp_filter=2 || true
    echo -e "net.ipv4.ip_forward = 1\nnet.ipv4.conf.all.rp_filter = 2\nnet.ipv4.conf.default.rp_filter = 2" > /etc/sysctl.d/99-hybrid-calico.conf 2>/dev/null || true
    log_success "Parâmetros sysctl aplicados e gravados em /etc/sysctl.d/99-hybrid-calico.conf."
elif sudo -n true 2>/dev/null; then
    sudo sysctl -w net.ipv4.ip_forward=1 || true
    sudo sysctl -w net.ipv4.conf.all.rp_filter=2 || true
    sudo sysctl -w net.ipv4.conf.default.rp_filter=2 || true
    echo -e "net.ipv4.ip_forward = 1\nnet.ipv4.conf.all.rp_filter = 2\nnet.ipv4.conf.default.rp_filter = 2" | sudo tee /etc/sysctl.d/99-hybrid-calico.conf >/dev/null 2>&1 || true
    log_success "Parâmetros sysctl aplicados via sudo sem senha."
else
    log_warn "Executando sem privilégios de root/sudo sem senha. Parâmetros sysctl do host mantidos (execute com sudo se desejar gravar em /etc/sysctl.d)."
fi

log_header "2. Ajustando MTU do Calico (calico-config ConfigMap)"
# MTU 1200 garante que pacotes encapsulados em VXLAN (50 bytes) caibam no MTU 1280 do Tailscale WireGuard
log_info "Aplicando patch veth_mtu: '1200' no ConfigMap calico-config (kube-system)..."
$KUBECTL patch cm calico-config -n kube-system --type merge -p '{"data":{"veth_mtu":"1200"}}'
log_success "ConfigMap calico-config atualizado com sucesso com veth_mtu: '1200'."

log_header "3. Reconfigurando DaemonSet calico-node"
FORCE_RESTART=false
if [[ "${1:-}" == "--restart" || "${1:-}" == "-r" ]]; then
    FORCE_RESTART=true
fi

CURRENT_METHOD=$($KUBECTL get daemonset calico-node -n kube-system -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="IP_AUTODETECTION_METHOD")].value}' 2>/dev/null || echo "")
CURRENT_VXLAN=$($KUBECTL get daemonset calico-node -n kube-system -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CALICO_IPV4POOL_VXLAN")].value}' 2>/dev/null || echo "")

if [ "$CURRENT_METHOD" != "interface=tailscale0" ] || [ "$CURRENT_VXLAN" != "Always" ]; then
    log_info "Configurando IP_AUTODETECTION_METHOD='interface=tailscale0' e CALICO_IPV4POOL_VXLAN='Always'..."
    $KUBECTL set env daemonset/calico-node -n kube-system \
        IP_AUTODETECTION_METHOD="interface=tailscale0" \
        CALICO_IPV4POOL_VXLAN="Always"
    FORCE_RESTART=true
else
    log_success "DaemonSet calico-node já configurado com IP_AUTODETECTION_METHOD e CALICO_IPV4POOL_VXLAN corretos."
fi

if [ "$FORCE_RESTART" = true ]; then
    log_info "Reiniciando DaemonSet calico-node para recarregar configurações..."
    $KUBECTL rollout restart daemonset/calico-node -n kube-system
    log_info "Aguardando conclusão do rollout dos pods do calico-node..."
    $KUBECTL rollout status daemonset/calico-node -n kube-system --timeout=180s
    log_success "DaemonSet calico-node estabilizado com sucesso!"
else
    log_info "Rollout não requerido (use --restart para forçar o reinício dos pods do Calico)."
fi

log_header "4. Ajustando CoreDNS e Metrics Server para execução no nó Master (ubuntu10)"
log_info "Garantindo que o CoreDNS execute no nó com Tailscale (ubuntu10)..."
$KUBECTL patch deployment coredns -n kube-system -p '{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":"ubuntu10"}}}}}' || true
log_success "Deployment coredns fixado em ubuntu10."

log_info "Garantindo que o Metrics Server execute no nó com Tailscale (ubuntu10)..."
$KUBECTL patch deployment metrics-server -n kube-system -p '{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":"ubuntu10"}}}}}' || true
log_success "Deployment metrics-server fixado em ubuntu10."

log_header "5. Ajustando MTU da Interface VXLAN Local (vxlan.calico)"
# Ajusta a interface existente imediatamente sem necessidade de reiniciar a máquina física
if ip link show vxlan.calico &>/dev/null; then
    if [ "$(id -u)" -eq 0 ]; then
        ip link set dev vxlan.calico mtu 1200 2>/dev/null || true
    elif sudo -n true 2>/dev/null; then
        sudo ip link set dev vxlan.calico mtu 1200 2>/dev/null || true
    else
        log_warn "Ajuste direto do MTU no host requer sudo. O pod calico-node reconfigurará a interface no próximo ciclo."
    fi
    CURRENT_MTU=$(ip -o link show dev vxlan.calico | awk '{print $5}' || echo "desconhecido")
    log_success "Status da interface vxlan.calico: MTU ${CURRENT_MTU}."
else
    log_warn "Interface vxlan.calico ainda não criada no host ou gerenciada dinamicamente pelo container."
fi

log_header "5. Aplicando Regras de Firewall e Roteamento VXLAN no Host Local"
APPLY_IPTABLES() {
    local ipt="$1"
    if command -v "$ipt" &>/dev/null; then
        # Previne loop de roteamento/encapsulação circular Tailscale sobre interfaces Calico
        if ! $ipt -C OUTPUT -d 10.1.0.0/16 -p udp --dport 41641 -j DROP 2>/dev/null; then
            $ipt -I OUTPUT 1 -d 10.1.0.0/16 -p udp --dport 41641 -j DROP 2>/dev/null || true
        fi
        if ! $ipt -C OUTPUT -o vxlan.calico -p udp --dport 41641 -j DROP 2>/dev/null; then
            $ipt -I OUTPUT 1 -o vxlan.calico -p udp --dport 41641 -j DROP 2>/dev/null || true
        fi

        # Permite tráfego VXLAN vindo da VPN Tailscale
        if ! $ipt -C INPUT -i tailscale0 -p udp --dport 4789 -j ACCEPT 2>/dev/null; then
            $ipt -I INPUT 1 -i tailscale0 -p udp --dport 4789 -j ACCEPT 2>/dev/null || true
        fi
        # Permite encaminhamento entre a VPN e as interfaces de pods/vxlan do Calico
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

if [ "$(id -u)" -eq 0 ]; then
    APPLY_IPTABLES iptables
    APPLY_IPTABLES iptables-legacy
    log_success "Regras de INPUT (UDP 4789) e FORWARD configuradas para a interface tailscale0."
elif sudo -n true 2>/dev/null; then
    sudo bash -c "$(declare -f APPLY_IPTABLES); APPLY_IPTABLES iptables; APPLY_IPTABLES iptables-legacy" || true
    log_success "Regras de INPUT (UDP 4789) e FORWARD configuradas via sudo."
else
    log_warn "Executando sem sudo sem senha. As regras de iptables do host devem ser executadas com sudo para garantir o tráfego do túnel local se o UFW/iptables estiver restritivo."
fi

log_header "Resumo da Configuração do Calico CNI"
$KUBECTL get cm calico-config -n kube-system -o jsonpath='{.data.veth_mtu}' | xargs -I {} echo "-> veth_mtu ConfigMap: {}"
$KUBECTL get daemonset calico-node -n kube-system -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="IP_AUTODETECTION_METHOD")].value}' | xargs -I {} echo "-> IP_AUTODETECTION_METHOD: {}"
$KUBECTL get daemonset calico-node -n kube-system -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CALICO_IPV4POOL_VXLAN")].value}' | xargs -I {} echo "-> CALICO_IPV4POOL_VXLAN: {}"

echo -e "\n${GREEN}${BOLD}✔ Cluster configurado para Rede Plana Pod-to-Pod via Calico + Tailscale!${NC}\n"
