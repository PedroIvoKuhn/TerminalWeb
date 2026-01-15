const express = require('express');
const router = express.Router();
const minioService = require('../services/minioService');

// Listar Backups
router.get('/backups', async (req, res) => {
    const userId = req.query.userId || 'anonimo'; 
    try {
        const arquivos = await minioService.listarArquivos(userId);
        res.json(arquivos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Salvar Novo Backup
router.post('/backups', async (req, res) => {
    const { userId, podName, nomeArquivo } = req.body;
    try {
        if(!podName || !nomeArquivo) throw new Error("Dados incompletos");
        
        const resultado = await minioService.salvarBackup(userId, podName, nomeArquivo);
        res.json(resultado);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Deletar Backup
router.delete('/backups', async (req, res) => {
    const { userId, nomeCompleto } = req.body;
    try {
        await minioService.deletarArquivo(userId, nomeCompleto);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download do arquivo inteiro (.tar.gz)
router.get('/download', async (req, res) => {
    try {
        const { userId, nomeArquivo } = req.query;
        
        if (!userId || !nomeArquivo) {
            return res.status(400).send("Faltam parâmetros.");
        }

        const dataStream = await minioService.obterArquivoParaDownload(userId, nomeArquivo);

        res.attachment(nomeArquivo.endsWith('.tar.gz') ? nomeArquivo : nomeArquivo + '.tar.gz');

        dataStream.pipe(res);

    } catch(e) { 
        console.error(e);
        res.status(500).send("Erro ao baixar arquivo."); 
    }
});

// Listar conteúdo interno (Árvore de arquivos dentro do tar.gz)
router.get('/backups/content', async (req, res) => {
    try {
        const conteudo = await minioService.listarConteudoBackup(req.query.userId, req.query.nomeArquivo);
        res.json(conteudo);
    } catch(e) { 
        res.status(500).json({error: e.message}); 
    }
});

// Download de 1 arquivo interno específico
router.get('/backups/download-single', async (req, res) => {
    try {
        const { userId, nomeBackup, file } = req.query;
        const stream = await minioService.baixarArquivoInterno(userId, nomeBackup, file);
        res.attachment(file.split('/').pop());
        stream.pipe(res);
    } catch(e) { 
        res.status(500).send("Erro extração."); 
    }
});

// Download de 1 pasta interna específica (zipada)
router.get('/backups/download-folder', async (req, res) => {
    try {
        const { userId, nomeBackup, folder } = req.query;
        const stream = await minioService.baixarPastaInterna(userId, nomeBackup, folder);
        const folderName = folder.replace(/\/$/, '').split('/').pop();
        res.attachment(`${folderName}.tar.gz`);
        stream.pipe(res);
    } catch(e) { 
        res.status(500).send("Erro compactação."); 
    }
});

module.exports = router;