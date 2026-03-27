
# Terminal Web para Clusters

Uma aplicação web que provisiona, sob demanda, ambientes já pré-configurados com uma ou múltiplas máquinas.(A versão principal está funciona com o ambiente de MPI). A solução utiliza Kubernetes para orquestrar contêineres dinamicamente, oferecendo a cada usuário um cluster privado e isolado, acessível diretamente pelo navegador.


## Funcionalidades

- **Provisionamento Sob demanda:** Crie ambientes de múltiplos nós em segundos.
- **Configuração pelo Usuário:** Especifique o número de máquinas virtuais necessárias para cada sessão.
- **Terminal Web Interativo:** Acesso shell completo a um nó mestre diretamente no navegador.
- **Isolamento de Sessão:** Cada sessão de usuário cria recursos Kubernetes com nomes únicos, garantindo o isolamento.
- **Segurança:** Um par de chaves SSH novo e exclusivo é gerado para cada sessão, garantindo que apenas os nós de um mesmo ambiente possam se comunicar.
- **Acesso Simplificado:** Conectividade SSH pré-configurada entre os nós do ambiente, com apelidos simples como master e worker-1.
- **Limpeza Automática:** Todos os recursos criados no Kubernetes são automaticamente removidos ao final da sessão, evitando o desperdício de recursos.
- **Restauração de sessão:** Mesmo se sair da página, seja por ter fechado sem querer a aba ou tenha ocilado sua internet, ou até mesmo, o servidor reiniciado a sessão se mantem aberta por 2 horas, podendo estender 1 hora toda vez que faltar 20 minutos para encerrar a sessão.
- **Troca de Ambiente:** Faz o download automaticamente do Docker Hub, basta trocar o nome da imagem, e a imagem ter a iso base do linux(para a config do SSH).


## Stack utilizada

- **Front-end:** HTML5, CSS3, JavaScript, Xterm.js;

- **Back-end:** Node.js, Express.js, Socket.IO, node-forge;

- **Infraestrutura:** Kubernetes, Docker;

## Rodando localmente

**Pré-requisitos**
- Node.js (versão 18 ou superior)
- Docker Desktop
  - Certifique-se de que o Kubernetes esteja habilitado nas configurações do Docker Desktop (`Settings > Kubernetes > Enable Kubernetes`).

Clone o projeto

```
  git clone https://github.com/PedroIvoKuhn/webTerminal
```

Entre no diretório do projeto

```
  cd webTerminal
```

Instale as Dependências

```
  npm install
```

Construa a Imagem Docker

```
  docker build -t terminal-web:latest -f Dockerfile .
```

Aplique as Permissões no Kubernetes

```
  kubectl apply -f rbac.yaml
```

Inicie o Servidor

```
  npm run dev
```

Acesse a Aplicação
Abra seu navegador e acesse http://localhost:3000.
