#!/usr/bin/env bash
# ==============================================================================
# Script de Execução Automatizada dos Benchmarks MPI (TCC - Pedro Ivo Kuhn)
# Tríade Metodológica Completa:
# 1. Zero-Network / Pura CPU: Simulação de Monte Carlo (Estimativa de Pi)
# 2. Bulk-Synchronous / CPU + Dados: Multiplicação de Matrizes (Matmul)
# 3. Fine-Grained / Latency-Bound: Difusão de Calor 2D (Heat2D Stencil)
# Inclui:
# - Exportação de Logs (.log) e Planilha (.csv) pronta para Google Planilhas
# - Cooldown anti-throttling térmico e recomposição de créditos de CPU na nuvem
# - Decomposição Granular de Tempos (Rede, Computação Local e Straggler Wait)
# - Cálculo automático de Média, Desvio Padrão, IC 95%, Speedup e Eficiência
# ==============================================================================

# Suprime avisos do OpenSSH e configura MCA para rede de Pods Calico CNI e VPN WAN Tailscale
export OMPI_MCA_plm_rsh_args="-o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
export OMPI_MCA_btl_tcp_if_include="eth0"
export OMPI_MCA_oob_tcp_if_include="eth0"
export OMPI_MCA_mpi_yield_when_idle="1"
export OMPI_MCA_btl_tcp_sndbuf="4194304"
export OMPI_MCA_btl_tcp_rcvbuf="4194304"

# Garante arquivo de configuracao MCA local para o usuário aluno
mkdir -p "${HOME:-/home/aluno}/.openmpi" 2>/dev/null || true
cat << 'EOF' > "${HOME:-/home/aluno}/.openmpi/mca-params.conf" 2>/dev/null || true
btl_tcp_if_include = eth0
oob_tcp_if_include = eth0
mpi_yield_when_idle = 1
btl_tcp_sndbuf = 4194304
btl_tcp_rcvbuf = 4194304
EOF

# ------------------------------------------------------------------------------
# Configuração de Logs e Arquivo CSV para o Google Planilhas
# ------------------------------------------------------------------------------
RESULTS_DIR="${RESULTS_DIR:-$(pwd)/resultados}"
mkdir -p "$RESULTS_DIR"

if [ -z "$BENCH_TAG" ]; then
    DEFAULT_TAG="ensaio_$(date +%Y%m%d_%H%M%S)"
    if [ -t 0 ]; then
        echo "=========================================================="
        echo "        CONFIGURAÇÃO DO ENSAIO DE BENCHMARK MPI           "
        echo "=========================================================="
        read -r -p "Identificador deste ensaio (ex: local_puro, nuvem_aws, nuvem_azure) [padrão: $DEFAULT_TAG]: " USER_INPUT
        BENCH_TAG="${USER_INPUT:-$DEFAULT_TAG}"
    else
        BENCH_TAG="$DEFAULT_TAG"
    fi
fi
# Sanitiza o nome para evitar caracteres inválidos em arquivo (sem underscore residual no final)
BENCH_TAG=$(echo -n "$BENCH_TAG" | tr -c '[:alnum:]_-' '_' | sed 's/_$//')

LOG_FILE="$RESULTS_DIR/${BENCH_TAG}_execucao.log"
CSV_FILE="$RESULTS_DIR/${BENCH_TAG}_amostras.csv"
RESUMO_CSV="$RESULTS_DIR/${BENCH_TAG}_resumo.csv"

# Redireciona stdout e stderr para tela e arquivo de log simultaneamente
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=========================================================="
echo "        BATERIA DE TESTES DE DESEMPENHO MPI (TCC)         "
echo "=========================================================="
echo "Identificador do Ensaio: $BENCH_TAG"
echo "Log completo da execução: $LOG_FILE"
echo "Amostras para Google Planilhas: $CSV_FILE"
echo "Resumo consolidado: $RESUMO_CSV"
echo "=========================================================="
echo ""

# Inicializa o cabeçalho do arquivo CSV de amostras
echo "cenario,carga,iteracao,np,N,t_total,t_rede,t_bcast,t_scatter,t_gather,t_comp_max,t_comp_min,t_straggler_wait" > "$CSV_FILE"

# Parâmetros de execução (Sobrescrevíveis via variáveis de ambiente)
MC_SAMPLES="${MC_SAMPLES:-2500000000}" # 2.5 bilhões de amostras Monte Carlo (Zero-Network)
MC_REPS="${MC_REPS:-30}"             # 30 repetições para rigor estatístico do TCC
MATMUL_N="${MATMUL_N:-4800}"        # Dimensão da matriz quadrada (N x N)
MATMUL_REPS="${MATMUL_REPS:-30}"    # 30 repetições para rigor estatístico do TCC
HEAT_ROWS="${HEAT_ROWS:-2000}"      # Linhas da grade 2D
HEAT_STEPS="${HEAT_STEPS:-800}"     # Passos no tempo
HEAT_REPS="${HEAT_REPS:-30}"        # 30 repetições para rigor estatístico do TCC
COOLDOWN_SECS="${COOLDOWN_SECS:-5}" # Segundos de repouso anti-throttling térmico/créditos

TMP_DIR=$(mktemp -d /tmp/mpi_benchmarks_XXXXXX)
trap "rm -rf $TMP_DIR" EXIT

# Função de cooldown para resfriamento de CPU e recomposição de rajada
cooldown() {
    local secs="${1:-$COOLDOWN_SECS}"
    if [ "$secs" -gt 0 ]; then
        echo "-> [Cooldown] Pausa de ${secs}s para resfriamento térmico e alívio de créditos de CPU..."
        sleep "$secs"
    fi
}

# 1. Compilação Multi-Arquitetura Otimizada
# -O3 -mavx2 -mfma -funroll-loops para Intel Xeon Sapphire Rapids / AMD EPYC
# com detecção segura para evitar SIGILL em nós Core i7 Sandy Bridge (i7-2600 local)
echo "[1/4] Compilando algoritmos..."
if grep -q "avx2" /proc/cpuinfo 2>/dev/null && grep -q "fma" /proc/cpuinfo 2>/dev/null; then
    MATMUL_ARCH_FLAGS="-mavx2 -mfma"
elif grep -q "avx" /proc/cpuinfo 2>/dev/null; then
    MATMUL_ARCH_FLAGS="-mavx"
else
    MATMUL_ARCH_FLAGS=""
fi

mpicc -O3 -Wall mpi_montecarlo.c -o mpi_montecarlo -lm
mpicc -O3 $MATMUL_ARCH_FLAGS -funroll-loops -Wall mpi_matmul.c -o mpi_matmul -lm
mpicc -O3 -Wall mpi_heat2d.c -o mpi_heat2d -lm
echo "-> Binários gerados com sucesso (Monte Carlo, Matmul IFUNC multi-arch e Heat2D)."
echo ""

# Verifica se foi passado um hostfile/hosts ou detecta automaticamente via ~/.ssh/config
TARGET_HOSTS="${1:-}"
if [ -z "$TARGET_HOSTS" ]; then
    DETECTED=$(grep -E '^Host (master|worker-[0-9]+) ' ~/.ssh/config 2>/dev/null | awk '{print $2}' | paste -sd, - || true)
    if [ -n "$DETECTED" ]; then
        TARGET_HOSTS="$DETECTED"
        echo "Hosts detectados automaticamente a partir de ~/.ssh/config: $TARGET_HOSTS"
    fi
fi

HOSTS_PARAM=""
if [ -n "$TARGET_HOSTS" ]; then
    HOSTS_PARAM="-H $TARGET_HOSTS"
    echo "Usando hosts/slots especificados: $TARGET_HOSTS"
    
    # Sincroniza os binários e configuração MCA com os nós trabalhadores via SCP
    echo "Sincronizando binários e configuração MCA com os nós remotos via SSH..."
    IFS=',' read -ra ADDR <<< "$TARGET_HOSTS"
    for host in "${ADDR[@]}"; do
        clean_host=$(echo "$host" | cut -d: -f1 | tr -d ' ')
        if [ "$clean_host" != "master" ] && [ "$clean_host" != "localhost" ] && [ -n "$clean_host" ]; then
            echo "-> Enviando para $clean_host..."
            ssh -q -o LogLevel=ERROR -o StrictHostKeyChecking=no "$clean_host" "mkdir -p /home/aluno/.openmpi" 2>/dev/null || true
            scp -q -o LogLevel=ERROR -o StrictHostKeyChecking=no "$HOME/.openmpi/mca-params.conf" "$clean_host:/home/aluno/.openmpi/mca-params.conf" 2>/dev/null || true
            scp -q -o LogLevel=ERROR -o StrictHostKeyChecking=no mpi_montecarlo mpi_matmul mpi_heat2d "$clean_host:/home/aluno/" || echo "Aviso: Falha ao copiar para $clean_host."
        fi
    done
    echo "-> Sincronização concluída com sucesso."
    echo ""
else
    echo "Aviso: Nenhum host especificado ou detectado. Executando localmente no Pod mestre."
fi

# Define os processos a testar (padrão: 1 2 4, ou o valor passado em $2)
if [ -n "$2" ]; then
    PROCESS_LIST="$2"
else
    PROCESS_LIST="1 2 4"
fi
echo "Processos a avaliar (np): $PROCESS_LIST"
echo ""

# 2. Testes Zero-Network / CPU Pura (Simulação de Monte Carlo N=2.500.000.000, 30 Repetições com Decomposição)
echo "=========================================================="
echo " [2/4] Executando Carga Zero-Network (mpi_montecarlo N=$MC_SAMPLES, REPS=$MC_REPS)"
echo "=========================================================="

for np in $PROCESS_LIST; do
    echo "--- Testando Carga Zero-Network com np=$np ($MC_REPS repetições internas + warm-up) ---"
    
    # Determina o subconjunto exato de hosts para o np atual
    CURRENT_HOSTS_FLAG=""
    if [ -n "$TARGET_HOSTS" ]; then
        IFS=',' read -ra ALL_HOSTS <<< "$TARGET_HOSTS"
        TOTAL_AVAILABLE=${#ALL_HOSTS[@]}
        if [ "$np" -le "$TOTAL_AVAILABLE" ]; then
            SELECTED=("${ALL_HOSTS[@]:0:$np}")
            CURRENT_HOSTS=$(IFS=','; echo "${SELECTED[*]}")
        else
            CURRENT_HOSTS="$TARGET_HOSTS"
        fi
        CURRENT_HOSTS_FLAG="-H $CURRENT_HOSTS"
        echo "Hosts ativos para np=$np: $CURRENT_HOSTS"
    fi

    # Executa mpi_montecarlo
    while IFS= read -r line; do
        echo "$line"
        if [[ "$line" == AMOSTRA_MONTECARLO* ]]; then
            SEC=$(echo "$line" | sed -n 's/.*t_total=\([0-9.]*\).*/\1/p')
            if [ -n "$SEC" ]; then
                echo "$SEC" >> "$TMP_DIR/mc_np_${np}.txt"
            fi
            # Grava no CSV unificado para Google Planilhas
            it=$(echo "$line" | sed -n 's/.*iter=\([0-9]*\).*/\1/p')
            t_tot=$(echo "$line" | sed -n 's/.*t_total=\([0-9.]*\).*/\1/p')
            t_red=$(echo "$line" | sed -n 's/.*t_rede=\([0-9.]*\).*/\1/p')
            t_cmax=$(echo "$line" | sed -n 's/.*t_comp_max=\([0-9.]*\).*/\1/p')
            t_cmin=$(echo "$line" | sed -n 's/.*t_comp_min=\([0-9.]*\).*/\1/p')
            t_strag=$(echo "$line" | sed -n 's/.*t_straggler_wait=\([0-9.]*\).*/\1/p')
            echo "${BENCH_TAG},monte_carlo,${it},${np},${MC_SAMPLES},${t_tot},${t_red},0.0000,0.0000,0.0000,${t_cmax},${t_cmin},${t_strag}" >> "$CSV_FILE"
        elif [[ "$line" == RESUMO_ESTATISTICO_MONTECARLO* ]]; then
            echo "$line" >> "$TMP_DIR/mc_resumo_np_${np}.txt"
        fi
    done < <(mpirun --allow-run-as-root --oversubscribe \
             --mca plm_rsh_args "-o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
             --mca btl_tcp_if_include eth0 \
             --mca oob_tcp_if_include eth0 \
             --mca mpi_yield_when_idle 1 \
             --mca btl_tcp_sndbuf 4194304 \
             --mca btl_tcp_rcvbuf 4194304 \
             $CURRENT_HOSTS_FLAG -np $np ./mpi_montecarlo $MC_SAMPLES $MC_REPS 2>/dev/null)
    
    # Cooldown entre configurações de processo para resfriamento
    cooldown "$COOLDOWN_SECS"
done

# Cooldown intermediário entre as baterias Zero-Network e CPU-Bound
echo "Transição de fase: preparando carga CPU-Bound (Matmul)..."
cooldown 8

# 3. Testes CPU-Bound (Multiplicação de Matrizes N=4800, 30 Repetições com Decomposição)
echo "=========================================================="
echo " [3/4] Executando Carga CPU-Bound (mpi_matmul N=$MATMUL_N, REPS=$MATMUL_REPS)"
echo "=========================================================="

for np in $PROCESS_LIST; do
    echo "--- Testando Carga CPU-Bound com np=$np ($MATMUL_REPS repetições internas + warm-up) ---"
    
    # Determina o subconjunto exato de hosts para o np atual
    CURRENT_HOSTS_FLAG=""
    if [ -n "$TARGET_HOSTS" ]; then
        IFS=',' read -ra ALL_HOSTS <<< "$TARGET_HOSTS"
        TOTAL_AVAILABLE=${#ALL_HOSTS[@]}
        if [ "$np" -le "$TOTAL_AVAILABLE" ]; then
            SELECTED=("${ALL_HOSTS[@]:0:$np}")
            CURRENT_HOSTS=$(IFS=','; echo "${SELECTED[*]}")
        else
            CURRENT_HOSTS="$TARGET_HOSTS"
        fi
        CURRENT_HOSTS_FLAG="-H $CURRENT_HOSTS"
        echo "Hosts ativos para np=$np: $CURRENT_HOSTS"
    fi

    # Executa com tuning de socket TCP (4MB buffers para WAN BDP)
    # mpi_matmul gerencia internamente o warm-up e as repetições
    while IFS= read -r line; do
        echo "$line"
        if [[ "$line" == AMOSTRA_CPU_BOUND* ]]; then
            SEC=$(echo "$line" | sed -n 's/.*t_total=\([0-9.]*\).*/\1/p')
            if [ -n "$SEC" ]; then
                echo "$SEC" >> "$TMP_DIR/matmul_np_${np}.txt"
            fi
            # Grava no CSV unificado para Google Planilhas
            clean_vals=$(echo "$line" | sed 's/AMOSTRA_CPU_BOUND,//' | sed 's/[a-zA-Z0-9_]*=//g')
            echo "${BENCH_TAG},cpu_bound,${clean_vals}" >> "$CSV_FILE"
        elif [[ "$line" == RESUMO_ESTATISTICO* ]]; then
            echo "$line" >> "$TMP_DIR/matmul_resumo_np_${np}.txt"
        fi
    done < <(mpirun --allow-run-as-root --oversubscribe \
             --mca plm_rsh_args "-o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
             --mca btl_tcp_if_include eth0 \
             --mca oob_tcp_if_include eth0 \
             --mca mpi_yield_when_idle 1 \
             --mca btl_tcp_sndbuf 4194304 \
             --mca btl_tcp_rcvbuf 4194304 \
             $CURRENT_HOSTS_FLAG -np $np ./mpi_matmul $MATMUL_N $MATMUL_REPS 2>/dev/null)
    
    # Cooldown entre configurações de processo para resfriamento
    cooldown "$COOLDOWN_SECS"
done

# Cooldown intermediário entre as baterias CPU-Bound e Network-Bound
echo "Transição de fase: preparando carga Network-Bound (Heat2D)..."
cooldown 8

# 4. Testes Network-Bound (Difusão de Calor 2D, 30 Repetições com Decomposição)
echo "=========================================================="
echo " [4/4] Executando Carga Network-Bound (mpi_heat2d ${HEAT_ROWS}x${HEAT_ROWS}, ${HEAT_STEPS} iter, REPS=$HEAT_REPS)"
echo "=========================================================="

for np in $PROCESS_LIST; do
    echo "--- Testando Carga Network-Bound com np=$np ($HEAT_REPS repetições internas + warm-up) ---"
    
    # Determina o subconjunto exato de hosts para o np atual
    CURRENT_HOSTS_FLAG=""
    if [ -n "$TARGET_HOSTS" ]; then
        IFS=',' read -ra ALL_HOSTS <<< "$TARGET_HOSTS"
        TOTAL_AVAILABLE=${#ALL_HOSTS[@]}
        if [ "$np" -le "$TOTAL_AVAILABLE" ]; then
            SELECTED=("${ALL_HOSTS[@]:0:$np}")
            CURRENT_HOSTS=$(IFS=','; echo "${SELECTED[*]}")
        else
            CURRENT_HOSTS="$TARGET_HOSTS"
        fi
        CURRENT_HOSTS_FLAG="-H $CURRENT_HOSTS"
        echo "Hosts ativos para np=$np: $CURRENT_HOSTS"
    fi

    # Executa com tuning de socket TCP (4MB buffers para WAN BDP)
    # mpi_heat2d gerencia internamente o warm-up e as repetições
    while IFS= read -r line; do
        echo "$line"
        if [[ "$line" == AMOSTRA_NETWORK_BOUND* ]]; then
            SEC=$(echo "$line" | sed -n 's/.*t_total=\([0-9.]*\).*/\1/p')
            if [ -n "$SEC" ]; then
                echo "$SEC" >> "$TMP_DIR/heat_np_${np}.txt"
            fi
            # Grava no CSV unificado para Google Planilhas
            # Formato: cenario,carga,iteracao,np,N,t_total,t_rede,t_bcast,t_scatter,t_gather,t_comp_max,t_comp_min,t_straggler_wait
            it=$(echo "$line" | sed -n 's/.*iter=\([0-9]*\).*/\1/p')
            t_tot=$(echo "$line" | sed -n 's/.*t_total=\([0-9.]*\).*/\1/p')
            t_red=$(echo "$line" | sed -n 's/.*t_rede=\([0-9.]*\).*/\1/p')
            t_cmax=$(echo "$line" | sed -n 's/.*t_comp_max=\([0-9.]*\).*/\1/p')
            t_cmin=$(echo "$line" | sed -n 's/.*t_comp_min=\([0-9.]*\).*/\1/p')
            t_strag=$(echo "$line" | sed -n 's/.*t_straggler_wait=\([0-9.]*\).*/\1/p')
            echo "${BENCH_TAG},network_bound,${it},${np},${HEAT_ROWS},${t_tot},${t_red},0.0000,0.0000,0.0000,${t_cmax},${t_cmin},${t_strag}" >> "$CSV_FILE"
        elif [[ "$line" == RESUMO_ESTATISTICO_NETWORK* ]]; then
            echo "$line" >> "$TMP_DIR/heat_resumo_np_${np}.txt"
        fi
    done < <(mpirun --allow-run-as-root --oversubscribe \
             --mca plm_rsh_args "-o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
             --mca btl_tcp_if_include eth0 \
             --mca oob_tcp_if_include eth0 \
             --mca mpi_yield_when_idle 1 \
             --mca btl_tcp_sndbuf 4194304 \
             --mca btl_tcp_rcvbuf 4194304 \
             $CURRENT_HOSTS_FLAG -np $np ./mpi_heat2d $HEAT_ROWS $HEAT_ROWS $HEAT_STEPS $HEAT_REPS 2>/dev/null)
    
    # Cooldown entre configurações de processo
    cooldown "$COOLDOWN_SECS"
done

# 5. Cálculo Estatístico (Média, Desvio Padrão, Speedup e Eficiência)
echo "=========================================================="
echo "          RESUMO ESTATÍSTICO CONSOLIDADO DO TCC           "
echo "=========================================================="

awk -v procs="$PROCESS_LIST" -v tmp="$TMP_DIR" -v mc_samples="$MC_SAMPLES" -v mc_reps="$MC_REPS" -v matmul_n="$MATMUL_N" -v matmul_reps="$MATMUL_REPS" -v heat_rows="$HEAT_ROWS" -v heat_steps="$HEAT_STEPS" -v heat_reps="$HEAT_REPS" -v tag="$BENCH_TAG" -v resumo_csv="$RESUMO_CSV" '
BEGIN {
    n_procs = split(procs, plist, " ")
    
    # Cabeçalho do CSV Resumo
    print "cenario,carga,np,dimensao_N,repeticoes,tempo_medio_s,desvio_padrao_s,ic95_s,speedup,eficiencia_pct,media_rede_s,media_comp_max_s,media_straggler_s" > resumo_csv

    # ----------------------------------------------------
    # 1. Processa Carga Zero-Network (Monte Carlo)
    # ----------------------------------------------------
    delete means
    delete stds
    delete ic95s
    for (idx = 1; idx <= n_procs; idx++) {
        p = plist[idx]
        file = tmp "/mc_np_" p ".txt"
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
            ic95s[p] = (n > 1) ? 1.96 * stds[p] / sqrt(n) : 0
        }
    }
    
    t1_mc = (1 in means) ? means[1] : means[plist[1]]
    printf "\n=== 1. Carga Zero-Network: Simulação de Monte Carlo (N=%d, REPS=%d) ===\n", mc_samples, mc_reps
    printf "%-5s | %-18s | %-10s | %-10s\n", "np", "Tempo Médio (s)", "Speedup", "Eficiência"
    print "------------------------------------------------------------"
    for (idx = 1; idx <= n_procs; idx++) {
        p = plist[idx]
        if (p in means) {
            speedup = t1_mc / means[p]
            eff = (speedup / p) * 100
            printf "%-5d | %6.3f ± %5.3f s   | %8.2fx | %9.1f%%\n", p, means[p], stds[p], speedup, eff
        }
    }

    # 1.1 Decomposição Média de Tempos Monte Carlo (Rede, Comp, Straggler)
    printf "\n--- Decomposição Média de Tempos Zero-Network (N=%d) ---\n", mc_samples
    printf "%-5s | %-12s | %-12s | %-12s | %-12s\n", "np", "T_Total (s)", "T_Rede (s)", "T_CompMax(s)", "Straggler(s)"
    print "------------------------------------------------------------------------"
    for (idx = 1; idx <= n_procs; idx++) {
        p = plist[idx]
        res_file = tmp "/mc_resumo_np_" p ".txt"
        m_rede = 0; m_comp = 0; m_strag = 0
        if ((getline line < res_file) > 0) {
            split(line, fields, ",")
            delete kv
            for (f in fields) {
                split(fields[f], pair, "=")
                if (length(pair) == 2) kv[pair[1]] = pair[2]
            }
            m_rede = kv["media_rede"]
            m_comp = kv["media_comp_max"]
            m_strag = kv["media_straggler"]
            printf "%-5d | %10.4f s | %10.4f s | %10.4f s | %10.4f s\n",
                   p, kv["media_total"], m_rede, m_comp, m_strag
        }
        close(res_file)

        # Grava no CSV Resumo
        if (p in means) {
            speedup = t1_mc / means[p]
            eff = (speedup / p) * 100
            printf "%s,monte_carlo,%d,%d,%d,%.4f,%.4f,%.4f,%.2f,%.1f,%.4f,%.4f,%.4f\n",
                   tag, p, mc_samples, mc_reps, means[p], stds[p], ic95s[p], speedup, eff, m_rede, m_comp, m_strag >> resumo_csv
        }
    }

    # ----------------------------------------------------
    # 2. Processa Carga CPU-Bound (Matmul)
    # ----------------------------------------------------
    delete means
    delete stds
    delete ic95s
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
            ic95s[p] = (n > 1) ? 1.96 * stds[p] / sqrt(n) : 0
        }
    }
    
    t1_matmul = (1 in means) ? means[1] : means[plist[1]]
    printf "\n=== 2. Carga CPU-Bound: Multiplicação de Matrizes (N=%d, REPS=%d) ===\n", matmul_n, matmul_reps
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

    # 2.1 Decomposição Média de Tempos CPU-Bound (Rede, Comp, Straggler)
    printf "\n--- Decomposição Média de Tempos CPU-Bound (N=%d) ---\n", matmul_n
    printf "%-5s | %-12s | %-12s | %-12s | %-12s\n", "np", "T_Total (s)", "T_Rede (s)", "T_CompMax(s)", "Straggler(s)"
    print "------------------------------------------------------------------------"
    for (idx = 1; idx <= n_procs; idx++) {
        p = plist[idx]
        res_file = tmp "/matmul_resumo_np_" p ".txt"
        m_rede = 0; m_comp = 0; m_strag = 0
        if ((getline line < res_file) > 0) {
            split(line, fields, ",")
            delete kv
            for (f in fields) {
                split(fields[f], pair, "=")
                if (length(pair) == 2) kv[pair[1]] = pair[2]
            }
            m_rede = kv["media_rede"]
            m_comp = kv["media_comp_max"]
            m_strag = kv["media_straggler"]
            printf "%-5d | %10.4f s | %10.4f s | %10.4f s | %10.4f s\n",
                   p, kv["media_total"], m_rede, m_comp, m_strag
        }
        close(res_file)

        # Grava no CSV Resumo
        if (p in means) {
            speedup = t1_matmul / means[p]
            eff = (speedup / p) * 100
            printf "%s,cpu_bound,%d,%d,%d,%.4f,%.4f,%.4f,%.2f,%.1f,%.4f,%.4f,%.4f\n",
                   tag, p, matmul_n, matmul_reps, means[p], stds[p], ic95s[p], speedup, eff, m_rede, m_comp, m_strag >> resumo_csv
        }
    }
    
    # ----------------------------------------------------
    # 3. Processa Carga Network-Bound (Heat2D)
    # ----------------------------------------------------
    delete means
    delete stds
    delete ic95s
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
            ic95s[p] = (n > 1) ? 1.96 * stds[p] / sqrt(n) : 0
        }
    }
    
    t1_heat = (1 in means) ? means[1] : means[plist[1]]
    printf "\n=== 3. Carga Network-Bound: Difusão de Calor 2D (%dx%d, %d iter, REPS=%d) ===\n", heat_rows, heat_rows, heat_steps, heat_reps
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

    # 3.1 Decomposição Média de Tempos Network-Bound (Rede, Comp, Straggler)
    printf "\n--- Decomposição Média de Tempos Network-Bound (%dx%d) ---\n", heat_rows, heat_rows
    printf "%-5s | %-12s | %-12s | %-12s | %-12s\n", "np", "T_Total (s)", "T_Rede (s)", "T_CompMax(s)", "Straggler(s)"
    print "------------------------------------------------------------------------"
    for (idx = 1; idx <= n_procs; idx++) {
        p = plist[idx]
        res_file = tmp "/heat_resumo_np_" p ".txt"
        m_rede = 0; m_comp = 0; m_strag = 0
        if ((getline line < res_file) > 0) {
            split(line, fields, ",")
            delete kv
            for (f in fields) {
                split(fields[f], pair, "=")
                if (length(pair) == 2) kv[pair[1]] = pair[2]
            }
            m_rede = kv["media_rede"]
            m_comp = kv["media_comp_max"]
            m_strag = kv["media_straggler"]
            printf "%-5d | %10.4f s | %10.4f s | %10.4f s | %10.4f s\n",
                   p, kv["media_total"], m_rede, m_comp, m_strag
        }
        close(res_file)

        # Grava no CSV Resumo
        if (p in means) {
            speedup = t1_heat / means[p]
            eff = (speedup / p) * 100
            printf "%s,network_bound,%d,%d,%d,%.4f,%.4f,%.4f,%.2f,%.1f,%.4f,%.4f,%.4f\n",
                   tag, p, heat_rows, heat_reps, means[p], stds[p], ic95s[p], speedup, eff, m_rede, m_comp, m_strag >> resumo_csv
        }
    }
    print ""
}
'

echo "=========================================================="
echo " Bateria concluída com sucesso! Dados prontos para o TCC."
echo " Arquivo CSV de Amostras gerado em: $CSV_FILE"
echo " Arquivo CSV Resumo gerado em:      $RESUMO_CSV"
echo " Arquivo de Log textual salvo em:   $LOG_FILE"
echo "=========================================================="
