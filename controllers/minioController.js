const express = require('express');
const router = express.Router();
const minioService = require('../services/minioService');

// Middleware
const requireAuth = (req, res, next) => {
    req.userId = req.session.userId || (process.env.NODE_ENV === 'development' ? 'devUser' : null);

    if ( !req.userId ) {
        return res.status(401).json({
            error: "Não autorizado: Sessão expirada ou inválida."
        })
    }

    next();
}

router.use(requireAuth);

// Listar Backups
router.get('/backups', async (req, res) => {
    try {
        const files = await minioService.listFiles(req.userId);
        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Salvar Novo Backup
router.post('/backups', async (req, res) => {
    const { podName, fileName } = req.body;
    try {
        if (!podName || !fileName) {
            throw new Error("Dados incompletos: podName ou nome do arquivo");
        }

        const result = await minioService.saveBackup(req.userId, podName, fileName);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Deletar Backup
router.delete('/backups', async (req, res) => {
    const { fullName } = req.body; 

    try {
        if (!fullName) return res.status(400).json({ error: "Parametro faltando: fullName." });

        await minioService.deleteFile(req.userId, fullName);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download do arquivo inteiro (.tar.gz)
router.get('/download', async (req, res) => {
    try {
        const { fileName } = req.query;

        if (!fileName) return res.status(400).send("Faltam parâmetros: fileName.");

        const dataStream = await minioService.getFileForDownload(req.userId, fileName);
        const attachmentName = fileName.endsWith('.tar.gz') ? fileName : `${fileName}.tar.gz`;

        res.attachment(attachmentName);

        // Tratamento de erro
        dataStream.on('error', (err) => {
            console.error("[Stream Error] Falha durante o download: ", err);
            // Só tenta enviar erro 500 se o Express ainda não tiver começado a mandar o arquivo
            if (!res.headersSent) {
                res.status(500).send("Erro durante o download do arquivo. (streaming)");
            }
        });

        dataStream.pipe(res);
    } catch(e) { 
        console.error(e);
        res.status(500).send("Erro ao baixar arquivo."); 
    }
});

// Listar conteúdo interno (Árvore de arquivos dentro do tar.gz)
router.get('/backups/content', async (req, res) => {
    const { fileName } = req.query;

    try {
        if (!fileName) return res.status(400).json({ error: "Parâmetro faltando: fileName." });

        const content = await minioService.listContentBackup(req.userId, fileName);
        res.json(content);
    } catch(e) { 
        res.status(500).json({error: e.message}); 
    }
});

// Download de 1 arquivo interno específico
router.get('/backups/download-single', async (req, res) => {
    const { backupName, file } = req.query;

    try {
        if (!backupName || !file) return res.status(400).send("Parâmetros faltando: backupName ou file.");

        const stream = await minioService.downloadInternalFile(req.userId, backupName, file);
        res.attachment(file.split('/').pop());

        stream.on('error', (err) => {
            console.error('[Stream Error] Download de arquivo interno falhou:', err);
            if (!res.headersSent) res.status(500).send("Error streaming internal file.");
        });

        stream.pipe(res);
    } catch(e) { 
        res.status(500).send("Erro extração."); 
    }
});

// Download de 1 pasta interna específica (zipada)
router.get('/backups/download-folder', async (req, res) => {
    const { backupName, folder } = req.query;

    try {
        if (!backupName || !folder) return res.status(400).send("Parâmetros faltando: backupName ou folder.");
        
        const stream = await minioService.downloadInternalFolder(req.userId, backupName, folder);
        const folderName = folder.replace(/\/$/, '').split('/').pop();
        res.attachment(`${folderName}.tar.gz`);

        stream.on('error', (err) => {
            console.error('[Stream Error] Download de pasta interna falhou:', err);
            if (!res.headersSent) res.status(500).send("Error streaming internal folder.");
        });

        stream.pipe(res);
    } catch(e) { 
        res.status(500).send("Erro compactando a pasta."); 
    }
});

module.exports = router;