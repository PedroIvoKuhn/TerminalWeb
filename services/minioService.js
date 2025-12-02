// services/minioService.js
const Minio = require('minio');
const { k8sExec, namespace } = require('../config/kubernetes');
const stream = require('stream');

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
    const nomeFinal = `aluno_${userId}/${nomeArquivo}`;
    
    // Pega o nome limpo sem .tar.gz (ex: "trabalho1")
    const nomePasta = nomeArquivo.replace('.tar.gz', '');

    // 1. Cria uma pasta para não misturar os arquivos
    // O comando agora é: mkdir -p pasta && tar ... -C pasta
    const command = [
        'bash', '-c', 
        `mkdir -p /home/mpiuser/"${nomePasta}" && tar xzf - -C /home/mpiuser/"${nomePasta}"`
    ];

    const dataStream = await minioClient.getObject(BUCKET_NAME, nomeFinal);

    await k8sExec.exec(
        namespace,
        podName,
        'mpi-container',
        command,
        null,
        process.stderr,
        dataStream,
        false
    );

    return { message: "Restaurado na pasta: " + nomePasta };
}

async function salvarBackup(userId, podName, nomeArquivo) {
    // 1. Checa cota
    const { permitido } = await verificarCota(userId);
    if (!permitido) throw new Error('Cota de 100MB excedida.');

    const nomeFinal = `aluno_${userId}/${nomeArquivo}.tar.gz`;
    const passThrough = new stream.PassThrough();

    // 2. Comando tar dentro do pod
    // AVISO: 'mpiuser' é o usuário do seu Dockerfile. Se mudar lá, mude aqui.
    const command = ['tar', 'czf', '-', '/home/mpiuser']; 

    try {
        // Conecta a saída do Pod (stdout) à entrada do MinIO
        await k8sExec.exec(
            namespace,
            podName,
            'mpi-container',
            command,
            passThrough, 
            process.stderr,
            process.stdin,
            false
        );

        await minioClient.putObject(BUCKET_NAME, nomeFinal, passThrough);
        return { message: "Salvo com sucesso!", arquivo: nomeFinal };
    } catch (err) {
        console.error("Erro backup:", err);
        throw err;
    }
}

module.exports = { listarArquivos, salvarBackup, deletarArquivo, restaurarBackup};