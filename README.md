# Fase 1: Preparação do Ambiente do Servidor
(Estes comandos precisam ser executados apenas uma vez em um dos servidores do cluster)

1.1. Instalar o Docker Engine
O MicroK8s utiliza containerd, mas para construir nossas imagens a partir de um Dockerfile, a ferramenta docker build é a mais indicada.

```
# Atualiza o sistema e instala pré-requisitos
sudo apt-get update
sudo apt-get install -y ca-certificates curl

# Adiciona a chave GPG e o repositório oficial do Docker
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Instala o Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io

# (Recomendado) Adiciona seu usuário ao grupo do Docker para não precisar de 'sudo'
sudo usermod -aG docker $USER
```
Atenção: Após o último comando, saia da sessão SSH e conecte-se novamente para que a permissão tenha efeito.
1.2. Preparar o MicroK8s
Vamos habilitar o registro de imagens local do MicroK8s e configurar o Docker para confiar nele.

```
# Habilita o registro interno
sudo microk8s enable registry

# Cria ou edita o arquivo de configuração do Docker
sudo nano /etc/docker/daemon.json
```
Dentro do editor, cole o seguinte e salve (Ctrl+X, Y, Enter):

```
{
  "insecure-registries" : ["localhost:32000"]
}
```
```
# Reinicia o Docker para aplicar a nova configuração
sudo systemctl restart docker
```
O ambiente do seu servidor está pronto!

Fase 2: Preparação do Código do Projeto
Clone o repositório e entre no branch de produção:
```
git clone https://github.com/PedroIvoKuhn/webTerminal.git
cd webTerminal
git checkout prod
```
Crie e configure o arquivo .env:
Este arquivo conterá as configurações e segredos da sua aplicação. Crie o arquivo:
```
nano .env
```
Cole o seguinte conteúdo, substituindo pelos seus valores reais:
```
LTI_KEY="SUA_CHAVE_LTI_REAL"
LTI_SECRET="SEU_SEGREDO_LTI_REAL"
PORT=3000
DEFAULT_MPI_IMAGE="localhost:32000/mpi-node:latest"
```
Fase 3: Construção e Publicação das Imagens
Agora, vamos construir as duas imagens do projeto e enviá-las para o registro local do MicroK8s, tornando-as acessíveis para todos os nós do cluster.
```
echo "--- Construindo imagem dos nós MPI ---"
docker build -t localhost:32000/mpi-node:latest -f Dockerfile .
echo "--- Enviando imagem dos nós MPI para o registro ---"
docker push localhost:32000/mpi-node:latest
```
Imagem do Backend (baseada no Dockerfile.backend):
```
echo "--- Construindo imagem do backend ---"
docker build -t localhost:32000/terminal-web-backend:latest -f Dockerfile.backend .
echo "--- Enviando imagem do backend para o registro ---"
docker push localhost:32000/terminal-web-backend:latest
```
Fase 4: Deploy da Aplicação no Kubernetes
Com as imagens no lugar, vamos dizer ao Kubernetes para executar a aplicação.

Crie o Secret com as variáveis de ambiente:
```
sudo microk8s kubectl create secret generic terminal-web-secrets --from-env-file=.env
```
Aplique as Permissões (RBAC):
```
sudo microk8s kubectl apply -f rbac.yaml
```
Faça o Deploy do Backend:
```
sudo microk8s kubectl apply -f deployment.yaml
```
Fase 5: Acesso e Verificação
Verifique o status do Pod do backend:
```
# Espere alguns segundos e rode o comando
sudo microk8s kubectl get pods
```
Aguarde até que o pod terminal-web-backend-... mostre o status Running.

Encontre a porta de acesso (NodePort):
```
sudo microk8s kubectl get service terminal-web-service
```
A saída mostrará a porta mapeada. Exemplo: 3000:30000/TCP. O número que nos interessa é o 30000.

Acesse a Aplicação:
Abra seu navegador e acesse a URL usando o IP de qualquer um dos servidores do cluster e a porta encontrada no passo anterior.

http://<IP_DE_UM_DOS_SERVIDORES>:30000

Pronto! Sua aplicação está agora rodando de forma distribuída e profissional no seu cluster de laboratório.