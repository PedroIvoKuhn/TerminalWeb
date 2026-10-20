const dgram = require('dgram');
const net = require('net');

const FORWARD_PORT = parseInt(process.env.DNS_FORWARDER_PORT, 10) || 5353;
const COREDNS_HOST = process.env.COREDNS_HOST || '10.152.183.10';
const COREDNS_PORT = parseInt(process.env.COREDNS_PORT, 10) || 53;

let udpServer = null;
let tcpServer = null;

function start() {
    // 1. UDP Forwarder
    udpServer = dgram.createSocket('udp4');

    udpServer.on('message', (msg, rinfo) => {
        const client = dgram.createSocket('udp4');
        let closed = false;
        const closeClient = () => {
            if (!closed) {
                closed = true;
                try { client.close(); } catch (e) {}
            }
        };

        client.on('message', (resp) => {
            if (udpServer) {
                udpServer.send(resp, rinfo.port, rinfo.address, () => {});
            }
            closeClient();
        });

        client.on('error', () => {
            closeClient();
        });

        client.send(msg, COREDNS_PORT, COREDNS_HOST, (err) => {
            if (err) closeClient();
        });

        setTimeout(closeClient, 5000);
    });

    udpServer.on('error', (err) => {
        console.error('[DNS Forwarder] Erro no UDP server:', err.message);
    });

    udpServer.bind(FORWARD_PORT, '0.0.0.0', () => {
        console.log(`[DNS Forwarder] UDP ativo na porta ${FORWARD_PORT} (encaminhando para ${COREDNS_HOST}:${COREDNS_PORT})`);
    });

    // 2. TCP Forwarder
    tcpServer = net.createServer((socket) => {
        const upstream = net.createConnection({ host: COREDNS_HOST, port: COREDNS_PORT }, () => {
            socket.pipe(upstream);
            upstream.pipe(socket);
        });

        upstream.on('error', () => {
            socket.destroy();
        });
        socket.on('error', () => {
            upstream.destroy();
        });
    });

    tcpServer.on('error', (err) => {
        console.error('[DNS Forwarder] Erro no TCP server:', err.message);
    });

    tcpServer.listen(FORWARD_PORT, '0.0.0.0', () => {
        console.log(`[DNS Forwarder] TCP ativo na porta ${FORWARD_PORT}`);
    });
}

function stop() {
    if (udpServer) {
        try { udpServer.close(); } catch (e) {}
        udpServer = null;
    }
    if (tcpServer) {
        try { tcpServer.close(); } catch (e) {}
        tcpServer = null;
    }
}

module.exports = { start, stop };
