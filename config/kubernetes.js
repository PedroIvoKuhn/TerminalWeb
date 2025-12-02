const k8s = require('@kubernetes/client-node');
const kc = new k8s.KubeConfig();

if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
} else {
    kc.loadFromDefault();
}

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sExec = new k8s.Exec(kc);
const namespace = process.env.K8S_NAMESPACE || 'default';

module.exports = { k8sApi, k8sExec, namespace, kc };