const express = require('express');
const router = express.Router();
const minioService = require('../services/minioService');

const getUserId = (req) => {
    return req.session.userId || (process.env.NODE_ENV === 'development' ? 'devUser' : null);
};

// Listar Backups
router.get('/backups', async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
        return res.status(401).json({ error: "Sessão expirada ou inválida." });
    }
    try {
        const arquivos = await minioService.listarArquivos(userId);
        res.json(arquivos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Salvar Novo Backup
router.post('/backups', async (req, res) => {
    const userId = getUserId(req);
    const { podName, nomeArquivo } = req.body;
    try {
        if (!userId) return res.status(401).json({ error: "Não autorizado" });
        if (!podName || !nomeArquivo) throw new Error("Dados incompletos");

        const resultado = await minioService.salvarBackup(userId, podName, nomeArquivo);
        res.json(resultado);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Deletar Backup
router.delete('/backups', async (req, res) => {
    const userId = getUserId(req);
    const { nomeCompleto } = req.body; 

    try {
        if(!userId) return res.status(401).json({error: "Não autorizado"});
        await minioService.deletarArquivo(userId, nomeCompleto);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download do arquivo inteiro (.tar.gz)
router.get('/download', async (req, res) => {
    try {
        const userId = getUserId(req);
        const { nomeArquivo } = req.query;
        
        if (!userId) return res.status(401).send("Sessão inválida.");
        if (!nomeArquivo) return res.status(400).send("Faltam parâmetros.");

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
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Sessão inválida" });

    try {
        const conteudo = await minioService.listarConteudoBackup(userId, req.query.nomeArquivo);
        res.json(conteudo);
    } catch(e) { 
        res.status(500).json({error: e.message}); 
    }
});

// Download de 1 arquivo interno específico
router.get('/backups/download-single', async (req, res) => {
    try {
        const userId = getUserId(req);
        const { nomeBackup, file } = req.query;
        if (!userId) return res.status(401).send("Sessão inválida.");

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
        const userId = getUserId(req);
        const { nomeBackup, folder } = req.query;
        if (!userId) return res.status(401).send("Sessão inválida.");
        
        const stream = await minioService.baixarPastaInterna(userId, nomeBackup, folder);
        const folderName = folder.replace(/\/$/, '').split('/').pop();
        res.attachment(`${folderName}.tar.gz`);
        stream.pipe(res);
    } catch(e) { 
        res.status(500).send("Erro compactação."); 
    }
});

module.exports = router;