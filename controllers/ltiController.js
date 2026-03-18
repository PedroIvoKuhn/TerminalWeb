const path = require('path');
const fs = require('fs');
const lti = require('ltijs').Provider;

// Função privada

function renderTemplate(res, userName, image) {
    const templatePath = path.join(__dirname, '../views', 'index.html');

    fs.readFile(templatePath, 'utf8', (err, html) => {
        if (err) return res.status(500).send("Erro ao carregar index.html.");

        let finalHtml = html.replace('{{NOME_USUARIO}}', userName);
        finalHtml = finalHtml.replaceAll('{{IMAGE}}', image);
        res.send(finalHtml);
    });
}

// Função principal

async function setup(app) {
    if (process.env.NODE_ENV === "development"){
        app.get('/', (req, res) => {
            const userName = "userDev";
            const image = process.env.DEFAULT_MPI_IMAGE;
            renderTemplate(res, userName, image);
        });
        
        app.get('/documentation', (req, res) => {
            const documentationPath = path.join(__dirname, '../views', 'documentation.html');
            res.sendFile(documentationPath);
        });
        return;
    }

    app.get('/', (req, res) => {
        const unauthorizedPath = path.join(__dirname, '../views', 'unauthorized.html');
        res.sendFile(unauthorizedPath);
    });
    
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
            cookies: {
                secure: process.env.NODE_ENV === 'production',
                //secure: true, // Em produção sempre true
                sameSite: 'None'
            },
            devMode: process.env.NODE_ENV !== 'production'
            //devMode: false
        }
    );

    await lti.deploy({port: process.env.PORT + 1});
    app.use(lti.app);

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
        console.log('Usuário conectado:', token.user);
        const userName = token.user.name || 'Usuário Desconhecido';
        let image = process.env.DEFAULT_MPI_IMAGE;
 
        const custImagem = token.platformContext.custom ? token.platformContext.custom.imagem : undefined;
        if (custImagem && custImagem.toLowerCase() !== 'default') {              
            image = custImagem;
        }
        renderTemplate(res, userName, image);
    });
}

module.exports = { setup };