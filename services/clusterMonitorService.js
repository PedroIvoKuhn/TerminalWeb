const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Cache em memória para evitar chamadas excessivas ao kubectl
let cachedMetrics = null;
let lastCheckTime = 0;
const CACHE_TTL_MS = 15000; // 15 segundos

/**
 * Consulta e calcula o uso de CPU e Memória dos nós locais do MicroK8s
 * @returns {Promise<{
 *   avgCpu: number,
 *   avgMem: number,
 *   maxCpu: number,
 *   maxMem: number,
 *   isCongested: boolean,
 *   threshold: number,
 *   nodeCount: number,
 *   nodes: Array<{ name: string, cpuPercent: number, memPercent: number }>
 * }>}
 */
async function getClusterMetrics() {
    const now = Date.now();
    if (cachedMetrics && (now - lastCheckTime < CACHE_TTL_MS)) {
        return cachedMetrics;
    }

    const CONGESTION_THRESHOLD = parseInt(process.env.CLUSTER_CONGESTION_THRESHOLD, 10) || 80;

    try {
        const { stdout } = await execAsync('microk8s kubectl top nodes --no-headers');
        const lines = stdout.trim().split('\n').filter(Boolean);

        let totalCpu = 0;
        let totalMem = 0;
        let maxCpu = 0;
        let maxMem = 0;
        const nodes = [];

        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5) {
                const name = parts[0];
                // Ignora nós remotos da nuvem para medir apenas a capacidade on-premise
                if (name.toLowerCase().startsWith('burst-node-')) {
                    continue;
                }

                const cpuPercent = parseInt(parts[2].replace('%', ''), 10) || 0;
                const memPercent = parseInt(parts[4].replace('%', ''), 10) || 0;

                totalCpu += cpuPercent;
                totalMem += memPercent;
                if (cpuPercent > maxCpu) maxCpu = cpuPercent;
                if (memPercent > maxMem) maxMem = memPercent;

                nodes.push({ name, cpuPercent, memPercent });
            }
        }

        const nodeCount = nodes.length;
        const avgCpu = nodeCount > 0 ? Math.round(totalCpu / nodeCount) : 0;
        const avgMem = nodeCount > 0 ? Math.round(totalMem / nodeCount) : 0;

        // Considera congestionado se a média de CPU for maior ou igual ao threshold configurado
        const isCongested = avgCpu >= CONGESTION_THRESHOLD;

        cachedMetrics = {
            avgCpu,
            avgMem,
            maxCpu,
            maxMem,
            isCongested,
            threshold: CONGESTION_THRESHOLD,
            nodeCount,
            nodes,
            updatedAt: now
        };
        lastCheckTime = now;
        return cachedMetrics;
    } catch (err) {
        console.warn('[ClusterMonitor] Erro ao consultar métricas do cluster:', err.message);
        // Fallback em caso de falha temporária
        return {
            avgCpu: 0,
            avgMem: 0,
            maxCpu: 0,
            maxMem: 0,
            isCongested: false,
            threshold: CONGESTION_THRESHOLD,
            nodeCount: 0,
            nodes: [],
            error: err.message
        };
    }
}

module.exports = {
    getClusterMetrics
};
