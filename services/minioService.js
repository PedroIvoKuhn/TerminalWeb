const Minio = require('minio');
const stream = require('stream');
const tar = require('tar-stream');
const zlib = require('zlib');
const path = require('path');
const AdmZip = require('adm-zip');

const k8sService = require('./k8sService');

// Configuração do MinIO (pegando do .env)
const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || 'minio-service', 
    port: parseInt(process.env.MINIO_PORT) || 9000, 
    useSSL: false, 
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY
});

const BUCKET_NAME = 'arquivos-alunos';
const MAX_STORAGE_MB = parseInt(process.env.MAX_STUDENT_STORAGE_MB, 10) || 100;
const MAX_SIZE_BYTES = MAX_STORAGE_MB * 1024 * 1024;

// Garante que o bucket existe
minioClient.bucketExists(BUCKET_NAME, function(err, exists) {
    if (err) return;
    if (!exists) {
        minioClient.makeBucket(BUCKET_NAME, 'us-east-1', function(err) {
            if (err) return;
        });
    }
});

async function listFiles(userId) {
    const objects = [];
    const dataStream = minioClient.listObjects(BUCKET_NAME, `aluno_${userId}/`, true);

    for await (const obj of dataStream) {
        objects.push(obj);
    }

    return objects;
}

async function checkQuota(userId) {
    const files = await listFiles(userId);
    const totalUsed = files.reduce((acc, curr) => acc + curr.size, 0);
    return { totalUsed, permitted: totalUsed < MAX_SIZE_BYTES, maxLimitBytes: MAX_SIZE_BYTES, maxLimitMB: MAX_STORAGE_MB };
}

async function deleteFile(userId, fullName) {
    if (typeof fullName !== 'string' || !fullName.trim()) {
        throw new Error("Nome de arquivo inválido.");
    }

    if (!fullName.startsWith(`aluno_${userId}/`)){
        throw new Error("Permissão negada: Você só pode deletar seus próprios arquivos.");
    } 

    await minioClient.removeObject(BUCKET_NAME, fullName);
}

async function restoreBackup(userId, podName, fileName) {
    // Garante que o nome tenha .tar.gz para buscar no MinIO
    let finalName = fileName;
    if (!finalName.endsWith('.tar.gz')) {
        finalName += '.tar.gz';
    }

    const pathNoBucket = `aluno_${userId}/${finalName}`;
    
    // Restauramos direto na raiz (/home/aluno)
    const command = ['tar', 'xzf', '-', '-C', '/home/aluno'];

    try {
        const dataStream = await minioClient.getObject(BUCKET_NAME, pathNoBucket);

        await k8sService.connectPodToTerminal(
            podName,  
            command,
            null, 
            process.stderr, 
            dataStream, 
            false
        );

        return { message: "Arquivos restaurados na home!" };
    } catch (e) {
        console.error("Erro restore:", e);
        throw e;
    }
}

// --- SALVAR ---
async function saveBackup(userId, podName, fileName) {
    // 1. Checa o tamanho do ambiente dentro do pod (/home/aluno)
    const dirSizeMB = await k8sService.getPodDirectorySizeMB(podName, '/home/aluno');
    if (dirSizeMB > MAX_STORAGE_MB) {
        throw new Error(`O seu ambiente é muito grande (${dirSizeMB} MB) e excede o limite permitido de ${MAX_STORAGE_MB} MB. Não foi possível salvar o backup. Volte ao terminal para diminuir o volume excluindo arquivos desnecessários antes de salvar.`);
    }

    // 2. Checa cota total de backups salvos no MinIO
    const { totalUsed, permitted } = await checkQuota(userId);
    if (!permitted) {
        const usedMB = (totalUsed / (1024 * 1024)).toFixed(1);
        throw new Error(`A sua cota de armazenamento (${usedMB} MB) atingiu o limite de ${MAX_STORAGE_MB} MB. Exclua backups antigos para liberar espaço antes de salvar.`);
    }

    // 3. Segurança do nome
    if (typeof fileName !== 'string' || !fileName.trim()) throw new Error("Nome inválido");
    const safeName = path.basename(fileName); 
    
    const cleanName = safeName.replace(/(\.tar\.gz)+$/g, '');
    const finalName = `aluno_${userId}/${cleanName}.tar.gz`;
    
    const passThrough = new stream.PassThrough();

    passThrough.on('error', (err) => {
        console.error('[Stream Error] passThrough error na hora de salvar:', err.message);
    });

    const command = [
        'tar', 'czf', '-', 
        '-C', '/home/aluno', 
        '--exclude=*.tar.gz',
        '--exclude=.ssh',
        '.'
    ];

    try {
        const execPromise = k8sService.connectPodToTerminal(
            podName, 
            command,
            passThrough, 
            process.stderr, 
            null, 
            false
        );
        const uploadPromise = minioClient.putObject(BUCKET_NAME, finalName, passThrough);
    
        await Promise.all([execPromise, uploadPromise]);
        return { message: "Salvo com sucesso!", arquivo: finalName };
    } catch (err) {
        console.error("Erro no fluxo do backup:", err);
        throw new Error(err.message.includes('ambiente') || err.message.includes('cota') ? err.message : "Falha ao salvar backup no storage.");
    }
}

async function uploadFileToPod({ podName, targetDir, file, extractZip, userId }) {
    // 1. Sanitização do diretório de destino (diretório mínimo estrito é /home/aluno)
    let cleanDir = path.posix.normalize((targetDir || '/home/aluno').trim());
    if (cleanDir !== '/home/aluno' && !cleanDir.startsWith('/home/aluno/')) {
        cleanDir = path.posix.join('/home/aluno', cleanDir.replace(/^(\.\.[\/\\])+/, '').replace(/^\/+/, ''));
    }
    if (cleanDir === '/home/aluno/.ssh' || cleanDir.startsWith('/home/aluno/.ssh/')) {
        throw new Error("Não é permitido enviar arquivos para o diretório de chaves .ssh.");
    }

    const isZip = file.originalname.toLowerCase().endsWith('.zip');
    const pack = tar.pack();

    if (isZip && extractZip) {
        let zip;
        try {
            zip = new AdmZip(file.buffer);
        } catch (e) {
            throw new Error("Arquivo ZIP inválido ou corrompido.");
        }

        const entries = zip.getEntries();
        let totalUncompressedSize = 0;
        const MAX_UNCOMPRESSED_BYTES = MAX_STORAGE_MB * 1024 * 1024;

        if (entries.length > 2000) {
            throw new Error("O arquivo ZIP contém muitos arquivos (limite máximo de 2000 arquivos).");
        }

        for (const entry of entries) {
            const entryName = entry.entryName.replace(/\\/g, '/');
            // Proteção contra Zip Slip
            if (entryName.includes('..') || path.posix.isAbsolute(entryName)) {
                throw new Error("O arquivo ZIP contém caminhos inválidos ou inseguros (Zip Slip detectado).");
            }
            if (entryName.startsWith('.ssh/') || entryName === '.ssh') {
                continue;
            }

            if (entry.isDirectory) {
                pack.entry({
                    name: entryName,
                    type: 'directory',
                    mode: 0o755
                });
            } else {
                totalUncompressedSize += entry.header.size;
                if (totalUncompressedSize > MAX_UNCOMPRESSED_BYTES) {
                    throw new Error(`O conteúdo descompactado do ZIP (${(totalUncompressedSize / 1024 / 1024).toFixed(1)} MB) excede o limite permitido de ${MAX_STORAGE_MB} MB.`);
                }
                const data = entry.getData();
                pack.entry({
                    name: entryName,
                    size: data.length,
                    mode: 0o644
                }, data);
            }
        }
    } else {
        const safeName = path.basename(file.originalname);
        pack.entry({
            name: safeName,
            size: file.buffer.length,
            mode: 0o644
        }, file.buffer);
    }

    pack.finalize();

    // 2. Injeta no pod
    await k8sService.injectTarStreamToPod(podName, cleanDir, pack);

    // Ajusta permissões dos arquivos para o aluno
    await k8sService.execPodSimpleCommand(podName, ['chown', '-R', 'aluno:aluno', cleanDir]);

    return {
        success: true,
        message: isZip && extractZip 
            ? `Arquivo ZIP descompactado com sucesso em "${cleanDir}"!` 
            : `Arquivo "${file.originalname}" salvo com sucesso em "${cleanDir}"!`,
        targetDir: cleanDir,
        fileName: file.originalname,
        extracted: isZip && extractZip
    };
}

async function getFileForDownload(userId, fileName) {
    if (typeof fileName !== 'string' || !fileName.trim()) throw new Error("Nome inválido");
    const safeName = path.basename(fileName);

    let finalName = `aluno_${userId}/${safeName}`;
    if (!finalName.endsWith('.tar.gz')) finalName += '.tar.gz';

    try {
        return await minioClient.getObject(BUCKET_NAME, finalName);
    } catch (e) {
        console.error(`Erro ao obter arquivo ${finalName}:`, e);
        throw new Error("Arquivo não encontrado ou inacessível.");
    }
}

async function listContentBackup(userId, fileName) {
    if (typeof fileName !== 'string' || !fileName.trim()) throw new Error("Nome inválido");
    const safeName = path.basename(fileName);

    let finalName = `aluno_${userId}/${safeName}`;
    if (!finalName.endsWith('.tar.gz')) finalName += '.tar.gz';

    const fileStream = await minioClient.getObject(BUCKET_NAME, finalName);
    return new Promise((resolve, reject) => {
        const extract = tar.extract();
        const files = [];

        extract.on('entry', (header, stream, next) => {
            files.push({ name: header.name, type: header.type, size: header.size });
            // Descarta o conteúdo do arquivo para ir logo pro próximo
            stream.on('end', next);
            stream.resume(); 
        });

        extract.on('finish', () => resolve(files));
        extract.on('error', reject);
        fileStream.on('error', reject); // Captura erros da conexão com MinIO

        fileStream.pipe(zlib.createGunzip()).pipe(extract);
    });
}

async function downloadInternalFile(userId, backupName, fileName) {
    if (typeof backupName !== 'string' || !backupName.trim()) throw new Error("Nome inválido");
    const safeName = path.basename(backupName);

    let finalName = `aluno_${userId}/${safeName}`;
    if (!finalName.endsWith('.tar.gz')) finalName += '.tar.gz';

    const fileStream = await minioClient.getObject(BUCKET_NAME, finalName);
    return new Promise((resolve, reject) => {
        const extract = tar.extract();
        let found = false;

        extract.on('entry', (header, stream, next) => {
            if (header.name === fileName) {
                found = true;
                resolve(stream); 
                // 3. PERFORMANCE E FLUXO: Quando o arquivo alvo for 100% baixado pelo Express...
                stream.on('end', () => {
                    // Nós DESTRUÍMOS a stream do MinIO. Não queremos baixar o resto do backup!
                    fileStream.destroy();
                });
            } else {
                // Se não é o arquivo que queremos, descarta e vai pro próximo
                stream.on('end', next);
                stream.resume();
            }
        });

        extract.on('finish', () => {
            if (!found) reject(new Error('Arquivo não encontrado.'));
        });

        extract.on('error', reject);
        
        fileStream.on('error', (err) => {
            // Ignora o erro se fomos nós mesmos que destruímos a stream (economia de banda)
            if (found) return; 
            reject(err);
        });

        fileStream.pipe(zlib.createGunzip()).pipe(extract);
    });
}

async function downloadInternalFolder(userId, backupName, targetFolder) {
    if (typeof backupName !== 'string' || !backupName.trim()) throw new Error("Nome inválido");
    const safeName = path.basename(backupName);

    let finalName = `aluno_${userId}/${safeName}`;
    if (!finalName.endsWith('.tar.gz')) finalName += '.tar.gz';

    const fileStream = await minioClient.getObject(BUCKET_NAME, finalName);
    return new Promise((resolve, reject) => {
        const extract = tar.extract();
        const pack = tar.pack(); 

        extract.on('entry', (header, stream, next) => {
            if (header.name.startsWith(targetFolder)) {
                // Copia o arquivo da tar antiga para a tar nova
                // O pack.entry já chama o 'next' automaticamente quando finaliza a cópia
                stream.pipe(pack.entry(header, next));
            } else {
                // Pula o arquivo
                stream.on('end', next);
                stream.resume();
            }
        });

        extract.on('finish', () => pack.finalize());
        extract.on('error', reject);
        fileStream.on('error', reject);

        fileStream.pipe(zlib.createGunzip()).pipe(extract);
        
        // Resolve imediatamente, o Controller fará o Pipe para o Express baixar!
        resolve(pack.pipe(zlib.createGzip()));
    });
}

module.exports = { 
    listFiles, 
    saveBackup, 
    deleteFile, 
    restoreBackup, 
    getFileForDownload, 
    listContentBackup, 
    downloadInternalFile, 
    downloadInternalFolder,
    uploadFileToPod,
    checkQuota
};