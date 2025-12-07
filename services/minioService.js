// services/minioService.js
const Minio = require('minio');
const { k8sExec, namespace } = require('../config/kubernetes');
const stream = require('stream');
const tar = require('tar-stream');
const zlib = require('zlib');

// Configuração do MinIO (pegando do .env)
const minioClient = new Minio.Client({
    // Em produção (Cluster), isso será algo como 'minio-service.default.svc.cluster.local'
    // Em teste local, pode ser o IP da máquina master (ex: '192.168.1.50')
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

async function listarArquivos(userId) {
    return new Promise((resolve, reject) => {
        const objects = [];
        const dataStream = minioClient.listObjects(BUCKET_NAME, `aluno_${userId}/`, true);
        dataStream.on('data', obj => objects.push(obj));
        dataStream.on('error', err => reject(err));
        dataStream.on('end', () => resolve(objects));
    });
}

async function verificarCota(userId) {
    const arquivos = await listarArquivos(userId);
    const totalUsado = arquivos.reduce((acc, curr) => acc + curr.size, 0);
    return { totalUsado, permitido: totalUsado < MAX_SIZE_BYTES };
}

async function deletarArquivo(userId, nomeCompleto) {
    if (!nomeCompleto.startsWith(`aluno_${userId}/`)) throw new Error("Permissão negada.");
    await minioClient.removeObject(BUCKET_NAME, nomeCompleto);
}

async function restaurarBackup(userId, podName, nomeArquivo) {
    // Garante que o nome tenha .tar.gz para buscar no MinIO
    let nomeFinal = nomeArquivo;
    if (!nomeFinal.endsWith('.tar.gz')) {
        nomeFinal += '.tar.gz';
    }

    const pathNoBucket = `aluno_${userId}/${nomeFinal}`;
    
    // Restauramos direto na raiz (/home/mpiuser)
    const command = ['tar', 'xzf', '-', '-C', '/home/mpiuser'];

    try {
        const dataStream = await minioClient.getObject(BUCKET_NAME, pathNoBucket);

        await k8sExec.exec(
            namespace, podName, 'mpi-container', command,
            null, process.stderr, dataStream, false
        );

        return { message: "Arquivos restaurados na home!" };
    } catch (e) {
        console.error("Erro restore:", e);
        throw e;
    }
}

// --- SALVAR ---
async function salvarBackup(userId, podName, nomeArquivo) {
    // 1. Checa cota
    const { permitido } = await verificarCota(userId);
    if (!permitido) throw new Error('Cota de 100MB excedida.');

    const nomeLimpo = nomeArquivo.replace(/(\.tar\.gz)+$/g, '');
    const nomeFinal = `aluno_${userId}/${nomeLimpo}.tar.gz`;
    
    const passThrough = new stream.PassThrough();

    const command = [
        'tar', 'czf', '-', 
        '-C', '/home/mpiuser', 
        '--exclude=*.tar.gz',
        '--exclude=.ssh',
        '.'
    ];

    try {
        // Executa o tar no Pod e joga a saída (stream) direto para o MinIO
        await k8sExec.exec(
            namespace, podName, 'mpi-container', command,
            passThrough, process.stderr, process.stdin, false
        );

        await minioClient.putObject(BUCKET_NAME, nomeFinal, passThrough);
        return { message: "Salvo com sucesso!", arquivo: nomeFinal };
    } catch (err) {
        console.error("Erro backup:", err);
        throw err;
    }
}

async function obterArquivoParaDownload(userId, nomeArquivo) {
    let nomeFinal = `aluno_${userId}/${nomeArquivo}`;
    if (!nomeFinal.endsWith('.tar.gz')) nomeFinal += '.tar.gz';

    try {
        return await minioClient.getObject(BUCKET_NAME, nomeFinal);
    } catch (e) {
        console.error("Erro ao obter arquivo:", e);
        throw e;
    }
}

async function listarConteudoBackup(userId, nomeArquivo) {
    let nomeFinal = `aluno_${userId}/${nomeArquivo}`;
    if (!nomeFinal.endsWith('.tar.gz')) nomeFinal += '.tar.gz';

    return new Promise(async (resolve, reject) => {
        try {
            const fileStream = await minioClient.getObject(BUCKET_NAME, nomeFinal);
            const extract = tar.extract();
            const files = [];

            extract.on('entry', (header, stream, next) => {
                files.push({ name: header.name, type: header.type, size: header.size });
                stream.on('end', next);
                stream.resume(); 
            });

            extract.on('finish', () => resolve(files));
            extract.on('error', (err) => reject(err));

            fileStream.pipe(zlib.createGunzip()).pipe(extract);
        } catch (e) { reject(e); }
    });
}

async function baixarArquivoInterno(userId, nomeBackup, arquivoAlvo) {
    let nomeFinal = `aluno_${userId}/${nomeBackup}`;
    if (!nomeFinal.endsWith('.tar.gz')) nomeFinal += '.tar.gz';

    return new Promise(async (resolve, reject) => {
        try {
            const fileStream = await minioClient.getObject(BUCKET_NAME, nomeFinal);
            const extract = tar.extract();
            let found = false;

            extract.on('entry', (header, stream, next) => {
                if (header.name === arquivoAlvo) {
                    found = true;
                    resolve(stream); 
                } else {
                    stream.on('end', next);
                    stream.resume();
                }
            });

            extract.on('finish', () => {
                if (!found) reject(new Error('Arquivo não encontrado.'));
            });

            fileStream.pipe(zlib.createGunzip()).pipe(extract);
        } catch (e) { reject(e); }
    });
}

async function baixarPastaInterna(userId, nomeBackup, pastaAlvo) {
    let nomeFinal = `aluno_${userId}/${nomeBackup}`;
    if (!nomeFinal.endsWith('.tar.gz')) nomeFinal += '.tar.gz';

    return new Promise(async (resolve, reject) => {
        try {
            const fileStream = await minioClient.getObject(BUCKET_NAME, nomeFinal);
            const extract = tar.extract();
            const pack = tar.pack(); 

            extract.on('entry', (header, stream, next) => {
                if (header.name.startsWith(pastaAlvo)) {
                    stream.pipe(pack.entry(header, next));
                } else {
                    stream.on('end', next);
                    stream.resume();
                }
            });

            extract.on('finish', () => pack.finalize());
            extract.on('error', (err) => reject(err));

            fileStream.pipe(zlib.createGunzip()).pipe(extract);
            resolve(pack.pipe(zlib.createGzip()));

        } catch (e) { reject(e); }
    });
}

module.exports = { listarArquivos, salvarBackup, deletarArquivo, restaurarBackup, obterArquivoParaDownload, listarConteudoBackup, baixarArquivoInterno, baixarPastaInterna };