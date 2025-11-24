// sync-wp.js
// Envia os resultados do scraper para o WordPress.
// Requer que seu plugin tenha um endpoint de importação, por exemplo:
//   POST /wp-json/imoveis/v1/import
//
// Secrets no GitHub Actions:
//   WP_URL   -> https://seusite.com
//   WP_TOKEN -> JWT Bearer token ou Application Password (ver comentário abaixo)

import fs from "node:fs";

const WP_URL = process.env.WP_URL;
const WP_TOKEN = process.env.WP_TOKEN;

if (!WP_URL || !WP_TOKEN) {
  console.error("❌ Defina WP_URL e WP_TOKEN nas variáveis de ambiente.");
  process.exit(1);
}

// carrega o JSON gerado pelo scraper (ajuste o nome se mudar de estado)
const jsonFile = fs
  .readdirSync(process.cwd())
  .find((f) => f.startsWith("urls_") && f.endsWith("_por_cidade.json"));

if (!jsonFile) {
  console.error("❌ JSON de URLs não encontrado. Rode o scraper antes.");
  process.exit(1);
}

const urlsPorCidade = JSON.parse(fs.readFileSync(jsonFile, "utf8"));

// Se preferir enviar os detalhes também:
const xlsxFile = fs
  .readdirSync(process.cwd())
  .find((f) => f.startsWith("imoveis_") && f.endsWith("_detalhes.xlsx"));

console.log(`📤 Enviando dados para WP: ${WP_URL}`);
console.log(`   JSON: ${jsonFile}`);
if (xlsxFile) console.log(`   XLSX: ${xlsxFile}`);

// Envio principal (JSON)
const res = await fetch(`${WP_URL}/wp-json/imoveis/v1/import`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${WP_TOKEN}`
  },
  body: JSON.stringify({
    urlsPorCidade
  })
});

const text = await res.text();
if (!res.ok) {
  console.error("❌ Erro no import WP:", text);
  process.exit(1);
}

console.log("✅ Import WP OK:", text);

/**
 * Sobre autenticação:
 * - Mais simples: plugin JWT (token Bearer)
 * - Alternativa sem plugin: Application Passwords do WP
 *   -> use Basic Auth e troque o header acima para:
 *     "Authorization": "Basic " + Buffer.from("usuario:app_password").toString("base64")
 */