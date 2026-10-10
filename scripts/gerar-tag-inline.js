// Gera o bloco <script> da tag das paginas para colar direto no <head> (sem depender do GTM).
// Uso: node scripts/gerar-tag-inline.js https://go.felipelona-vsl.com > tag-inline.html
const fs = require("node:fs");
const path = require("node:path");
const endpoint = String(process.argv[2] || "").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9.-]+$/i.test(endpoint)) { console.error("informe o endereco https do Oferta DR"); process.exit(1); }
const source = fs.readFileSync(path.join(__dirname, "..", "checkoutLinks.js"), "utf8");
if (!source.includes('"__DR_ENDPOINT__"')) { console.error("marcador do endereco nao encontrado na tag"); process.exit(1); }
const code = source.replace('"__DR_ENDPOINT__"', JSON.stringify(endpoint));
if (code.includes("</script")) { console.error("a tag nao pode conter </script>"); process.exit(1); }
process.stdout.write("<!-- Oferta DR: tag das paginas (v3) direto na pagina; nao depende do GTM -->\n<script>\n" + code.trim() + "\n</script>\n");
