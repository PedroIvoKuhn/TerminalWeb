require("dotenv").config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');

const ltiController = require('./controllers/ltiController');
const socketService = require('./services/socketService');
const minioController = require('./controllers/minioController');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/xterm-addon-fit')));
app.use('/api', minioController);

async function start() {
    try {
        await ltiController.setup(app);

        socketService(io);

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`Servidor rodando em http://localhost:${PORT}`);
        })
    } catch (error) {
        console.error(`Erro ao iniciar servidor`, error);
        process.exit(1);
    }
}

start();