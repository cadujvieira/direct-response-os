// Zera os dados de movimento (cliques, leads, eventos, vendas, avisos da Hubla, historicos) e MANTEM a configuracao
// (rotas e paginas do router, regras de automacao, custos do CPA, ligacao da UTMify, segmentos salvos).
// Uso previsto: uma unica vez, antes de a operacao real comecar, para tirar do painel os dados de teste.
//
//   node scripts/zerar-dados-de-teste.js                 -> so mostra o que existe; nao apaga nada
//   node scripts/zerar-dados-de-teste.js --apagar-tudo   -> apaga, depois de digitar a frase de confirmacao
//
// A exclusao e definitiva. Faca antes uma copia do banco no Render (banco > Recovery).
// Trava de seguranca: se ja houver volume de operacao real, o script se recusa a apagar.
require("dotenv").config();
const readline = require("node:readline");
const { Pool } = require("pg");

const WIPE = ["dr_funnel_receipts", "dr_funnel_orders", "dr_experiment_assignments", "dr_activation_export_leads",
  "dr_activation_exports", "dr_automation_runs", "dr_crm_followups", "dr_lead_crm_history", "dr_hubla_events",
  "dr_events", "dr_orders", "dr_leads", "dr_clicks", "dr_ad_spend", "dr_utmify_ad_objects", "dr_utmify_syncs", "dr_monitor_log"];
const KEEP = ["dr_experiments", "dr_experiment_variants", "dr_automation_rules", "dr_cpa_settings", "dr_utmify_connection",
  "dr_crm_saved_segments"];
const PHRASE = "APAGAR DADOS DE TESTE";
// Acima disto o banco ja tem cara de operacao real: nao e mais "dado de teste".
const LIMITS = { dr_orders: 20, dr_clicks: 2000 };

async function counts(db, tables) {
  const out = {};
  for (const table of tables) {
    const found = (await db.query("SELECT to_regclass($1) AS t", ["public." + table])).rows[0].t;
    out[table] = found ? (await db.query("SELECT COUNT(*)::int AS n FROM " + table)).rows[0].n : null;
  }
  return out;
}
function show(title, data) {
  console.log("\n" + title);
  for (const [table, n] of Object.entries(data)) console.log("  " + table.padEnd(30) + (n == null ? "(tabela nao existe)" : n));
}
const ask = question => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, answer => { rl.close(); resolve(answer); });
});

async function main({ argv = process.argv.slice(2), env = process.env, confirm = ask } = {}) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL nao configurada");
  const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false });
  try {
    const before = await counts(pool, WIPE), kept = await counts(pool, KEEP);
    // Qualquer tabela nova que ninguem classificou interrompe tudo: melhor parar do que apagar ou esquecer algo.
    const all = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map(r => r.table_name);
    const unknown = all.filter(table => !WIPE.includes(table) && !KEEP.includes(table));
    show("Sera APAGADO (dados de movimento):", before);
    show("Sera MANTIDO (configuracao):", kept);
    if (unknown.length) { console.log("\nTabelas nao classificadas: " + unknown.join(", ") + ". Nada foi apagado. Atualize o script antes de usar."); return 2; }
    if (!argv.includes("--apagar-tudo")) { console.log("\nNada foi apagado. Para apagar: node scripts/zerar-dados-de-teste.js --apagar-tudo"); return 0; }
    const over = Object.entries(LIMITS).filter(([table, max]) => (before[table] || 0) > max);
    if (over.length) {
      console.log("\nRECUSADO: o banco ja tem volume de operacao real (" + over.map(([t]) => t + " = " + before[t]).join(", ") + "). Nada foi apagado.");
      return 3;
    }
    const answer = await confirm("\nA exclusao e definitiva. Digite exatamente " + PHRASE + " para confirmar: ");
    if (String(answer).trim() !== PHRASE) { console.log("Frase diferente. Nada foi apagado."); return 1; }
    const existing = WIPE.filter(table => before[table] != null);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Sem CASCADE: se alguma tabela fora da lista depender destas, o banco recusa em vez de apagar a mais.
      await client.query("TRUNCATE TABLE " + existing.join(", ") + " RESTART IDENTITY");
      const config = await counts(client, KEEP);
      if (JSON.stringify(config) !== JSON.stringify(kept)) throw new Error("a configuracao mudou durante a limpeza");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    show("Depois da limpeza:", await counts(pool, WIPE));
    show("Configuracao mantida:", await counts(pool, KEEP));
    console.log("\nPronto. Os dados de movimento foram zerados e a configuracao foi mantida.");
    return 0;
  } finally { await pool.end(); }
}
if (require.main === module) main().then(code => process.exit(code)).catch(error => { console.error("Falhou, nada foi apagado: " + error.message); process.exit(1); });
module.exports = { main, WIPE, KEEP, PHRASE, LIMITS };
