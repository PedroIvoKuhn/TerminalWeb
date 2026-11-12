# Guia Prático de Benchmarks do Capítulo 6 (TCC)
**Autor:** Pedro Ivo Kuhn  
**Tema:** Avaliação Experimental de Desempenho e QoE no TerminalWeb

---

## 1. Algoritmos e Métricas Avaliadas

### 1.1 `mpi_matmul.c` (Carga CPU-Bound com Decomposição de Tempos)
* **Objetivo:** Avaliar a capacidade de aceleração (*speedup*) em tarefas com alta densidade de cálculo aritmético e investigar detalhadamente o custo de trânsito em rede WAN versus o efeito de nós lentos (*stragglers*).
* **Dimensão Padrão:** $N = 4800$ (matrizes quadradas de precisão dupla `double`, decomposição 1D por linhas $i \rightarrow k \rightarrow j$).
* **Rigor Estatístico:** $30$ repetições consecutivas cronometradas precedidas por $1$ iteração de *warm-up* (para aquecimento de janelas TCP WireGuard e caches L1-L3/TLB).
* **Otimização de Memória (`MPI_IN_PLACE`):**
  - No Master (`rank == 0`), alocam-se exclusivamente as matrizes completas $A$, $B$ e $C$ (~$553$~MB no total para $N=4800$), respeitando o teto de $1,5$~GB do Pod Kubernetes. Não há buffers duplicados `sub_A` nem `sub_C`.
  - No `MPI_Scatter`, o Rank 0 utiliza `MPI_IN_PLACE` como buffer de recepção, lendo sua fatia diretamente do cabeçalho de $A$.
  - No `MPI_Gather`, o Rank 0 utiliza `MPI_IN_PLACE` como buffer de envio, recebendo o resultado dos trabalhadores diretamente em $C$.
  - Nos trabalhadores (`rank > 0`), alocam-se apenas $B$ completa, `sub_A` e `sub_C` fatiadas ($N \times \frac{N}{p}$).
* **Decomposição Granular de Tempos:**
  Em cada iteração, medem-se isoladamente via `MPI_Wtime` e `MPI_Reduce`:
  1. $t_{\text{bcast}}$: Transmissão da matriz $B$ completa via `MPI_Bcast` (precedida por barreira de sincronização).
  2. $t_{\text{scatter}}$: Distribuição das fatias de $A$ via `MPI_Scatter`.
  3. $t_{\text{comp\_local}}$: Execução do laço $i \rightarrow k \rightarrow j$ (buffer zerado com `memset` antes da cronometragem).
  4. $t_{\text{straggler\_wait}}$: Barreira `MPI_Barrier` pós-computação para quantificar a espera pelo nó mais lento (*straggler effect* entre nós locais e remotos).
  5. $t_{\text{gather}}$: Coleta das fatias computadas em $C$ via `MPI_Gather`.
  6. $t_{\text{rede}} = t_{\text{bcast}} + t_{\text{scatter}} + t_{\text{gather}}$.
  7. $t_{\text{total}}$: Ciclo global da repetição (do marco zero pré-Bcast até a conclusão do Gather).
* **Logs Emitidos pelo Rank 0:**
  - Amostra individual:
    `AMOSTRA_CPU_BOUND,iter=%d,np=%d,N=%d,t_total=%.4f,t_rede=%.4f,t_bcast=%.4f,t_scatter=%.4f,t_gather=%.4f,t_comp_max=%.4f,t_comp_min=%.4f,t_straggler_wait=%.4f`
  - Resumo estatístico final:
    `RESUMO_ESTATISTICO,np=%d,N=%d,reps=%d,media_total=%.4f,sd_total=%.4f,ic95_total=%.4f,media_rede=%.4f,sd_rede=%.4f,media_comp_max=%.4f,sd_comp_max=%.4f,media_straggler=%.4f`

### 1.2 `mpi_heat2d.c` (Carga Network-Bound / Stencil)
* **Objetivo:** Investigar a fronteira técnica do *cloud bursting* em tarefas iterativas com sincronização contínua e sensível à latência da rede de longa distância (WAN).
* **Parâmetros:** Grade $2000 \times 2000$ pontos, $800$ iterações temporais.
* **Mecânica:** A cada passo no tempo, ocorre uma troca de linhas de contorno (*Halo Exchange*) via `MPI_Sendrecv` entre processos vizinhos.
* **Expectativa:** Demonstrar o impacto cumulativo do RTT da VPN Tailscale ($22,3$~ms na AWS e $77,5$~ms na Azure), evidenciando a Lei de Amdahl em sistemas geograficamente distribuídos.

### 1.3 `keystroke_benchmark_browser.js` (Qualidade de Experiência - QoE)
* **Objetivo:** Medir a latência percebida pelo aluno ao digitar no terminal interativo (Xterm.js via WebSockets).
* **Parâmetros:** 50 caracteres (Enter) enviados sequencialmente com intervalo de 80~ms.
* **Métrica:** Média, P95 e Máxima da latência de eco (*round-trip* da tecla até o caractere refletido).
* **Decomposição Metodológica (WAN vs. Processamento):**
  $$T_{\text{terminal}} = RTT_{\text{rede WAN (Tailscale)}} + T_{\text{processamento (WebSocket + Node.js + K8s PTY)}}$$

---

## 2. Compilação Multi-Arquitetura e Tuning TCP (BDP)

### 2.1 Compilação Otimizada Multi-Arquitetura
Para garantir que o binário gerado no nó master execute com vetorização máxima sem sofrer falhas de instrução ilegal (`SIGILL` - sinal 4) quando distribuído entre processadores heterogêneos:
- **Intel Core i7-2600 (Sandy Bridge local):** Suporta extensões AVX (256-bit FP).
- **Intel Xeon Sapphire Rapids (AWS) e AMD EPYC (Azure):** Suportam AVX2 e FMA3 (`vfmadd231pd`).

O código do `mpi_matmul.c` emprega despacho dinâmico via GNU IFUNC com `__attribute__((target_clones("default", "avx", "avx2,fma")))`. O script de compilação detecta a CPU local e aplica:
```bash
# Compilação compatível com a heterogeneidade do cluster
mpicc -O3 -mavx2 -mfma -funroll-loops mpi_matmul.c -o mpi_matmul -lm
```
*(Caso compilado localmente no i7-2600 Sandy Bridge, o script utiliza `-mavx` como baseline de flags e ativa os clones de runtime para os nós remotos).*

### 2.2 Tuning de Bandwidth-Delay Product (BDP) para WAN
Em redes de longa distância com largura de banda de ~$300$~Mbps e RTT entre $22$~ms (AWS) e $78$~ms (Azure), o tamanho ideal do buffer TCP (BDP) é:
$$\text{BDP} = 37,5\text{ MB/s} \times 0,078\text{ s} \approx 2,93\text{ MB}$$

Para evitar o estrangulamento da janela de congestionamento TCP pelo OpenMPI, os scripts `run_benchmarks.sh` e `run_benchmarks_hybrid.sh` configuram buffers de $4\text{ MB}$ ($4.194.304$ bytes):
```bash
--mca btl_tcp_sndbuf 4194304 --mca btl_tcp_rcvbuf 4194304
```
Além de persistirem esses parâmetros em `$HOME/.openmpi/mca-params.conf` replicado para todos os nós remotos via SCP.

---

## 3. Matriz de Cenários e Número de Pods

A matriz experimental mantém simetria estrita com **1, 2 e 4 processos em todos os três cenários**:

| Cenário | Processos ($np$) | Alocação de Pods no Cluster | Descrição da Topologia e Recursos |
| :--- | :---: | :--- | :--- |
| **Local Puro** | 1 | 1 Pod Local (`master`) | Linha de base (*baseline*) $T_1$ no laboratório |
| **Local Puro** | 2 | 2 Pods Locais (`master`, `worker-1`) | Comunicação interna Ethernet Gigabit local ($<0,25$~ms) |
| **Local Puro** | 4 | 4 Pods Locais (`master`, `worker-1`, `2`, `3`) | 4 máquinas físicas dedicadas da bancada |
| **Nuvem Pura** | 1 | 1 Pod Remoto na Nuvem | Execução em 1 vCPU virtualizada em nó remoto |
| **Nuvem Pura** | 2 | 2 Pods Remotos na Nuvem | 1 VM na nuvem (2 vCPUs dedicadas) |
| **Nuvem Pura** | 4 | 4 Pods Remotos na Nuvem | 2 VMs concorrentes na nuvem (2 VMs $\times$ 2 vCPUs = 4 vCPUs) |
| **Híbrido (*Bursting*)** | 1 | 1 Pod Local (`master`) | Linha de base do cluster híbrido ($T_1$) |
| **Híbrido (*Bursting*)** | 2 | 1 Pod Local (`master`) + 1 Pod Nuvem (`worker-2`) | **50% Local / 50% Nuvem** via Tailscale Mesh VPN |
| **Híbrido (*Bursting*)** | 4 | 2 Pods Locais + 2 Pods Nuvem | Particionamento distribuído através da rota WAN |

---

## 4. Metodologia Estatística, Cooldown e Exportação para Google Planilhas

### 4.1 Rigor Estatístico (30 Repetições e IC 95%)
Para a bateria final do TCC, adotam-se **30 repetições ($N=30$)** para o benchmark CPU-Bound e 5 repetições para o benchmark Network-Bound. A partir das amostras cronometradas, calculam-se a **Média Amostral ($\mu$)**, o **Desvio Padrão Amostral ($\sigma$)** e o **Intervalo de Confiança de 95%**:
$$\mu = \frac{1}{N}\sum_{i=1}^N T_i \qquad \sigma = \sqrt{\frac{1}{N-1}\sum_{i=1}^N (T_i - \mu)^2} \qquad \text{IC}_{95\%} = 1.96 \times \frac{\sigma}{\sqrt{N}}$$

### 4.2 Cooldown Anti-Throttling Térmico e de Créditos de CPU
A execução de 30 repetições contínuas de multiplicação de matrizes de ordem $4800 \times 4800$ impõe 100% de ocupação contínua da FPU/ALU. Por esse motivo, os scripts inserem automaticamente uma **pausa de resfriamento (*cooldown*) de 5 a 8 segundos** entre as configurações:
1. **Em nós locais físicos (Core i7-2600):** Evita o acionamento do *Thermal Throttling* (mecanismo PROCHOT da CPU ao ultrapassar ~72°C), que derruba a frequência de Turbo Boost de 3.8 GHz para 3.4 GHz ou menos, inflando artificialmente o desvio padrão das últimas repetições.
2. **Em nós de nuvem (instâncias Burstable AWS T3/Azure B-series):** O consumo a 100% queima créditos de rajada (*CPU Credit Balance*). A pausa alivia a taxa de exaustão e reduz o risco do hipervisor ceifar a cota da vCPU para a linha de base (20–40%).
3. **No enlace de rede Tailscale:** Permite o término e drenagem de conexões TCP em estado `TIME_WAIT` antes do início do próximo ensaio.

### 4.3 Exportação Automática de Logs e CSVs para o Google Planilhas
Ao executar qualquer script, é solicitado um identificador do teste (ex: `local_puro`, `nuvem_aws`, `hibrido_azure`). Três arquivos são gerados automaticamente na pasta `benchmarks/resultados/`:
1. `resultados/<TAG>_amostras.csv`: Todas as amostras individuais (30 repetições de CPU e repetições de rede) com colunas delimitadas por vírgula (`cenario,carga,iteracao,np,N,t_total,t_rede,t_bcast,t_scatter,t_gather,t_comp_max,t_comp_min,t_straggler_wait`). **Pronto para "Arquivo > Importar" no Google Planilhas**.
2. `resultados/<TAG>_resumo.csv`: Tabela consolidada com Médias, Desvios Padrões, IC 95%, Speedup, Eficiência e Decomposição de Tempos.
3. `resultados/<TAG>_execucao.log`: Registro textual completo idêntico à saída do terminal.

---

## 5. Passo a Passo de Execução

### Passo 1: Abrir a Sessão Desejada no TerminalWeb
1. Acesse `http://localhost:3000` (ou o domínio do laboratório).
2. Para o teste **Local Puro**:
   - Deixe o Bursting desconectado.
   - Selecione a imagem `pedroivokuhn/terminal-web:dev`.
   - Escolha o número de máquinas (1, 2 ou 4) e clique em **Iniciar Terminal**.
3. Para o teste **Nuvem Pura**:
   - Conecte o Cloud Bursting solicitando 1 VM (para 1 ou 2 pods) ou 2 VMs (para 4 pods).
   - Defina 0 máquinas locais e 1, 2 ou 4 máquinas remotas.
   - Inicie a sessão.
4. Para o teste **Híbrido**:
   - Conecte o Cloud Bursting (AWS ou Azure).
   - Defina a divisão híbrida: ex: 1 local + 1 nuvem (para 2 pods) ou 2 locais + 2 nuvem (para 4 pods).
   - Inicie a sessão.

### Passo 2: Copiar os Códigos para o Pod Master
Na máquina servidora (onde roda o Kubernetes), transfira os arquivos com o comando `kubectl cp`:

```bash
# 1. Identifique o pod master ativo
microk8s kubectl get pods -n terminal-web

# 2. Copie os arquivos da pasta benchmarks para o diretório de trabalho do aluno
microk8s kubectl cp benchmarks/mpi_matmul.c terminal-web/<POD_MASTER>:/home/aluno/mpi_matmul.c
microk8s kubectl cp benchmarks/mpi_heat2d.c terminal-web/<POD_MASTER>:/home/aluno/mpi_heat2d.c
microk8s kubectl cp benchmarks/run_benchmarks.sh terminal-web/<POD_MASTER>:/home/aluno/run_benchmarks.sh
microk8s kubectl cp benchmarks/run_benchmarks_hybrid.sh terminal-web/<POD_MASTER>:/home/aluno/run_benchmarks_hybrid.sh
```

### Passo 3: Executar a Bateria MPI

Dentro do terminal web do aluno (ou via `microk8s kubectl exec`):

#### A) Para Cenários Homogêneos (Local Puro ou Nuvem Pura):
Utilize o script sequencial padrão `run_benchmarks.sh` (avalia $np = 1, 2, 4$):
```bash
chmod +x run_benchmarks.sh

# Se estiver testando no Pod Master isolado (np=1):
./run_benchmarks.sh

# Se estiver em 2 pods (master e worker-1):
./run_benchmarks.sh "master,worker-1"

# Se estiver em 4 pods (master, worker-1, worker-2, worker-3):
./run_benchmarks.sh "master,worker-1,worker-2,worker-3"
```
*(Ao iniciar, digite uma etiqueta como `local_puro` ou `nuvem_aws` para rotular os arquivos CSV gerados).*

#### B) Para o Cenário Híbrido (Local + Nuvem):
Utilize o script especializado `run_benchmarks_hybrid.sh`. Ele avalia diretamente **$np = 2$ e $np = 4$** (poupando os ~10 minutos que seriam gastos re-executando $np=1$ no nó local):
```bash
chmod +x run_benchmarks_hybrid.sh

# Executa np=2 (1 Local + 1 Nuvem) e np=4 (2 Locais + 2 Nuvem):
./run_benchmarks_hybrid.sh "master,worker-1,worker-2,worker-3"
```
*(O script solicitará o tempo $T_1$ obtido no ensaio Local Puro. Ao fornecê-lo, ele calcula o **Speedup Híbrido Real** $S_p = T_1^{\text{local}} / T_p^{\text{híbrido}}$ e a Eficiência).*

#### C) Importar os Resultados no Google Planilhas:
1. Ao final dos testes, acesse o editor do TerminalWeb ou baixe o arquivo de resultados do pod:
   `microk8s kubectl cp terminal-web/<POD_MASTER>:/home/aluno/resultados/ .`
2. No **Google Planilhas**, vá em **Arquivo > Importar > Fazer Upload** e selecione o arquivo `<TAG>_amostras.csv`.
3. Selecione "Separador por vírgula". Todas as 30 repetições e tempos decompostos estarão organizados em colunas para a confecção imediata de gráficos e tabelas do TCC.

### Passo 4: Executar o Teste de QoE (Latência do Terminal)
1. Com a aba do TerminalWeb aberta e conectado na sessão (Local ou Nuvem):
2. Pressione **F12** para abrir o Console do Desenvolvedor do navegador.
3. Cole o código de [`benchmarks/keystroke_benchmark_browser.js`](keystroke_benchmark_browser.js) e dê **Enter**.
4. O script enviará 50 toques via WebSocket e imprimirá no console a tabela com: Média, Mínima, P95 e Máxima.
