#!/usr/bin/env bash
# ==============================================================================
# Script de Execução Automatizada: Monte Carlo (Zero-Network / Pura CPU)
# Carga: Estimativa de Pi por Monte Carlo (N=2.500.000.000)
# ==============================================================================

export OMPI_MCA_plm_rsh_args="-o LogLevel=ERROR -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
export OMPI_MCA_btl_tcp_if_include="eth0"
export OMPI_MCA_oob_tcp_if_include="eth0"
export OMPI_MCA_mpi_yield_when_idle="1"
export OMPI_MCA_btl_tcp_sndbuf="4194304"
export OMPI_MCA_btl_tcp_rcvbuf="4194304"

mkdir -p "${HOME:-/home/aluno}/.openmpi" 2>/dev/null || true
cat << 'EOF' > "${HOME:-/home/aluno}/.openmpi/mca-params.conf" 2>/dev/null || true
btl_tcp_if_include = eth0
oob_tcp_if_include = eth0
mpi_yield_when_idle = 1
btl_tcp_sndbuf = 4194304
btl_tcp_rcvbuf = 4194304
EOF

RESULTS_DIR="${RESULTS_DIR:-$(pwd)/resultados}"
mkdir -p "$RESULTS_DIR"

if [ -z "$BENCH_TAG" ]; then
    DEFAULT_TAG="montecarlo_$(date +%Y%m%d_%H%M%S)"
    if [ -t 0 ]; then
        echo "=========================================================="
        echo "      CONFIGURAÇÃO DO ENSAIO: MONTE CARLO (CPU PURA)      "
        echo "=========================================================="
        read -r -p "Identificador deste ensaio (ex: local_montecarlo, azure_montecarlo) [padrão: $DEFAULT_TAG]: " USER_INPUT
        BENCH_TAG="${USER_INPUT:-$DEFAULT_TAG}"
    else
        BENCH_TAG="$DEFAULT_TAG"
    fi
fi
BENCH_TAG=$(echo -n "$BENCH_TAG" | tr -c '[:alnum:]_-' '_' | sed 's/_$//')

LOG_FILE="$RESULTS_DIR/${BENCH_TAG}_execucao.log"
CSV_FILE="$RESULTS_DIR/${BENCH_TAG}_amostras.csv"
RESUMO_CSV="$RESULTS_DIR/${BENCH_TAG}_resumo.csv"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "=========================================================="
echo "    BATERIA DE TESTES MPI: MONTE CARLO (ZERO-NETWORK)     "
echo "=========================================================="
echo "Identificador do Ensaio: $BENCH_TAG"
echo "Log completo da execução: $LOG_FILE"
echo "Amostras para Google Planilhas: $CSV_FILE"
echo "Resumo consolidado: $RESUMO_CSV"
echo "=========================================================="
echo ""

echo "cenario,carga,iteracao,np,N,t_total,t_rede,t_bcast,t_scatter,t_gather,t_comp_max,t_comp_min,t_straggler_wait" > "$CSV_FILE"

MC_SAMPLES="${MC_SAMPLES:-2500000000}"
MC_REPS="${MC_REPS:-20}"
COOLDOWN_SECS="${COOLDOWN_SECS:-5}"

TMP_DIR=$(mktemp -d /tmp/mpi_montecarlo_XXXXXX)
trap "rm -rf $TMP_DIR" EXIT

cooldown() {
    local secs="${1:-$COOLDOWN_SECS}"
    if [ "$secs" -gt 0 ]; then
        echo "-> [Cooldown] Pausa de ${secs}s para resfriamento térmico e alívio de créditos de CPU..."
        sleep "$secs"
    fi
}

echo "[1/2] Compilando algoritmo Monte Carlo..."
mpicc -O3 -Wall mpi_montecarlo.c -o mpi_montecarlo -lm
echo "-> Binário gerado com sucesso (mpi_montecarlo)."
echo ""

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
    echo "Sincronizando binário e configuração MCA com os nós remotos via SSH..."
    IFS=',' read -ra ADDR <<< "$TARGET_HOSTS"
    for host in "${ADDR[@]}"; do
        clean_host=$(echo "$host" | cut -d: -f1 | tr -d ' ')
        if [ "$clean_host" != "master" ] && [ "$clean_host" != "localhost" ] && [ -n "$clean_host" ]; then
            echo "-> Enviando para $clean_host..."
            ssh -q -o LogLevel=ERROR -o StrictHostKeyChecking=no "$clean_host" "mkdir -p /home/aluno/.openmpi" 2>/dev/null || true
            scp -q -o LogLevel=ERROR -o StrictHostKeyChecking=no "$HOME/.openmpi/mca-params.conf" "$clean_host:/home/aluno/.openmpi/mca-params.conf" 2>/dev/null || true
            scp -q -o LogLevel=ERROR -o StrictHostKeyChecking=no mpi_montecarlo "$clean_host:/home/aluno/" || echo "Aviso: Falha ao copiar para $clean_host."
        fi
    done
    echo "-> Sincronização concluída com sucesso."
    echo ""
else
    echo "Aviso: Nenhum host especificado ou detectado. Executando localmente no Pod mestre."
fi

if [ -n "$2" ]; then
    PROCESS_LIST="$2"
else
    PROCESS_LIST="1 2 4"
fi
echo "Processos a avaliar (np): $PROCESS_LIST"
echo ""

echo "=========================================================="
echo " [2/2] Executando Carga Zero-Network (mpi_montecarlo N=$MC_SAMPLES, REPS=$MC_REPS)"
echo "=========================================================="

for np in $PROCESS_LIST; do
    echo "--- Testando Monte Carlo com np=$np ($MC_REPS repetições internas + warm-up) ---"
    
    while IFS= read -r line; do
        echo "$line"
        if [[ "$line" == AMOSTRA_MONTECARLO* ]]; then
            SEC=$(echo "$line" | sed -n 's/.*t_total=\([0-9.]*\).*/\1/p')
            if [ -n "$SEC" ]; then
                echo "$SEC" >> "$TMP_DIR/mc_np_${np}.txt"
            fi
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
             $HOSTS_PARAM -np $np ./mpi_montecarlo $MC_SAMPLES $MC_REPS 2>/dev/null)
    
    cooldown "$COOLDOWN_SECS"
done

echo "=========================================================="
echo "             CONSOLIDAÇÃO ESTATÍSTICA (TCC)               "
echo "=========================================================="

echo "cenario,carga,np,dimensao_N,repeticoes,tempo_medio_s,desvio_padrao_s,ic95_s,speedup,eficiencia_pct,media_rede_s,media_comp_max_s,media_straggler_s" > "$RESUMO_CSV"

awk -v tmp="$TMP_DIR" \
    -v procs="$PROCESS_LIST" \
    -v mc_samples="$MC_SAMPLES" \
    -v mc_reps="$MC_REPS" \
    -v resumo_csv="$RESUMO_CSV" \
    -v tag="$BENCH_TAG" '
BEGIN {
    n_procs = split(procs, plist, " ")
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
    printf "\n=== Carga Zero-Network: Simulação de Monte Carlo (N=%d, REPS=%d) ===\n", mc_samples, mc_reps
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

        if (p in means) {
            speedup = t1_mc / means[p]
            eff = (speedup / p) * 100
            printf "%s,monte_carlo,%d,%d,%d,%.4f,%.4f,%.4f,%.2f,%.1f,%.4f,%.4f,%.4f\n",
                   tag, p, mc_samples, mc_reps, means[p], stds[p], ic95s[p], speedup, eff, m_rede, m_comp, m_strag >> resumo_csv
        }
    }
    print ""
}
'

echo "=========================================================="
echo " Ensaio de Monte Carlo concluído com sucesso!"
echo " Arquivo CSV de Amostras gerado em: $CSV_FILE"
echo " Arquivo CSV Resumo gerado em:      $RESUMO_CSV"
echo " Arquivo de Log textual salvo em:   $LOG_FILE"
echo "=========================================================="
