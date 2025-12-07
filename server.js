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

app.get('/api/download', async (req, res) => {
    try {
        const { userId, nomeArquivo } = req.query;
        
        if (!userId || !nomeArquivo) {
            return res.status(400).send("Faltam parâmetros.");
        }

        const dataStream = await minioService.obterArquivoParaDownload(userId, nomeArquivo);
        
        // Força o navegador a baixar com o nome certo
        res.attachment(nomeArquivo.endsWith('.tar.gz') ? nomeArquivo : nomeArquivo + '.tar.gz');
        
        // Envia o arquivo
        dataStream.pipe(res);

    } catch(e) { 
        console.error(e);
        res.status(500).send("Erro ao baixar arquivo."); 
    }
});

// Download do arquivo inteiro (.tar.gz)
app.get('/api/download', async (req, res) => {
    try {
        const { userId, nomeArquivo } = req.query;
        const stream = await minioService.obterArquivoParaDownload(userId, nomeArquivo);
        res.attachment(nomeArquivo.endsWith('.tar.gz') ? nomeArquivo : nomeArquivo + '.tar.gz');
        stream.pipe(res);
    } catch(e) { res.status(500).send("Erro download."); }
});

// Listar conteúdo interno (Árvore)
app.get('/api/backups/content', async (req, res) => {
    try {
        const conteudo = await minioService.listarConteudoBackup(req.query.userId, req.query.nomeArquivo);
        res.json(conteudo);
    } catch(e) { res.status(500).json({error: e.message}); }
});

// Download de 1 arquivo interno
app.get('/api/backups/download-single', async (req, res) => {
    try {
        const { userId, nomeBackup, file } = req.query;
        const stream = await minioService.baixarArquivoInterno(userId, nomeBackup, file);
        res.attachment(file.split('/').pop());
        stream.pipe(res);
    } catch(e) { res.status(500).send("Erro extração."); }
});

// Download de 1 pasta interna
app.get('/api/backups/download-folder', async (req, res) => {
    try {
        const { userId, nomeBackup, folder } = req.query;
        const stream = await minioService.baixarPastaInterna(userId, nomeBackup, folder);
        const folderName = folder.replace(/\/$/, '').split('/').pop();
        res.attachment(`${folderName}.tar.gz`);
        stream.pipe(res);
    } catch(e) { res.status(500).send("Erro compactação."); }
});

start();