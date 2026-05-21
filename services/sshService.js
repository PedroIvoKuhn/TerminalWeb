const forge = require('node-forge');

function generateSSHKeys() {
    return new Promise((resolve, reject) => {
        forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, keypair) => {
            if (err) return reject(err);
            const privateKeyPem = forge.pki.privateKeyToPem(keypair.privateKey);
            const publicKeySsh = forge.ssh.publicKeyToOpenSSH(keypair.publicKey, 'aluno@host');
            resolve({ privateKey: privateKeyPem, publicKey: publicKeySsh });
        });
    });
}

module.exports = { generateSSHKeys };