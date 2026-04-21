# 🚀 Terminal Web para Clusters

![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Kubernetes](https://img.shields.io/badge/kubernetes-%23326ce5.svg?style=for-the-badge&logo=kubernetes&logoColor=white)
![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white)
![MinIO](https://img.shields.io/badge/MinIO-C7202C?style=for-the-badge&logo=minio&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-black?style=for-the-badge&logo=socket.io&badgeColor=010101)

Uma aplicação web projetada para provisionar, sob demanda, ambientes de clusters distribuídos (Multi-Node) pré-configurados. Focada em cenários educacionais (como o ensino de MPI - Message Passing Interface), a plataforma utiliza **Kubernetes** para orquestrar contêineres dinamicamente, oferecendo a cada aluno um cluster privado, seguro e acessível diretamente pelo navegador, sem necessidade de instalações locais.

> 💡 **Veja em funcionamento:**
> 
> *[Sugestão: Grave um GIF de uns 15 segundos mostrando a tela inicial, escolhendo 3 nós, e abrindo o terminal. Substitua o link abaixo]*
> 
> ![Demonstração do Terminal Web](./docs/demo.gif)

## ✨ Principais Funcionalidades

- **Provisionamento Sob Demanda:** Criação de ambientes multi-node em segundos.
- **Isolamento e Segurança (RBAC):** Cada sessão gera recursos únicos no K8s e um par de chaves SSH efêmeras (geradas via `node-forge`), garantindo que apenas os nós de um mesmo cluster possam se comunicar.
- **Terminal Interativo em Tempo Real:** Acesso Shell direto ao nó mestre via WebSocket (`Xterm.js` + `Socket.IO`), com redimensionamento dinâmico.
- **Sistema de Backups em Nuvem (MinIO):** - Salve o progresso do cluster em arquivos `.tar.gz` diretamente em um bucket (S3 Compatible) via **Streams**, sem gargalar a memória do Node.js.
  - Navegação em árvore (Tree-view) do conteúdo do backup direto na UI.
  - Extração e download de arquivos ou pastas individuais on-the-fly.
  - **Auto-Save:** Backups automáticos ao encerramento da sessão por inatividade.
- **Gestão de Ciclo de Vida:** Limpeza automática de Pods, Services e Secrets ao término da sessão para otimização de recursos.
- **Integração LTI (Learning Tools Interoperability):** Autenticação transparente com plataformas LMS (como o Moodle), garantindo que apenas alunos matriculados tenham acesso.
- **Restauração de Sessão:** A sessão se mantém aberta por 2 horas (com opção de extensão), sobrevivendo a reloads da página, quedas de internet e até reinicializações do servidor Node.js (sincronização com as *Annotations* do K8s).

## 🛠️ Arquitetura e Stack Tecnológica

- **Front-end:** JS, HTML5, CSS3, Xterm.js.
- **Back-end:** Node.js, Express, Socket.IO.
- **Infraestrutura e Orquestração:** Kubernetes (via `@kubernetes/client-node`), Docker.
- **Storage:** MinIO (Object Storage S3-Compatible).
- **Banco de Dados (Auth LTI):** MongoDB.

---

## ⚙️ Variáveis de Ambiente (.env)

Para rodar este projeto, você precisará configurar um arquivo `.env` na raiz do diretório. Abaixo estão as variáveis utilizadas pela aplicação:

| Variável | Descrição | Exemplo |
| :--- | :--- | :--- |
| `NODE_ENV` | Define o ambiente (`development` ou `production`). No modo dev, a autenticação LTI é bypassada para testes. | `development` |
| `NGROK_AUTH` | Para conseguir testar na máquina local e o LTI precisa definir como `true` | `false` |
| `PORT` | Porta em que o servidor Node.js vai rodar. | `3000` |
| `DEFAULT_MPI_IMAGE` | Imagem Docker padrão usada para subir os nós do cluster. | `terminal-web:latest` |
| `K8S_NAMESPACE` | Namespace do Kubernetes onde os pods serão criados. | `default` |
| `SESSION_SECRET` | Chave de criptografia para a sessão do Express. | `sua-chave-secreta` |
| **Integração LTI (Moodle)** | *(Necessário apenas em `production`)* | |
| `MONGO_DB_URI` | URI de conexão com o MongoDB (usado pelo pacote `ltijs`). | `mongodb://localhost/ltidb` |
| `LTI_ENCRYPTION_KEY` | Chave para criptografia dos tokens LTI. | `chave-lti-secreta` |
| `LTI_PLATFORM_URL` | URL da plataforma LMS (Moodle). | `https://moodle.instituicao.edu` |
| `LTI_CLIENT_ID` | Client ID gerado pelo LMS. | `12345` |
| `LTI_AUTH_ENDPOINT` | Client ID gerado pelo LMS. | `https://moodle.instituicao.edu/auth.php` |
| `LTI_TOKEN_ENDPOINT` | Client ID gerado pelo LMS. | `https://moodle.instituicao.edu/token.php` |
| `LTI_KEYSET_ENDPOINT` | Client ID gerado pelo LMS. | `https://moodle.instituicao.edu/certs.php` |
| **Integração MinIO** | | |
| `MINIO_ENDPOINT` | URL ou IP do servidor MinIO. | `localhost` |
| `MINIO_PORT` | Porta da API do MinIO. | `9000` |
| `MINIO_ACCESS_KEY` | Chave de acesso do MinIO. | `minioadmin` |
| `MINIO_SECRET_KEY` | Chave secreta do MinIO. | `minioadmin` |

*(Você pode usar o arquivo `.env.example` do repositório como base).*

---

## 🚀 Rodando Localmente

### Pré-requisitos
- **Node.js** (v18 ou superior)
- **Docker Desktop** com o **Kubernetes** habilitado (`Settings > Kubernetes > Enable Kubernetes`).
- Uma instância rodando do **MinIO** e do **MongoDB** (você pode subir ambos rapidamente via `docker-compose` ou Helm).

### Passo a Passo

**1. Clone o projeto:**
```bash
git clone [https://github.com/PedroIvoKuhn/TerminalWeb](https://github.com/PedroIvoKuhn/TerminalWeb)
cd TerminalWeb
```

**2. Instale as dependências:**
```bash
npm install
```

**3. Configure as Variáveis de Ambiente:**
Crie um arquivo `.env` baseado na tabela acima.

**4. Construa a Imagem Docker Base:**
Esta imagem será utilizada para subir os nós virtuais (master e workers).
```bash
docker build -t terminal-web:latest -f Dockerfile .
```

**5. Aplique as Permissões no Kubernetes (RBAC):**
Isso garante que o nosso back-end tenha permissão para criar e destruir Pods.
```bash
kubectl apply -f rbac.yaml
```

**6. Inicie o Servidor (Modo Desenvolvimento):**
```bash
npm run dev
```

Acesse a aplicação abrindo seu navegador em [http://localhost:3000](http://localhost:3000).

---

## 🛡️ Preocupações com Segurança (AppSec)

Durante o desenvolvimento, diversas medidas de segurança foram implementadas:
- **Proteção contra Path Traversal e IDOR:** Caminhos de arquivos no MinIO são higienizados (`path.basename`) para evitar que usuários manipulem a URL e acessem backups de outros alunos.
- **Memory Leak Prevention:** Manipulação e extração de arquivos `.tar.gz` (`tar-stream`) utilizando cancelamento estrito de eventos (`destroy()`) para não pendurar conexões de WebSockets.
- **Teletype (TTY) Seguro:** Diferenciação de *streams* de texto puro e binários na comunicação com o Kubernetes para evitar corrupção de pacotes.

---