# 📌 Lembrete: Ajuste de Label no repositório ConfigCluster

> **Arquivo a ser alterado no ConfigCluster:**  
> `apps/terminalWeb/network-policy.yaml`  
> (Repositório: [https://github.com/lups-ufpel/ConfigCluster](https://github.com/lups-ufpel/ConfigCluster) ou localmente em `/home/pedro/ConfigCluster/apps/terminalWeb/network-policy.yaml`)

---

### O que precisa ser alterado?

No manifesto `apps/terminalWeb/network-policy.yaml`, trocar o seletor **`mpi-job-id`** por **`job-id`** para alinhar com o código atual do `TerminalWeb`.

#### 🔴 Como está atualmente:
```yaml
spec:
  podSelector:
    matchLabels:
      mpi-job-id: ""
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              mpi-job-id: ""
        - podSelector:
            matchLabels:
              app: terminal-web-backend
  egress:
    - to:
        - podSelector:
            matchLabels:
              mpi-job-id: ""
```

#### 🟢 Como deve ficar:
```yaml
spec:
  podSelector:
    matchLabels:
      job-id: ""
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              job-id: ""
        - podSelector:
            matchLabels:
              app: terminal-web-backend
  egress:
    - to:
        - podSelector:
            matchLabels:
              job-id: ""
```

---

### Por que não está quebrando em produção hoje?
O backend do `TerminalWeb` cria automaticamente via código uma NetworkPolicy dinâmica por sessão (`netpol-${jobId}`) em tempo de execução no arquivo `services/k8sService.js`. Por isso, os pods continuam se comunicando normalmente mesmo antes desse ajuste ser realizado no `ConfigCluster`.
