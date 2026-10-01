/**
 * Módulo de Criptografia para Credenciais de Nuvem (Cloud Bursting)
 * Implementado prioritariamente com o módulo nativo 'crypto' do Node.js (OpenSSL com aceleração AES-NI),
 * mantendo total interoperabilidade com a biblioteca 'node-forge' utilizada no navegador.
 * 
 * Algoritmo: AES-256-GCM (Authenticated Encryption with Associated Data - AEAD)
 * - Confidencialidade: Cifragem AES com chave de 256 bits derivada via SHA-256.
 * - Integridade e Autenticidade: Tag de autenticação de 128 bits (16 bytes) para prevenir adulterações.
 * - IV (Vetor de Inicialização): 12 bytes (96 bits) aleatórios por operação conforme NIST SP 800-38D.
 */

require('dotenv').config();
const crypto = require('crypto');
const forge = require('node-forge');

/**
 * Deriva uma chave simétrica de 256 bits (32 bytes) a partir da variável de ambiente
 * Utiliza SHA-256 para garantir que a chave tenha exatamente 32 bytes independente do formato do segredo.
 * 
 * @param {string} [customSecret] - Segredo customizado opcional
 * @returns {Buffer} Buffer com os 32 bytes da chave derivada
 */
function deriveMasterKeyBuffer(customSecret) {
    const secret = customSecret || 
                   process.env.BURST_ENCRYPTION_KEY || 
                   process.env.SESSION_SECRET || 
                   process.env.LTI_ENCRYPTION_KEY || 
                   'default-terminalweb-burst-secret-key-32b';

    return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Verifica se um objeto já está no formato de carga criptografada
 * @param {any} data 
 * @returns {boolean}
 */
function isEncrypted(data) {
    return Boolean(
        data && 
        typeof data === 'object' && 
        data.__encrypted === true && 
        typeof data.data === 'string' &&
        typeof data.iv === 'string' &&
        typeof data.tag === 'string'
    );
}

/**
 * Criptografa dados (objeto ou string) usando AES-256-GCM via módulo nativo 'crypto'
 * 
 * @param {Object|string} data - Objeto de credenciais ou string para criptografar
 * @param {string} [secret] - Segredo opcional para derivação da chave
 * @returns {Object} Objeto estruturado com o texto cifrado, IV e Tag de autenticação
 */
function encrypt(data, secret) {
    if (!data) return data;
    if (isEncrypted(data)) return data; // Idempotente: evita dupla criptografia

    const key = deriveMasterKeyBuffer(secret);
    // IV de 12 bytes (96 bits) recomendado pelo NIST para AES-GCM
    const iv = crypto.randomBytes(12);

    const plainText = typeof data === 'string' ? data : JSON.stringify(data);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encryptedHex = cipher.update(plainText, 'utf8', 'hex');
    encryptedHex += cipher.final('hex');
    const tagHex = cipher.getAuthTag().toString('hex');

    return {
        __encrypted: true,
        algorithm: 'AES-256-GCM',
        engine: 'native-crypto',
        iv: iv.toString('hex'),
        tag: tagHex,
        data: encryptedHex
    };
}

/**
 * Descriptografa um payload criptografado com AES-256-GCM
 * Suporta payloads gerados tanto pelo 'crypto' nativo quanto pelo 'node-forge'
 * 
 * @param {Object} payload - Objeto retornado por encrypt ({ __encrypted: true, iv, tag, data })
 * @param {string} [secret] - Segredo opcional
 * @returns {Object|string} Dado original descriptografado (objeto ou string)
 */
function decrypt(payload, secret) {
    if (!payload) return payload;
    if (!isEncrypted(payload)) return payload; // Já é texto plano, passa direto

    const key = deriveMasterKeyBuffer(secret);
    const iv = Buffer.from(payload.iv, 'hex');
    const tag = Buffer.from(payload.tag, 'hex');

    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);

        let decrypted = decipher.update(payload.data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        try {
            return JSON.parse(decrypted);
        } catch {
            return decrypted;
        }
    } catch (nativeErr) {
        // Se houver falha, tenta com node-forge como contingência
        try {
            return decryptWithForge(payload, secret);
        } catch {
            throw new Error('[CRYPTO] Falha na autenticação AES-256-GCM: Dados corrompidos ou chave inválida (Tag inválida).');
        }
    }
}

/**
 * Criptografa credenciais do usuário garantindo retorno estruturado
 * @param {Object} credentials 
 * @returns {Object}
 */
function encryptCredentials(credentials) {
    if (!credentials || typeof credentials !== 'object') return credentials;
    if (isEncrypted(credentials)) return credentials;
    return encrypt(credentials);
}

/**
 * Descriptografa credenciais do usuário se estiverem criptografadas
 * @param {Object} credentials 
 * @returns {Object}
 */
function decryptCredentials(credentials) {
    if (!credentials) return credentials;
    if (!isEncrypted(credentials)) return credentials;
    return decrypt(credentials);
}

/**
 * Mascara campos sensíveis das credenciais para logging seguro
 * Evita vazamento acidental de chaves secretas no terminal ou logs
 * 
 * @param {Object} credentials - Credenciais em texto plano ou criptografadas
 * @returns {Object}
 */
function maskCredentials(credentials) {
    if (!credentials) return {};
    if (isEncrypted(credentials)) {
        return {
            __encrypted: true,
            algorithm: credentials.algorithm,
            engine: credentials.engine,
            iv: credentials.iv ? `${credentials.iv.slice(0, 6)}...` : undefined,
            dataLength: credentials.data ? credentials.data.length : 0
        };
    }

    const masked = { ...credentials };
    if (masked.secretAccessKey) masked.secretAccessKey = '********';
    if (masked.sessionToken) masked.sessionToken = `${String(masked.sessionToken).slice(0, 8)}...[mascarado]`;
    if (masked.clientSecret) masked.clientSecret = '********';
    if (masked.accessKeyId) masked.accessKeyId = `${String(masked.accessKeyId).slice(0, 6)}...${String(masked.accessKeyId).slice(-4)}`;
    return masked;
}

/**
 * Fallback / Alternativa com node-forge mantida para contingência e compatibilidade
 */
function encryptWithForge(data, secret) {
    if (!data) return data;
    if (isEncrypted(data)) return data;

    const secretStr = secret || process.env.BURST_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'default-burst-key';
    const md = forge.md.sha256.create();
    md.update(secretStr, 'utf8');
    const forgeKey = md.digest().getBytes();
    const ivBytes = forge.random.getBytesSync(12);

    const plainText = typeof data === 'string' ? data : JSON.stringify(data);
    const cipher = forge.cipher.createCipher('AES-GCM', forgeKey);
    cipher.start({ iv: ivBytes, tagLength: 128 });
    cipher.update(forge.util.createBuffer(plainText, 'utf8'));
    cipher.finish();

    return {
        __encrypted: true,
        algorithm: 'AES-256-GCM',
        engine: 'node-forge',
        iv: forge.util.bytesToHex(ivBytes),
        tag: cipher.mode.tag.toHex(),
        data: cipher.output.toHex()
    };
}

function decryptWithForge(payload, secret) {
    const secretStr = secret || process.env.BURST_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'default-burst-key';
    const md = forge.md.sha256.create();
    md.update(secretStr, 'utf8');
    const forgeKey = md.digest().getBytes();

    const ivBytes = forge.util.hexToBytes(payload.iv);
    const tagBuffer = forge.util.createBuffer(forge.util.hexToBytes(payload.tag));
    const encryptedBytes = forge.util.hexToBytes(payload.data);

    const decipher = forge.cipher.createDecipher('AES-GCM', forgeKey);
    decipher.start({ iv: ivBytes, tagLength: 128, tag: tagBuffer });
    decipher.update(forge.util.createBuffer(encryptedBytes));

    const authenticated = decipher.finish();
    if (!authenticated) {
        throw new Error('[CRYPTO] Falha na autenticação AES-256-GCM (Forge).');
    }

    const decryptedStr = decipher.output.toString('utf8');
    try {
        return JSON.parse(decryptedStr);
    } catch {
        return decryptedStr;
    }
}

module.exports = {
    encrypt,
    decrypt,
    encryptCredentials,
    decryptCredentials,
    isEncrypted,
    maskCredentials,
    encryptWithForge,
    decryptWithForge
};
