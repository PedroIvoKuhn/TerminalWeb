const Minio = require('minio');
const stream = require('stream');
const tar = require('tar-stream');
const zlib = require('zlib');
const path = require('path');

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
const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

// Garante que o bucket existe
minioClient.bucketExists(BUCKET_NAME, function(err, exists) {
    if (err) return console.log(err);
    if (!exists) {
        minioClient.makeBucket(BUCKET_NAME, 'us-east-1', function(err) {
            if (err) return console.log('Erro criando bucket', err);
            console.log('Bucket criado com sucesso.');
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
    return { totalUsed, permitted: totalUsed < MAX_SIZE_BYTES };
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
    // 1. Checa cota
    const { permitted } = await checkQuota(userId);
    if (!permitted) throw new Error('Cota de 100MB excedida.');

    // 2. Segurança
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
    
        await Promise.all([execPromise, uploadPromise]); // Espera as duas promessas trabalharem em conjunto
        return { message: "Salvo com sucesso!", arquivo: finalName };
    } catch (err) {
        console.error("Erro no fluxo do backup:", err);
        throw new Error("Falha ao salvar backup no storage.");
    }
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
    downloadInternalFolder 
};