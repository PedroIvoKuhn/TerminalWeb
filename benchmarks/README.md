# Guia Prático de Benchmarks do Capítulo 6 (TCC)
**Autor:** Pedro Ivo Kuhn  
**Tema:** Avaliação Experimental de Desempenho e QoE no TerminalWeb

---

## 1. Algoritmos e Métricas Avaliadas

### 1.1 `mpi_matmul.c` (Carga CPU-Bound)
* **Objetivo:** Avaliar a capacidade de aceleração (*speedup*) em tarefas com alta densidade de cálculo aritmético e baixa troca de mensagens.
* **Complexidade:** $O(N^3)$, com $N = 2800$ (matrizes quadradas de precisão dupla `double`).
* **Métricas:** Tempo de execução ($T_p$), *Speedup* ($S_p = T_1 / T_p$) e Eficiência Paralela ($E_p = S_p / p$).
* **Expectativa:** No cenário híbrido, o ganho de computação da nuvem deve compensar com folga o tráfego inicial, entregando aceleração expressiva (*speedup* quase linear).

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
  Ao efetuar um `ping` da sua máquina para o IP Tailscale do servidor, é possível subtrair esse $RTT$ do valor medido, obtendo exatamente o tempo puro de processamento interno do cluster/contêiner.

---

## 2. Matriz de Cenários e Número de Pods

A matriz experimental mantém simetria estrita com **1, 2 e 4 processos em todos os três cenários**, permitindo traçar curvas completas de *Makespan*, *Speedup* ($S_p = T_1 / T_p$) e Eficiência Paralela ($E_p = S_p / p$):

| Cenário | Processos ($np$) | Alocação de Pods no Cluster | Descrição da Topologia e Recursos |
| :--- | :---: | :--- | :--- |
| **Local Puro** | 1 | 1 Pod Local (`master`) | Linha de base (*baseline*) $T_1$ no laboratório |
| **Local Puro** | 2 | 2 Pods Locais (`master`, `worker-1`) | Comunicação interna Ethernet Gigabit local ($<0,25$~ms) |
| **Local Puro** | 4 | 4 Pods Locais (`master`, `worker-1`, `2`, `3`) | 4 máquinas físicas dedicadas da bancada |
| **Nuvem Pura** | 1 | 1 Pod Remoto na Nuvem | Execução em 1 vCPU virtualizada em nó remoto |
| **Nuvem Pura** | 2 | 2 Pods Remotos na Nuvem | 1 VM na nuvem (2 vCPUs dedicadas) |
| **Nuvem Pura** | 4 | 4 Pods Remotos na Nuvem | 2 VMs concorrentes na nuvem (2 VMs $\times$ 2 vCPUs = 4 vCPUs) |
| **Híbrido (*Bursting*)** | 1 | 1 Pod Local (`master`) | Linha de base do cluster híbrido ($T_1$) |
| **Híbrido (*Bursting*)** | 2 | 1 Pod Local (`master`) + 1 Pod Nuvem (`worker-1`) | **50% Local / 50% Nuvem** via Tailscale Mesh VPN |
| **Híbrido (*Bursting*)** | 4 | 2 Pods Locais + 2 Pods Nuvem (ou 1 local + 3 nuvem) | Particionamento distribuído através da rota WAN |

---

## 3. Metodologia Estatística (5 Repetições por Teste)

Para mitigar variações decorrentes do escalonador do sistema operacional ou flutuações momentâneas no enlace de internet, cada combinação de cenário e número de processos é executada **5 vezes consecutivas ($N=5$)**.

O script `run_benchmarks.sh` automatiza esse procedimento:
* Executa 5 vezes para $np=1$
* Executa 5 vezes para $np=2$
* Executa 5 vezes para $np=4$

A partir dos 5 tempos obtidos, calculam-se a **Média Amostral ($\mu$)** e o **Desvio Padrão ($\sigma$)**:
$$\mu = \frac{1}{N}\sum_{i=1}^N T_i \qquad \sigma = \sqrt{\frac{1}{N-1}\sum_{i=1}^N (T_i - \mu)^2}$$

Os valores consolidados no formato $\mu \pm \sigma$ serão transcritos diretamente para as tabelas do TCC.

---

## 4. Passo a Passo de Execução

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
```

*(Alternativamente, você pode abrir o editor integrado do TerminalWeb no navegador e colar o código de cada arquivo).*

### Passo 3: Executar a Bateria MPI
Dentro do terminal web do aluno (ou via `microk8s kubectl exec`):

```bash
# Permissão de execução
chmod +x run_benchmarks.sh

# Se estiver testando no Pod Master isolado (np=1):
./run_benchmarks.sh

# Se estiver em 2 pods (master e worker-1):
./run_benchmarks.sh "master,worker-1"

# Se estiver em 4 pods:
./run_benchmarks.sh "master,worker-1,worker-2,worker-3"
```

### Passo 4: Executar o Teste de QoE (Latência do Terminal)
1. Com a aba do TerminalWeb aberta e conectado na sessão (Local ou Nuvem):
2. Pressione **F12** para abrir o Console do Desenvolvedor do navegador.
3. Cole o código de [`benchmarks/keystroke_benchmark_browser.js`](keystroke_benchmark_browser.js) e dê **Enter**.
4. O script enviará 50 toques via WebSocket e imprimirá no console a tabela com: Média, Mínima, P95 e Máxima.

