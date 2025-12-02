require("dotenv").config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');

const ltiController = require('./controllers/ltiController');
const socketService = require('./services/socketService');
const minioService = require('./services/minioService');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/xterm-addon-fit')));

// Rota: Listar Backups
app.get('/api/backups', async (req, res) => {
    // O ideal é pegar o ID do aluno via sessão LTI. 
    // Por enquanto, vou pegar via Query Param para agilizar seu teste.
    const userId = req.query.userId || 'anonimo'; 
    try {
        const arquivos = await minioService.listarArquivos(userId);
        res.json(arquivos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rota: Salvar Novo Backup
app.post('/api/backups', async (req, res) => {
    const { userId, podName, nomeArquivo } = req.body;
    try {
        if(!podName || !nomeArquivo) throw new Error("Dados incompletos");
        
        const resultado = await minioService.salvarBackup(userId, podName, nomeArquivo);
        res.json(resultado);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Rota: Deletar Backup
app.delete('/api/backups', async (req, res) => {
    const { userId, nomeCompleto } = req.body;
    try {
        await minioService.deletarArquivo(userId, nomeCompleto);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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