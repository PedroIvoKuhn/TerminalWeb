# TerminalWeb — Orquestração Híbrida com Cloud Bursting (BYOC)

![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Kubernetes](https://img.shields.io/badge/kubernetes-%23326ce5.svg?style=for-the-badge&logo=kubernetes&logoColor=white)
![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white)
![MinIO](https://img.shields.io/badge/MinIO-C7202C?style=for-the-badge&logo=minio&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-black?style=for-the-badge&logo=socket.io&badgeColor=010101)
![Tailscale](https://img.shields.io/badge/Tailscale-242424?style=for-the-badge&logo=tailscale&logoColor=white)
![AWS](https://img.shields.io/badge/AWS_EC2-FF9900?style=for-the-badge&logo=amazonaws&logoColor=white)
![Azure](https://img.shields.io/badge/Microsoft_Azure-0078D4?style=for-the-badge&logo=microsoftazure&logoColor=white)

Aplicação web educacional projetada para provisionar, sob demanda, clusters distribuídos pré-configurados em **Kubernetes (MicroK8s)** com suporte a **Cloud Bursting** baseado no modelo **Bring Your Own Cloud (BYOC)**. Voltada ao ensino prático de disciplinas como Processamento Paralelo e Distribuído (OpenMPI), a plataforma mantém o _Control Plane_ na infraestrutura local e expande dinamicamente o processamento (_Data Plane_) para instâncias **Amazon AWS (EC2)** ou **Microsoft Azure** fornecidas pelo próprio estudante, interligadas por uma rede privada virtual em malha (**Tailscale / WireGuard**).

---

## Principais Funcionalidades

- **Provisionamento Sob Demanda:** Criação de clusters virtuais multi-nó (`1 master` + `N workers`) em segundos diretamente no navegador.
- **Cloud Bursting Multicloud (BYOC):**
  - Monitoramento contínuo de saturação do cluster local via _Metrics Server_ (gatilho configurável em `CLUSTER_CONGESTION_THRESHOLD`, padrão 80%), com alerta em tempo real na interface.
  - Adaptadores desacoplados para **AWS** (`@aws-sdk/client-ec2` / `@aws-sdk/client-sts`) e **Microsoft Azure** (`@azure/arm-compute`, `@azure/arm-network`, `@azure/arm-resources`, `@azure/identity`).
  - _Bootstrapping_ autônomo via `UserData` / `CustomData`, configurando Tailscale VPN, `iptables-legacy`, MicroK8s (`--worker`), DNAT para `ClusterIP` (`10.152.183.1:443` e DNS `10.152.183.10:53`), pré-carregamento paralelo da imagem (`microk8s ctr`) e reconfiguração do `--node-ip` do Kubelet pós-_join_.
  - Reciclagem e limpeza estrita de recursos (incluindo exclusão em cascata de VM, NIC, disco e IP Público na Azure) + **Dead Man's Switch** (`burst-heartbeat-watchdog.sh`) para auto-terminação da VM se o nó _Master_ ficar inacessível.
  - Tutorial integrado passo a passo para obtenção de credenciais em `/tutorial-nuvem` (AWS IAM e Azure For Students / Entra ID).
- **Agendamento Seletivo e Isolamento Multi-Tenant:**
  - _Taints_, _Tolerations_ e _NodeAffinity_ para confinar _Pods_ remotos às VMs do respectivo usuário e impedir agendamento indevido por terceiros.
  - `NetworkPolicy` dinâmica por sessão (`job-id`) no Calico CNI e pares de chaves SSH efêmeras (`node-forge`) gerados por cluster.
- **Terminal Interativo em Tempo Real:** Acesso _shell_ direto ao nó `master` via WebSocket (`Xterm.js` + `Socket.IO`), com redimensionamento dinâmico e navegação rápida entre nós.
- **Sistema de Backups em Nuvem (MinIO):** Salvamento em `.tar.gz` via _Streams_, restauração sob demanda, controle de cota e _Auto-Save_ ao fim da sessão.
- **Integração LTI (Moodle) e Restauração de Sessão:** Autenticação via `ltijs` em produção (com _bypass_ automático em `development`) e sincronização de sessões via _Annotations_ do Kubernetes.

---

## Arquitetura e Stack Tecnológica

- **Front-end:** HTML5, CSS3, JavaScript, `Xterm.js`, `node-forge` (AES-256-GCM no navegador).
- **Back-end:** Node.js (v18+), Express, Socket.IO, `crypto` nativo (decifração _Just-in-Time_ AES-256-GCM), `dnsForwarderService` (UDP/TCP 5353 para CoreDNS via VPN).
- **Orquestração e Rede Híbrida:** MicroK8s v1.32 (`@kubernetes/client-node`), Calico CNI (VXLAN sobre WireGuard, MTU 1200), Tailscale Mesh VPN (UDP 41641 P2P).
- **Provedores de Nuvem:** Amazon Web Services (EC2 + STS) e Microsoft Azure (ARM Compute/Network/Resources + Entra ID).
- **Storage e Banco de Dados:** MinIO (S3-Compatible) e MongoDB (necessário para persistência LTI em `production`).

---

## Variáveis de Ambiente (`.env`)

Crie um arquivo `.env` na raiz do projeto utilizando [`.env.example`](.env.example) como modelo:

| Variável                                               | Descrição                                                                                                                                           | Exemplo                                            |
| :----------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------- |
| `NODE_ENV`                                             | Ambiente de execução (`development` ou `production`). Em `development`, a autenticação LTI é ignorada para facilitar testes locais.                 | `development`                                      |
| `NGROK_AUTH`                                           | Define `trust proxy` no Express para testes locais atrás de túnel HTTPS/LTI (`true` ou `false`).                                                    | `false`                                            |
| `PORT`                                                 | Porta HTTP do servidor Node.js.                                                                                                                     | `3000`                                             |
| `DEFAULT_MPI_IMAGE`                                    | Imagem Docker padrão dos nós virtuais. **Para Cloud Bursting, utilize uma imagem publicada em registro acessível pela internet (ex.: Docker Hub).** | `pedroivokuhn/terminal-web:dev`                    |
| `K8S_NAMESPACE`                                        | Namespace do Kubernetes onde os Pods e Services serão criados.                                                                                      | `terminal-web`                                     |
| `SESSION_SECRET`                                       | Chave secreta da sessão Express.                                                                                                                    | `sua-chave-secreta`                                |
| **Segurança e Cloud Bursting**                         |                                                                                                                                                     |                                                    |
| `BURST_ENCRYPTION_KEY`                                 | Chave utilizada para derivar (SHA-256) a chave AES-256-GCM que cifra credenciais BYOC em RAM no backend.                                            | `chave-32-bytes-segura`                            |
| `TAILSCALE_AUTH_KEY`                                   | Chave de autenticação do Tailscale (reutilizável/efêmera) injetada no _bootstrapping_ das VMs remotas.                                              | `tskey-auth-...`                                   |
| `CLUSTER_CONGESTION_THRESHOLD`                         | Percentual de alocação/uso local que dispara o alerta de alta demanda na UI (padrão: `80`).                                                         | `80`                                               |
| `LOCAL_CLUSTER_NODES`                                  | _(Opcional)_ Lista separada por vírgulas com hostnames locais elegíveis para agendamento.                                                           | `ubuntu10,ubuntu11`                                |
| `DNS_FORWARDER_PORT` / `COREDNS_HOST` / `COREDNS_PORT` | _(Opcional)_ Parâmetros do encaminhador DNS para nós remotos (padrões: `5353`, `10.152.183.10`, `53`).                                              | `5353`                                             |
| **Integração MinIO**                                   |                                                                                                                                                     |                                                    |
| `MINIO_ENDPOINT`                                       | Endereço IP ou hostname do servidor MinIO.                                                                                                          | `localhost`                                        |
| `MINIO_PORT`                                           | Porta da API do MinIO.                                                                                                                              | `9000`                                             |
| `MINIO_ACCESS_KEY`                                     | Chave de acesso do MinIO.                                                                                                                           | `minioadmin`                                       |
| `MINIO_SECRET_KEY`                                     | Chave secreta do MinIO.                                                                                                                             | `minioadmin`                                       |
| **Integração LTI (Moodle)**                            | _(Necessário apenas em `NODE_ENV=production`)_                                                                                                      |                                                    |
| `MONGO_DB_URI`                                         | URI de conexão com o MongoDB (usado pelo `ltijs`).                                                                                                  | `mongodb://localhost/ltidb`                        |
| `LTI_ENCRYPTION_KEY`                                   | Chave de criptografia dos tokens LTI.                                                                                                               | `chave-lti-secreta`                                |
| `LTI_PLATFORM_URL`                                     | URL base da plataforma LMS (Moodle).                                                                                                                | `https://moodle.instituicao.edu`                   |
| `LTI_PLATFORM_NAME`                                    | Nome identificador da plataforma LMS.                                                                                                               | `Moodle`                                           |
| `LTI_CLIENT_ID`                                        | Client ID gerado pelo LMS.                                                                                                                          | `12345`                                            |
| `LTI_AUTH_ENDPOINT`                                    | Endpoint de autorização OIDC do LMS.                                                                                                                | `https://moodle.instituicao.edu/mod/lti/auth.php`  |
| `LTI_TOKEN_ENDPOINT`                                   | Endpoint de troca de tokens OIDC do LMS.                                                                                                            | `https://moodle.instituicao.edu/mod/lti/token.php` |
| `LTI_KEYSET_ENDPOINT`                                  | Endpoint JWKS (chaves públicas) do LMS.                                                                                                             | `https://moodle.instituicao.edu/mod/lti/certs.php` |

---

## Como Reproduzir e Executar o Projeto

### 1. Clonar a branch `cloudBursting` e instalar dependências

```bash
git clone -b cloudBursting https://github.com/PedroIvoKuhn/TerminalWeb.git
cd TerminalWeb
npm install
cp .env.example .env
```

Ajuste o arquivo `.env` com suas configurações locais (para testes rápidos sem Moodle, mantenha `NODE_ENV="development"`).

---

### 2. Cenário A — Execução Local Básica (sem Cloud Bursting)

Ideal para validar rapidamente a interface, o terminal web (`Xterm.js`) e o provisionamento de contêineres MPI localmente:

**Pré-requisitos:**

- **Node.js** (v18 ou superior)
- Cluster **Kubernetes** local ativo (Docker Desktop com Kubernetes habilitado, Minikube ou MicroK8s)
- Instância **MinIO** acessível (para backups de sessão)

```bash
# 1. Construa a imagem Docker base dos laboratórios
docker build -t terminal-web:latest -f Dockerfile .

# 2. Crie o namespace (caso não exista) e aplique as permissões RBAC
kubectl create namespace terminal-web --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f rbac.yaml

# 3. Inicie a aplicação em modo desenvolvimento
npm run dev
```

Acesse [http://localhost:3000](http://localhost:3000) (e `/tutorial-nuvem` para visualizar o guia de credenciais).

---

### 3. Cenário B — Ambiente Híbrido Completo com Cloud Bursting (MicroK8s + Tailscale + AWS/Azure)

Para reproduzir a arquitetura híbrida completa descrita nos Capítulos 4, 5 e 6 do TCC:

**Pré-requisitos adicionais no nó Master (Linux/Ubuntu):**

- **MicroK8s** (testado na v1.32) com DNS e Metrics Server habilitados:
  ```bash
  sudo snap install microk8s --classic --channel=1.32/stable
  sudo microk8s enable dns metrics-server
  mkdir -p ~/.kube && microk8s config > ~/.kube/config
  ```
- **Tailscale** instalado e conectado no nó Master (`sudo tailscale up`), utilizando a mesma conta/tailnet da chave configurada em `TAILSCALE_AUTH_KEY` no `.env`.
- **Imagem Docker pública** para os nós remotos: defina `DEFAULT_MPI_IMAGE="pedroivokuhn/terminal-web:dev"` no `.env` (ou publique o build do [`Dockerfile`](Dockerfile) no seu próprio repositório do Docker Hub).

**Passo a passo de configuração da rede híbrida (Calico + Tailscale):**

```bash
# 1. No nó Master: configura kernel (ip_forward, rp_filter=2), MTU 1200 do Calico,
#    autodetecção na interface tailscale0, CoreDNS/MetricsServer e regras iptables
bash scripts/configure-hybrid-calico.sh --restart

# 2. (Opcional) Em nós trabalhadores físicos locais adicionais do cluster:
sudo bash scripts/setup-node-tailscale-calico.sh

# 3. (Opcional) Watchdog para auto-recuperação do daemon Tailscale nos nós do cluster
microk8s kubectl apply -f scripts/tailscale-watchdog-daemonset.yaml

# 4. Crie o namespace e aplique o RBAC no MicroK8s
microk8s kubectl create namespace terminal-web --dry-run=client -o yaml | microk8s kubectl apply -f -
microk8s kubectl apply -f rbac.yaml

# 5. Inicie o servidor (em modo desenvolvimento ou produção)
npm run dev
```

Com o servidor ativo, acesse [http://localhost:3000](http://localhost:3000), clique em **Conectar Nuvem** (ou **Tutorial de Credenciais** em `/tutorial-nuvem`) e informe credenciais válidas de **AWS IAM** ou **Azure Service Principal**. Certifique-se de que sua conta de nuvem possua cotas disponíveis na região escolhida.

---

## 📊 Reprodutibilidade dos Experimentos e Benchmarks (Capítulo 6)

Toda a suíte experimental utilizada na avaliação empírica do TCC encontra-se versionada no diretório [`benchmarks/`](benchmarks/), acompanhada do roteiro detalhado em [`benchmarks/README.md`](benchmarks/README.md):

- **Cargas de trabalho paralelas (C / OpenMPI):**
  - [`benchmarks/mpi_montecarlo.c`](benchmarks/mpi_montecarlo.c): Estimativa de $\pi$ por Monte Carlo (carga desacoplada / _Zero-Network_).
  - [`benchmarks/mpi_matmul.c`](benchmarks/mpi_matmul.c): Multiplicação de matrizes densas $N \times N$ com despacho multi-arquitetura (`avx` / `avx2,fma`) e decomposição de tempos (`MPI_Bcast`, `MPI_Scatter`, `MPI_Gather`).
  - [`benchmarks/mpi_heat2d.c`](benchmarks/mpi_heat2d.c): Simulação de difusão de calor 2D via método _stencil_ (`MPI_Sendrecv` síncrono).
- **Scripts de automação e estatística:**
  - [`benchmarks/run_benchmarks.sh`](benchmarks/run_benchmarks.sh): Bateria completa para cenários homogêneos (_Local Puro_ e _Nuvem Pura_).
  - [`benchmarks/run_benchmarks_hybrid.sh`](benchmarks/run_benchmarks_hybrid.sh): Bateria para o cenário _Híbrido_ ($np=2$ cruzando a WAN e $np=4$), além de scripts individuais (`run_montecarlo*.sh`, `run_matmul*.sh`, `run_heat2d*.sh`).
- **Qualidade de Experiência (QoE):**
  - [`benchmarks/keystroke_benchmark_browser.js`](benchmarks/keystroke_benchmark_browser.js): Medição da latência de eco de digitação diretamente no console do navegador sobre WebSockets.

Os scripts compilam automaticamente os binários, aplicam _tuning_ de buffers TCP para WAN (`4 MB` via MCA OpenMPI), executam _warm-up_ + repetições com pausas de _cooldown_ e exportam arquivos `.log` e `.csv` (amostras brutas e resumo estatístico com média, desvio padrão, IC 95%, _speedup_ e eficiência).

---

## Preocupações com Segurança

- **Custódia Efêmera de Credenciais BYOC:** Cifragem AES-256-GCM no cliente (`node-forge` em `sessionStorage`) e no backend (`cryptoService.js` nativo com decifração _Just-in-Time_ apenas durante chamadas de SDK e mascaramento em logs).
- **Isolamento Multi-Tenant:** _Taints_ (`NoSchedule`), _NodeAffinity_, chaves SSH efêmeras e `NetworkPolicy` por `job-id` no Calico CNI.
- **Proteção contra Command Injection:** Sanitização estrita de nomes de imagem e parâmetros injetados nos scripts `UserData` / `CustomData`.
- **Proteção contra Path Traversal e IDOR:** Higienização de caminhos no MinIO (`path.basename`) e validação de posse de sessão.
- **Resiliência Financeira (_Dead Man's Switch_):** Desligamento e destruição autônoma de instâncias remotas caso o plano de controle fique inacessível por 5 minutos, além de limpeza periódica de nós órfãos.
