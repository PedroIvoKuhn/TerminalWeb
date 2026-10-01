document.addEventListener('DOMContentLoaded', () => {
    // Busca o token da URL atual se não foi injetado pelo servidor
    const urlParams = new URLSearchParams(window.location.search);
    const ltik = urlParams.get('ltik') || window.LTI_TOKEN;

    if (ltik) {
        // Atualiza todos os links que apontam para rotas internas
        const links = document.querySelectorAll('a[href^="/"]');
        links.forEach(link => {
            const url = new URL(link.href, window.location.origin);
            url.searchParams.set('ltik', ltik);
            link.href = url.pathname + url.search + url.hash;
        });
    }
});