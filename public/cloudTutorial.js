document.addEventListener('DOMContentLoaded', () => {
    // 1. Propagação do token LTI (ltik) em links internos para manter a sessão no Moodle
    const urlParams = new URLSearchParams(window.location.search);
    const ltik = urlParams.get('ltik') || window.LTI_TOKEN;

    if (ltik) {
        const links = document.querySelectorAll('a[href^="/"]');
        links.forEach(link => {
            const url = new URL(link.href, window.location.origin);
            url.searchParams.set('ltik', ltik);
            link.href = url.pathname + url.search + url.hash;
        });
    }

    // 2. Gerenciamento dinâmico de abas com suporte a deep-link por hash (#aws ou #azure)
    const btnAws = document.getElementById('tab-btn-aws');
    const btnAzure = document.getElementById('tab-btn-azure');
    const paneAws = document.getElementById('content-aws');
    const paneAzure = document.getElementById('content-azure');

    function switchTab(provider) {
        if (!btnAws || !btnAzure || !paneAws || !paneAzure) return;
        const isAws = provider.toLowerCase() !== 'azure';

        btnAws.classList.toggle('active', isAws);
        btnAws.setAttribute('aria-selected', isAws ? 'true' : 'false');
        paneAws.classList.toggle('active', isAws);

        btnAzure.classList.toggle('active', !isAws);
        btnAzure.setAttribute('aria-selected', !isAws ? 'true' : 'false');
        paneAzure.classList.toggle('active', !isAws);

        // Atualiza o hash sem apagar os query params (?ltik=...)
        if (history.replaceState) {
            const hash = '#' + (isAws ? 'aws' : 'azure');
            history.replaceState(null, null, window.location.pathname + window.location.search + hash);
        }
    }

    if (btnAws && btnAzure) {
        btnAws.addEventListener('click', () => switchTab('aws'));
        btnAzure.addEventListener('click', () => switchTab('azure'));

        // Verifica o hash da URL ao carregar
        const hash = window.location.hash.toLowerCase();
        if (hash.includes('azure')) {
            switchTab('azure');
        } else {
            switchTab('aws');
        }

        window.addEventListener('hashchange', () => {
            const currentHash = window.location.hash.toLowerCase();
            if (currentHash.includes('azure')) {
                switchTab('azure');
            } else if (currentHash.includes('aws')) {
                switchTab('aws');
            }
        });
    }
});

// 3. Utilitário para copiar comandos dos blocos de código
function copyCode(btn) {
    const codeBox = btn.closest('.code-box');
    if (!codeBox) return;
    const code = codeBox.querySelector('code');
    if (!code) return;

    // Filtra comentários que iniciam com #
    const lines = code.innerText.split('\n').filter(line => !line.trim().startsWith('#'));
    const textToCopy = lines.join('\n').trim();

    navigator.clipboard.writeText(textToCopy).then(() => {
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '&#10003; Copiado!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.innerHTML = originalHtml;
            btn.classList.remove('copied');
        }, 2000);
    }).catch(err => {
        console.error('Erro ao copiar:', err);
    });
}

// Expõe globalmente para botões com onclick="copyCode(this)"
window.copyCode = copyCode;
