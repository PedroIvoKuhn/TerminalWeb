const path = require('path');
const fs = require('fs');
const lti = require('ltijs').Provider;

// Função privada

function renderTemplate(res, userName, image, ltiToken, userId = '', platformId = '') {
    const templatePath = path.join(__dirname, '../views', 'index.html');

    fs.readFile(templatePath, 'utf8', (err, html) => {
        if (err) return res.status(500).send("Erro ao carregar index.html.");

        let finalHtml = html.replace('{{NOME_USUARIO}}', userName);
        finalHtml = finalHtml.replaceAll('{{IMAGE}}', image);
        finalHtml = finalHtml.replaceAll('{{USER_ID}}', userId);
        finalHtml = finalHtml.replaceAll('{{PLATFORM_ID}}', platformId);

        const maxUpload = parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 30;
        const maxStorage = parseInt(process.env.MAX_STUDENT_STORAGE_MB, 10) || 100;
        const scriptToken = `<script>
            window.LTI_TOKEN = "${ltiToken || ''}";
            window.USER_ID = "${userId || ''}";
            window.PLATFORM_ID = "${platformId || ''}";
            window.MAX_UPLOAD_SIZE_MB = ${maxUpload};
            window.MAX_STUDENT_STORAGE_MB = ${maxStorage};
        </script>`;
        finalHtml = finalHtml.replace('</head>', `${scriptToken}\n</head>`);
        res.send(finalHtml);
    });
}

// Função principal

async function setup(app) {
    if (process.env.NODE_ENV === "development"){
        app.get('/', (req, res) => {
            const userName = "userDev";
            const image = process.env.DEFAULT_MPI_IMAGE;
            if (req.session) {
                req.session.userId = 'devUser';
                req.session.platformId = 'devPlatform';
            }
            renderTemplate(res, userName, image, '', 'devUser', 'devPlatform');
        });
        
        app.get('/how-use', (req, res) => {
            const documentationPath = path.join(__dirname, '../views', 'howUse.html');
            res.sendFile(documentationPath);
        });
        return;
    }

    // Inicia o LTI
    await lti.setup(process.env.LTI_ENCRYPTION_KEY,
        {
            url: process.env.MONGO_DB_URI,
            connection: {
                useNewUrlParser: true,
                useUnifiedTopology: true
            }
        },
        {
            staticPath: path.join(__dirname, '../public'),
            cookies: {
                secure: true,
                sameSite: 'None'
            },
            devMode: false
        }
    );

    await lti.deploy({port: process.env.PORT + 1});
    app.use(lti.app);
    app.get('/favicon.ico', (req, res) => res.status(204).end());

    await lti.registerPlatform({
        url: process.env.LTI_PLATFORM_URL,
        name: process.env.LTI_PLATFORM_NAME,
        clientId: process.env.LTI_CLIENT_ID,
        authenticationEndpoint: process.env.LTI_AUTH_ENDPOINT,
        accesstokenEndpoint: process.env.LTI_TOKEN_ENDPOINT,
        authConfig: {
            method: 'JWK_SET',
            key: process.env.LTI_KEYSET_ENDPOINT
        }
    });

    lti.onConnect(async (token, req, res) => {
        req.session.userId = token.user;
        req.session.platformId = token.platformId || token.clientId || 'moodle';
        req.session.save();

        return lti.redirect(res, "/home");
    });

    lti.onInvalidToken(async (req, res, next) => {
        if (req.url.includes('favicon.ico') || req.url.includes('socket.io')) {
            return next();
        }

        console.warn(`[LTI] Tentativa de acesso bloqueada (Token Inválido ou Acesso Direto).`);
    
        const unauthorizedPath = path.join(__dirname, '../views', 'unauthorized.html');
        return res.status(401).sendFile(unauthorizedPath);
    });

    lti.app.get('/home', (req, res) => {
        const ltiToken = res.locals.token;
        const tokenRaw = req.query.ltik;

        if (!ltiToken) return res.status(401).send("Sessão LTI não encontrada.")

        try {
            const userName = ltiToken.userInfo.name || 'Usuário Desconhecido';
            const userId = ltiToken.user;
            const platformId = ltiToken.platformId || ltiToken.clientId || 'moodle';

            req.session.userId = userId;
            req.session.platformId = platformId;
            req.session.save();

            let image = process.env.DEFAULT_MPI_IMAGE;
            const customParams = ltiToken.platformContext.custom;
            if (customParams && customParams.imagem && customParams.imagem.toLowerCase() !== 'default') {
                image = customParams.imagem;
            }

            renderTemplate(res, userName, image, tokenRaw, userId, platformId);
        } catch (err) {
            console.error("[LTI Error] Erro ao processar template:", err);
            res.status(500).send("Erro interno ao carregar a página.");
        }
    });

    lti.app.get('/how-use', (req, res) => {
        const documentationPath = path.join(__dirname, '../views', 'howUse.html');
        res.sendFile(documentationPath);
    });
}

module.exports = { setup };