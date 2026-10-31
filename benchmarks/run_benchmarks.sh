#!/usr/bin/env bash
# ==============================================================================
# Script de Execução Automatizada dos Benchmarks MPI (TCC - Pedro Ivo Kuhn)
# Inclui cálculo automático de Média, Desvio Padrão, Speedup e Eficiência Paralela
# ==============================================================================

# Suprime avisos do OpenSSH e configura MCA para rede de Pods Calico CNI
export OMPI_MCA_plm_rsh_args="-o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
export OMPI_MCA_btl_tcp_if_include="eth0"
export OMPI_MCA_oob_tcp_if_include="eth0"
export OMPI_MCA_mpi_yield_when_idle="1"

# Garante arquivo de configuracao MCA local para o usuário aluno
mkdir -p "$HOME/.openmpi"
cat << 'EOF' > "$HOME/.openmpi/mca-params.conf"
btl_tcp_if_include = eth0
oob_tcp_if_include = eth0
mpi_yield_when_idle = 1
EOF

REPS=5 # Número de repetições para cada configuração
TMP_DIR=$(mktemp -d /tmp/mpi_benchmarks_XXXXXX)

trap "rm -rf $TMP_DIR" EXIT

echo "=========================================================="
echo "        BATERIA DE TESTES DE DESEMPENHO MPI               "
echo "=========================================================="

# 1. Compilação com otimização -O3
echo "[1/3] Compilando algoritmos com mpicc -O3..."
mpicc -O3 -Wall mpi_matmul.c -o mpi_matmul -lm
mpicc -O3 -Wall mpi_heat2d.c -o mpi_heat2d -lm
echo "-> Binários gerados com sucesso."
echo ""

# Verifica se foi passado um hostfile/hosts
HOSTS_PARAM=""
if [ -n "$1" ]; then
    HOSTS_PARAM="-H $1"
    echo "Usando hosts/slots especificados: $1"
    
    # Sincroniza os binários e configuração MCA com os nós trabalhadores via SCP
    echo "Sincronizando binários e configuração MCA com os nós remotos via SSH..."
    IFS=',' read -ra ADDR <<< "$1"
    for host in "${ADDR[@]}"; do
        clean_host=$(echo "$host" | cut -d: -f1 | tr -d ' ')
        if [ "$clean_host" != "master" ] && [ "$clean_host" != "localhost" ] && [ -n "$clean_host" ]; then
            echo "-> Enviando para $clean_host..."
            ssh -q -o LogLevel=ERROR -o StrictHostKeyChecking=no "$clean_host" "mkdir -p /home/aluno/.openmpi" 2>/dev/null || true
            scp -q -o LogLevel=ERROR -o StrictHostKeyChecking=no "$HOME/.openmpi/mca-params.conf" "$clean_host:/home/aluno/.openmpi/mca-params.conf" 2>/dev/null || true
            scp -q -o LogLevel=ERROR -o StrictHostKeyChecking=no mpi_matmul mpi_heat2d "$clean_host:/home/aluno/" || echo "Aviso: Falha ao copiar para $clean_host."
        fi
    done
    echo "-> Sincronização concluída com sucesso."
    echo ""
else
    echo "Aviso: Nenhum host especificado via \$1. Executando localmente no Pod mestre."
fi

# Define os processos a testar (padrão: 1 2 4, ou o valor passado em $2)
if [ -n "$2" ]; then
    PROCESS_LIST="$2"
else
    PROCESS_LIST="1 2 4"
fi
echo "Processos a avaliar (np): $PROCESS_LIST"
echo ""

# Determina o mapeamento de hosts ideal para cada np:
# Para np=2 em clusters com 3 ou mais nós (ex: master,worker-1,worker-2,worker-3),
# seleciona intencionalmente "master,worker-2" para cobrir 1 nó Local + 1 nó Nuvem no cluster híbrido.
get_hosts_for_np() {
    local target_np="$1"
    local raw_hosts="$2"
    if [ -z "$raw_hosts" ]; then
        echo ""
        return
    fi

    IFS=',' read -ra ALL_HOSTS <<< "$raw_hosts"
    local total=${#ALL_HOSTS[@]}

    if [ "$target_np" -eq 2 ] && [ "$total" -ge 3 ]; then
        echo "${ALL_HOSTS[0]},${ALL_HOSTS[2]}"
    elif [ "$target_np" -le "$total" ]; then
        local sel=("${ALL_HOSTS[@]:0:$target_np}")
        (IFS=','; echo "${sel[*]}")
    else
        echo "$raw_hosts"
    fi
}

# 2. Testes CPU-Bound (Multiplicação de Matrizes N=2800)
echo "=========================================================="
echo " [2/3] Executando Carga CPU-Bound (mpi_matmul N=2800)"
echo "=========================================================="

for np in $PROCESS_LIST; do
    echo "--- Testando com np=$np ($REPS repetições) ---"
    
    # Determina o subconjunto exato de hosts para o np atual
    CURRENT_HOSTS_FLAG=""
    if [ -n "$1" ]; then
        CURRENT_HOSTS=$(get_hosts_for_np "$np" "$1")
        CURRENT_HOSTS_FLAG="-H $CURRENT_HOSTS"
        if [ "$np" -eq 2 ] && [ "$CURRENT_HOSTS" = "master,worker-2" ]; then
            echo "Hosts ativos para np=$np: $CURRENT_HOSTS (pareamento híbrido Local + Nuvem)"
        else
            echo "Hosts ativos para np=$np: $CURRENT_HOSTS"
        fi
    fi

    for r in $(seq 1 $REPS); do
        OUT=$(mpirun --allow-run-as-root --oversubscribe \
             --mca plm_rsh_args "-o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
             --mca btl_tcp_if_include eth0 \
             --mca oob_tcp_if_include eth0 \
             --mca mpi_yield_when_idle 1 \
             $CURRENT_HOSTS_FLAG -np $np ./mpi_matmul 2>/dev/null)
        
        echo "$OUT"
        
        # Extrai o tempo em segundos
        SEC=$(echo "$OUT" | grep "RESULTADO_CPU_BOUND" | sed -n 's/.*tempo_segundos=\([0-9.]*\)/\1/p')
        if [ -n "$SEC" ]; then
            echo "$SEC" >> "$TMP_DIR/matmul_np_${np}.txt"
        fi
    done
    echo ""
done

# 3. Testes Network-Bound (Difusão de Calor 2D 2000x2000, 800 iterações)
echo "=========================================================="
echo " [3/3] Executando Carga Network-Bound (mpi_heat2d 2000x2000)"
echo "=========================================================="

for np in $PROCESS_LIST; do
    echo "--- Testando com np=$np ($REPS repetições) ---"
    
    # Determina o subconjunto exato de hosts para o np atual
    CURRENT_HOSTS_FLAG=""
    if [ -n "$1" ]; then
        CURRENT_HOSTS=$(get_hosts_for_np "$np" "$1")
        CURRENT_HOSTS_FLAG="-H $CURRENT_HOSTS"
        if [ "$np" -eq 2 ] && [ "$CURRENT_HOSTS" = "master,worker-2" ]; then
            echo "Hosts ativos para np=$np: $CURRENT_HOSTS (pareamento híbrido Local + Nuvem)"
        else
            echo "Hosts ativos para np=$np: $CURRENT_HOSTS"
        fi
    fi

    for r in $(seq 1 $REPS); do
        OUT=$(mpirun --allow-run-as-root --oversubscribe \
             --mca plm_rsh_args "-o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
             --mca btl_tcp_if_include eth0 \
             --mca oob_tcp_if_include eth0 \
             --mca mpi_yield_when_idle 1 \
             $CURRENT_HOSTS_FLAG -np $np ./mpi_heat2d 2>/dev/null)
        
        echo "$OUT"
        
        # Extrai o tempo em segundos
        SEC=$(echo "$OUT" | grep "RESULTADO_NETWORK_BOUND" | sed -n 's/.*tempo_segundos=\([0-9.]*\)/\1/p')
        if [ -n "$SEC" ]; then
            echo "$SEC" >> "$TMP_DIR/heat_np_${np}.txt"
        fi
    done
    echo ""
done

# 4. Cálculo Estatístico (Média, Desvio Padrão, Speedup e Eficiência)
echo "=========================================================="
echo "          RESUMO ESTATÍSTICO CONSOLIDADO DO TCC           "
echo "=========================================================="

awk -v procs="$PROCESS_LIST" -v tmp="$TMP_DIR" '
BEGIN {
    n_procs = split(procs, plist, " ")
    
    # ----------------------------------------------------
    # 1. Processa Carga CPU-Bound
    # ----------------------------------------------------
    delete means
    delete stds
    for (idx = 1; idx <= n_procs; idx++) {
        p = plist[idx]
        file = tmp "/matmul_np_" p ".txt"
        n = 0; sum = 0
        delete vals
        while ((getline val < file) > 0) {
            if (val > 0) { n++; vals[n] = val; sum += val }
        }
        close(file)
        if (n > 0) {
            means[p] = sum / n
            var = 0
            for (i = 1; i <= n; i++) var += (vals[i] - means[p])^2
            stds[p] = (n > 1) ? sqrt(var / (n - 1)) : 0
        }
    }
    
    t1_matmul = (1 in means) ? means[1] : means[plist[1]]
    print "\n=== 1. Carga CPU-Bound: Multiplicação de Matrizes (N=2800) ==="
    printf "%-5s | %-18s | %-10s | %-10s\n", "np", "Tempo Médio (s)", "Speedup", "Eficiência"
    print "------------------------------------------------------------"
    for (idx = 1; idx <= n_procs; idx++) {
        p = plist[idx]
        if (p in means) {
            speedup = t1_matmul / means[p]
            eff = (speedup / p) * 100
            printf "%-5d | %6.3f ± %5.3f s   | %8.2fx | %9.1f%%\n", p, means[p], stds[p], speedup, eff
        }
    }
    
    # ----------------------------------------------------
    # 2. Processa Carga Network-Bound
    # ----------------------------------------------------
    delete means
    delete stds
    for (idx = 1; idx <= n_procs; idx++) {
        p = plist[idx]
        file = tmp "/heat_np_" p ".txt"
        n = 0; sum = 0
        delete vals
        while ((getline val < file) > 0) {
            if (val > 0) { n++; vals[n] = val; sum += val }
        }
        close(file)
        if (n > 0) {
            means[p] = sum / n
            var = 0
            for (i = 1; i <= n; i++) var += (vals[i] - means[p])^2
            stds[p] = (n > 1) ? sqrt(var / (n - 1)) : 0
        }
    }
    
    t1_heat = (1 in means) ? means[1] : means[plist[1]]
    print "\n=== 2. Carga Network-Bound: Difusão de Calor 2D (2000x2000, 800 iter) ==="
    printf "%-5s | %-18s | %-10s | %-10s\n", "np", "Tempo Médio (s)", "Speedup", "Eficiência"
    print "------------------------------------------------------------"
    for (idx = 1; idx <= n_procs; idx++) {
        p = plist[idx]
        if (p in means) {
            speedup = t1_heat / means[p]
            eff = (speedup / p) * 100
            printf "%-5d | %6.3f ± %5.3f s   | %8.2fx | %9.1f%%\n", p, means[p], stds[p], speedup, eff
        }
    }
    print ""
}
'

echo "=========================================================="
echo " Bateria concluída com sucesso! Dados prontos para o TCC."
echo "=========================================================="
