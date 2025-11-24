// index.js
// Scraper CAIXA - Imóveis RO (fluxo WEB original: estado -> cidades -> lista -> detalhes -> XLSX)
//
// Mantém o fluxo original:
// 1) Abre a busca
// 2) Seleciona estado (RO)
// 3) Aguarda cidades carregarem via AJAX
// 4) Para cada cidade: avança etapas e coleta URLs
// 5) Para cada URL: abre detalhe e extrai metas
// 6) Gera JSON + XLSX
//
// Ajustes de robustez:
// - usa puppeteer (não puppeteer-core) -> roda em GitHub Actions sem Chrome fixo
// - CHROME_PATH opcional (pra usar Chrome local)
// - headless via ENV HEADLESS
// - wait real pro carregamento das cidades (options > 0)
// - normalização de labels (acentos/variações)
// - áreas aceitam '=' ou ':'
// - imagens com fallback data-src
// - waits mais confiáveis na paginação

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";
import * as XLSX from "xlsx";

const BASE_BUSCA_URL =
  "https://venda-imoveis.caixa.gov.br/sistema/busca-imovel.asp?sltTipoBusca=imoveis";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normaliza string para comparações (lowercase, sem acentos, espaços colapsados) */
function norm(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Fecha overlays/cookies se existir */
async function closeOverlays(page) {
  const selectors = [
    "#onetrust-accept-btn-handler",
    ".cookie-accept",
    ".close, .fechar, .btn-close",
  ];
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.click().catch(() => null);
      await delay(400);
    }
  }
}

/**
 * Seleciona estado e AGUARDA a lista de cidades carregar via AJAX
 */
async function selectEstadoAndWaitCidades(page, estado) {
  await page.waitForSelector("#cmb_estado", { timeout: 60000 });

  await page.select("#cmb_estado", estado);
  await page.evaluate((uf) => {
    const sel = document.querySelector("#cmb_estado");
    if (sel) {
      sel.value = uf;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, estado);

  // espera até existir pelo menos 1 cidade válida
  await page.waitForFunction(
    () => {
      const c = document.querySelector("#cmb_cidade");
      if (!c) return false;
      const opts = Array.from(c.options || []).filter(
        (o) => o.value && o.value !== "0" && (o.textContent || "").trim()
      );
      return opts.length > 0;
    },
    { timeout: 60000 }
  );
}

/** Lê cidades do select */
async function getCidades(page) {
  return await page.evaluate(() => {
    const sel = document.querySelector("#cmb_cidade");
    if (!sel) return [];
    const opts = Array.from(sel.querySelectorAll("option"));
    return opts
      .map((o) => ({
        value: o.value,
        text: (o.textContent || "").trim(),
      }))
      .filter((o) => o.value && o.value !== "0");
  });
}

/**
 * Extrai os detalhes de um imóvel na página de detalhe-imovel.asp
 */
async function extrairDetalhesImovel(page, url, meta) {
  const { estado = "RO", cidadeCodigo = "", cidadeNome = "" } = meta || {};
  console.log(`   🏠 Detalhes: ${url}`);

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });
    await page.waitForSelector("#dadosImovel", { timeout: 60000 });

    const dados = await page.evaluate((estado, cidadeCodigo, cidadeNome) => {
      const safeText = (el) =>
        el && (el.innerText || el.textContent)
          ? (el.innerText || el.textContent).trim()
          : "";

      const norm = (s) =>
        (s || "")
          .toString()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      /* 1) Nome / ID */
      const dadosImovel = document.querySelector("#dadosImovel");
      let tituloImovel = "";
      let codigoImovel = "";

      if (dadosImovel) {
        const h5 = dadosImovel.querySelector("h5");
        if (h5) {
          const firstNode = h5.firstChild;
          if (firstNode && firstNode.nodeType === Node.TEXT_NODE) {
            tituloImovel = (firstNode.textContent || "").trim();
          } else {
            tituloImovel = safeText(h5);
          }
        }
      }

      const hdnimovel = document.querySelector("#hdnimovel");
      if (hdnimovel && hdnimovel.value) {
        codigoImovel = hdnimovel.value.trim();
      }

      /* 2) Valores */
      let valorAvaliacao = "";
      let valorMinimo1 = "";
      let valorMinimo2 = "";
      let valorMinimoGenerico = "";
      let valorMinimoGeral = "";
      let descontoPercentual = "";

      if (dadosImovel) {
        const pValores = Array.from(
          dadosImovel.querySelectorAll(".content p")
        ).find((p) =>
          (p.innerText || "").toUpperCase().includes("VALOR DE AVALIAÇÃO")
        );

        if (pValores) {
          const text = (pValores.innerText || "").replace(/\s+/g, " ").trim();

          const matchAval = text.match(
            /Valor de avaliação:\s*R\$\s*([\d\.,]+)/i
          );
          const matchMin1 = text.match(
            /Valor mínimo de venda\s*1º Leilão:\s*R\$\s*([\d\.,]+)/i
          );
          const matchMin2 = text.match(
            /Valor mínimo de venda\s*2º Leilão:\s*R\$\s*([\d\.,]+)/i
          );
          const matchMinGeneric = text.match(
            /Valor mínimo de venda:\s*R\$\s*([\d\.,]+)/i
          );

          if (matchAval) valorAvaliacao = matchAval[1].trim();
          if (matchMin1) valorMinimo1 = matchMin1[1].trim();
          if (matchMin2) valorMinimo2 = matchMin2[1].trim();
          if (!matchMin1 && !matchMin2 && matchMinGeneric) {
            valorMinimoGenerico = matchMinGeneric[1].trim();
          }

          const parseBRL = (s) => {
            const only = (s || "")
              .replace(/[^\d,.-]/g, "")
              .replace(/\./g, "")
              .replace(",", ".");
            const n = parseFloat(only);
            return Number.isNaN(n) ? null : n;
          };

          const vAval = parseBRL(valorAvaliacao);
          const vMin1 = parseBRL(valorMinimo1);
          const vMin2 = parseBRL(valorMinimo2);
          const vMinGen = parseBRL(valorMinimoGenerico);

          const candidatos = [vMin1, vMin2, vMinGen].filter(
            (v) => v !== null
          );

          let vMinGeral = null;
          if (candidatos.length > 0) {
            vMinGeral = Math.min(...candidatos);
            valorMinimoGeral = vMinGeral.toFixed(2).replace(".", ",");
          }

          if (vAval !== null && vMinGeral !== null && vAval > 0) {
            let desc = ((vAval - vMinGeral) / vAval) * 100;
            if (desc < 0) desc = 0;
            descontoPercentual = `${desc.toFixed(2).replace(".", ",")}%`;
          }
        }
      }

      /* 3) Dados principais */
      const colInfo1 = document.querySelectorAll(
        "#dadosImovel .content .control-item.control-span-6_12"
      )[0];

      let tipoImovel = "";
      let quartos = "";
      let garagem = "";
      let numeroImovelStr = "";
      let matricula = "";
      let comarca = "";
      let oficio = "";
      let inscricaoImobiliaria = "";
      let averbacaoLeiloes = "";

      if (colInfo1) {
        const spans = Array.from(colInfo1.querySelectorAll("span")).map((s) =>
          (s.innerText || "").trim()
        );

        const getValueAfterLabel = (arr, label) => {
          const lab = norm(label);
          const row = arr.find((t) => {
            const n = norm(t);
            return n.startsWith(lab) || n.includes(lab);
          });
          if (!row) return "";
          const parts = row.split(":");
          return parts[1] ? parts[1].trim() : "";
        };

        tipoImovel = getValueAfterLabel(spans, "Tipo de imóvel");
        quartos = getValueAfterLabel(spans, "Quartos");
        garagem = getValueAfterLabel(spans, "Garagem");
        numeroImovelStr = getValueAfterLabel(spans, "Número do imóvel");
        matricula = getValueAfterLabel(spans, "Matrícula");
        comarca = getValueAfterLabel(spans, "Comarca");
        oficio = getValueAfterLabel(spans, "Ofício");
        inscricaoImobiliaria = getValueAfterLabel(
          spans,
          "Inscrição imobiliária"
        );
        averbacaoLeiloes = getValueAfterLabel(
          spans,
          "Averbação dos leilões negativos"
        );
      }

      /* 4) Áreas */
      const colInfo2 = document.querySelectorAll(
        "#dadosImovel .content .control-item.control-span-6_12"
      )[1];

      let areaTotal = "";
      let areaPrivativa = "";
      let areaTerreno = "";

      if (colInfo2) {
        const spans2 = Array.from(colInfo2.querySelectorAll("span")).map((s) =>
          (s.innerText || "").trim()
        );

        const getValueAfterEqOrColon = (arr, label) => {
          const lab = norm(label);
          const row = arr.find((t) => {
            const n = norm(t);
            return n.startsWith(lab) || n.includes(lab);
          });
          if (!row) return "";
          const parts = row.includes("=") ? row.split("=") : row.split(":");
          return parts[1]
            ? parts[1].replace(/^\s*\*?\s*/, "").trim()
            : "";
        };

        areaTotal = getValueAfterEqOrColon(spans2, "Área total");
        areaPrivativa = getValueAfterEqOrColon(spans2, "Área privativa");
        areaTerreno = getValueAfterEqOrColon(spans2, "Área do terreno");
      }

      /* 5) Related-box */
      const relatedBox = document.querySelector(".related-box");

      let tipoLeilao = "";
      let editalTexto = "";
      let numeroItem = "";
      let leiloeiro = "";
      let dataLeilao1 = "";
      let dataLeilao2 = "";
      let enderecoCompleto = "";
      let descricao = "";
      let formasPagamento = "";
      let linkMatricula = "";
      let linkEdital = "";

      if (relatedBox) {
        const tipoNode =
          relatedBox.querySelector("#divContador .control-span-12_12 span b") ||
          relatedBox.querySelector("#divContador b") ||
          relatedBox.querySelector("div span b");

        if (tipoNode) tipoLeilao = safeText(tipoNode);

        const spansRel = Array.from(relatedBox.querySelectorAll("span"));
        spansRel.forEach((span) => {
          const raw = span.innerText || span.textContent || "";
          const t = raw.replace(/\s+/g, " ").trim();
          const tn = t.toUpperCase();

          if (tn.startsWith("EDITAL")) {
            editalTexto = t.replace(/^Edital:\s*/i, "").trim();
          } else if (tn.startsWith("LEILOEIRO")) {
            leiloeiro = t.replace(/^Leiloeiro(?:\(a\))?:\s*/i, "").trim();
          } else if (tn.startsWith("NÚMERO DO ITEM") || tn.startsWith("NUMERO DO ITEM")) {
            numeroItem = t.replace(/^Número do item:\s*/i, "").trim();
          } else if (t.includes("Data do 1º Leilão") || t.includes("Data do 1o Leilão")) {
            dataLeilao1 = t;
          } else if (t.includes("Data do 2º Leilão") || t.includes("Data do 2o Leilão")) {
            dataLeilao2 = t;
          }
        });

        const pList = Array.from(relatedBox.querySelectorAll("p"));
        pList.forEach((p) => {
          const txt = (p.innerText || "").trim();
          if (txt.startsWith("Endereço:") || txt.startsWith("Endereco:")) {
            enderecoCompleto = txt.replace(/^Endere[cç]o:\s*/i, "").trim();
          } else if (txt.startsWith("Descrição:") || txt.startsWith("Descricao:")) {
            descricao = txt.replace(/^Descri[cç][aã]o:\s*/i, "").trim();
          } else if (txt.includes("FORMAS DE PAGAMENTO ACEITAS")) {
            formasPagamento = txt;
          }
        });

        const linkMat = relatedBox.querySelector(
          "a[onclick*='ExibeDoc'][onclick*='/matricula/']"
        );
        if (linkMat) {
          const onclick = linkMat.getAttribute("onclick") || "";
          const m = onclick.match(/ExibeDoc\(['"]([^'"]+)['"]\)/i);
          if (m) {
            const rel = m[1];
            try {
              linkMatricula = new URL(rel, window.location.origin).href;
            } catch {
              linkMatricula = rel;
            }
          }
        }
      }

      if (!linkMatricula) {
        const linkMatGlobal = document.querySelector(
          "a[onclick*='ExibeDoc'][onclick*='/matricula/']"
        );
        if (linkMatGlobal) {
          const onclick = linkMatGlobal.getAttribute("onclick") || "";
          const m = onclick.match(/ExibeDoc\(['"]([^'"]+)['"]\)/i);
          if (m) {
            const rel = m[1];
            try {
              linkMatricula = new URL(rel, window.location.origin).href;
            } catch {
              linkMatricula = rel;
            }
          }
        }
      }

      const editalAnchor = Array.from(
        document.querySelectorAll("a[onclick*='ExibeDoc']")
      ).find((a) => {
        const txt = (a.textContent || "").toUpperCase();
        return txt.includes("BAIXAR EDITAL");
      });

      if (editalAnchor) {
        const onclick = editalAnchor.getAttribute("onclick") || "";
        const m = onclick.match(/ExibeDoc\(['"]([^'"]+)['"]\)/i);
        if (m) {
          const rel = m[1];
          try {
            linkEdital = new URL(rel, window.location.origin).href;
          } catch {
            linkEdital = rel;
          }
        }
      }

      /* 5.3) Quebra do endereço */
      let enderecoLogradouro = "";
      let enderecoNumero = "";
      let enderecoBairroTexto = "";
      let enderecoCep = "";
      let enderecoCidadeTexto = "";
      let enderecoEstadoTexto = "";

      if (enderecoCompleto) {
        let e = enderecoCompleto;

        const cepMatch = e.match(/CEP:\s*([\d\-]+)/i);
        if (cepMatch) {
          enderecoCep = cepMatch[1].trim();
          e = e.replace(cepMatch[0], "").replace(/\s*,\s*$/, "");
        }

        const parts = e
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);

        if (parts.length >= 1) enderecoLogradouro = parts[0];

        if (parts.length >= 2) {
          const numParte = parts[1];
          const mNum = numParte.match(/N[º.]?\s*([\d]+)/i);
          if (mNum) enderecoNumero = mNum[1].trim();
        }

        if (parts.length >= 3) {
          let b = parts[2];
          b = b.replace(/\-\s*$/i, "").trim();
          enderecoBairroTexto = b;
        }

        if (parts.length >= 4) {
          const ultima = parts[parts.length - 1];
          const mCidadeUf = ultima.match(/^(.+?)\s*-\s*([A-Z]{2})$/i);
          if (mCidadeUf) {
            enderecoCidadeTexto = mCidadeUf[1].trim();
            enderecoEstadoTexto = mCidadeUf[2].toUpperCase();
          } else {
            enderecoCidadeTexto = ultima;
          }
        }
      }

      /* 6) Imagens com fallback lazy */
      const thumbs = Array.from(
        document.querySelectorAll("#galeria-imagens .thumbnails img")
      );
      const imgsLista = thumbs
        .map((img) => {
          const src =
            img.src ||
            img.dataset?.src ||
            img.getAttribute("data-src") ||
            img.getAttribute("data-original");
          if (!src) return "";
          try {
            return new URL(src, window.location.origin).href;
          } catch {
            return src;
          }
        })
        .filter(Boolean);

      /* 7) Estado / cidade / bairro */
      let estadoCod = "";
      let cidadeCod = "";
      let cidadeNomeFinal = "";
      let bairroFinal = "";

      const hEstado = document.querySelector("#hdn_estado");
      const hCidade = document.querySelector("#hdn_cidade");
      const hBairro = document.querySelector("#hdn_bairro");

      if (hEstado && hEstado.value) estadoCod = hEstado.value.trim();
      else if (estado) estadoCod = estado;

      if (hCidade && hCidade.value) cidadeCod = hCidade.value.trim();
      else if (cidadeCodigo) cidadeCod = cidadeCodigo;

      if (hBairro && hBairro.value) bairroFinal = hBairro.value.trim();
      else if (enderecoBairroTexto) bairroFinal = enderecoBairroTexto;

      if (cidadeNome) cidadeNomeFinal = cidadeNome;
      else if (enderecoCidadeTexto) cidadeNomeFinal = enderecoCidadeTexto;

      return {
        _imoveis_codigo_imovel: codigoImovel,
        _imoveis_titulo: tituloImovel,

        _imoveis_valor_avaliacao: valorAvaliacao,
        _imoveis_valor_minimo_1_leilao: valorMinimo1,
        _imoveis_valor_minimo_2_leilao: valorMinimo2,
        _imoveis_valor_minimo_generico: valorMinimoGenerico,
        _imoveis_valor_minimo: valorMinimoGeral,
        _imoveis_desconto_percentual: descontoPercentual,
        _imoveis_desconto_pct: descontoPercentual,

        _imoveis_tipo_imovel: tipoImovel,
        _imoveis_quartos: quartos,
        _imoveis_garagem: garagem,
        _imoveis_numero_imovel: numeroImovelStr,
        _imoveis_matricula: matricula,
        _imoveis_comarca: comarca,
        _imoveis_oficio: oficio,
        _imoveis_inscricao_imobiliaria: inscricaoImobiliaria,
        _imoveis_averbacao_leiloes: averbacaoLeiloes,

        _imoveis_area_total: areaTotal,
        _imoveis_area_privativa: areaPrivativa,
        _imoveis_area_terreno: areaTerreno,

        _imoveis_tipo_leilao: tipoLeilao,
        _imoveis_edital: editalTexto,
        _imoveis_leiloeiro: leiloeiro,
        _imoveis_numero_item: numeroItem,
        _imoveis_data_leilao_1: dataLeilao1,
        _imoveis_data_leilao_2: dataLeilao2,

        _imoveis_endereco_completo: enderecoCompleto,
        _imoveis_endereco_logradouro: enderecoLogradouro,
        _imoveis_endereco_numero: enderecoNumero,
        _imoveis_endereco_bairro_texto: enderecoBairroTexto,
        _imoveis_endereco_cidade_texto: enderecoCidadeTexto,
        _imoveis_endereco_estado_texto: enderecoEstadoTexto,
        _imoveis_cep: enderecoCep,

        _imoveis_descricao: descricao,
        _imoveis_formas_pagamento: formasPagamento,
        _imoveis_link_matricula: linkMatricula,
        _imoveis_link_edital: linkEdital,

        _imoveis_imgs_lista: imgsLista.join("|"),

        _imoveis_estado: estadoCod,
        _imoveis_cidade_codigo: cidadeCod,
        _imoveis_cidade: cidadeNomeFinal,
        _imoveis_bairro: bairroFinal,
      };
    }, estado, cidadeCodigo, cidadeNome);

    return dados;
  } catch (err) {
    console.error(`      ❌ Erro ao extrair ${url}:`, err.message);
    return null;
  }
}

/**
 * Coleta todas as URLs de imóveis da cidade atual com paginação
 */
async function coletarUrlsCidade(page) {
  console.log("   🔗 Coletando URLs de imóveis da cidade atual...");

  const totalPages = await page.evaluate(() => {
    const hdnQtdPag = document.querySelector("#hdnQtdPag");
    if (!hdnQtdPag || !hdnQtdPag.value) return 1;
    const n = parseInt(hdnQtdPag.value, 10);
    return Number.isNaN(n) || n <= 0 ? 1 : n;
  });

  const urlsSet = new Set();

  for (let p = 1; p <= totalPages; p++) {
    if (p > 1) {
      console.log(`      👉 Carregando página ${p}/${totalPages}...`);
      await page.evaluate((pagina) => {
        if (typeof window.carregaListaImoveis === "function") {
          window.carregaListaImoveis(pagina);
        }
      }, p);

      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            "#listaimoveispaginacao .group-block-item"
          ).length > 0,
        { timeout: 60000 }
      ).catch(() => delay(2500));
    }

    const urls = await page.evaluate(() => {
      const items = Array.from(
        document.querySelectorAll("#listaimoveispaginacao .group-block-item")
      );

      const list = [];
      items.forEach((it) => {
        const link = it.querySelector("a[onclick*='detalhe_imovel']");
        if (!link) return;
        const onclick = link.getAttribute("onclick") || "";
        const m = onclick.match(/detalhe_imovel\((\d+)\)/);
        if (!m) return;

        const idImovel = m[1];
        const urlDet = `https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=${idImovel}`;
        list.push(urlDet);
      });
      return list;
    });

    urls.forEach((u) => urlsSet.add(u));
  }

  return Array.from(urlsSet);
}

/**
 * Exporta todos os detalhes em um único XLSX
 */
function salvarComoXlsx(detalhes, filename) {
  const campos = [
    "_imoveis_codigo_imovel",
    "_imoveis_titulo",
    "_imoveis_valor_avaliacao",
    "_imoveis_valor_minimo_1_leilao",
    "_imoveis_valor_minimo_2_leilao",
    "_imoveis_valor_minimo_generico",
    "_imoveis_valor_minimo",
    "_imoveis_desconto_percentual",
    "_imoveis_desconto_pct",
    "_imoveis_tipo_imovel",
    "_imoveis_quartos",
    "_imoveis_garagem",
    "_imoveis_numero_imovel",
    "_imoveis_matricula",
    "_imoveis_comarca",
    "_imoveis_oficio",
    "_imoveis_inscricao_imobiliaria",
    "_imoveis_averbacao_leiloes",
    "_imoveis_area_total",
    "_imoveis_area_privativa",
    "_imoveis_area_terreno",
    "_imoveis_tipo_leilao",
    "_imoveis_edital",
    "_imoveis_leiloeiro",
    "_imoveis_numero_item",
    "_imoveis_data_leilao_1",
    "_imoveis_data_leilao_2",
    "_imoveis_endereco_completo",
    "_imoveis_endereco_logradouro",
    "_imoveis_endereco_numero",
    "_imoveis_endereco_bairro_texto",
    "_imoveis_endereco_cidade_texto",
    "_imoveis_endereco_estado_texto",
    "_imoveis_cep",
    "_imoveis_descricao",
    "_imoveis_formas_pagamento",
    "_imoveis_link_matricula",
    "_imoveis_link_edital",
    "_imoveis_imgs_lista",
    "_imoveis_estado",
    "_imoveis_cidade_codigo",
    "_imoveis_cidade",
    "_imoveis_bairro",
  ];

  const sanitize = (value) => {
    if (value == null) return "";
    return String(value)
      .replace(/\r?\n|\r/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  const rows = detalhes.map((det) => {
    const row = {};
    campos.forEach((campo) => {
      row[campo] = sanitize(det[campo]);
    });
    return row;
  });

  const ws = XLSX.utils.json_to_sheet(rows, { header: campos });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Imoveis_RO");

  XLSX.writeFile(wb, filename);
  console.log(`💾 XLSX salvo em: ${filename}`);
}

/**
 * Fluxo principal (igual ao original)
 */
export async function runScrape() {
  const headless = process.env.HEADLESS !== "false";
  const chromePath = process.env.CHROME_PATH || undefined;

  const browser = await puppeteer.launch({
    headless: headless ? "new" : false,
    executablePath: chromePath, // opcional local
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    defaultViewport: { width: 1366, height: 768 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  console.log("🚀 Iniciando scraper CAIXA (RO)...");

  // 1) Acessa a busca
  await page.goto(BASE_BUSCA_URL, {
    waitUntil: "networkidle2",
    timeout: 120000,
  });
  await closeOverlays(page);

  // 2) Seleciona estado e aguarda cidades
  await selectEstadoAndWaitCidades(page, "RO");
  await delay(1000);

  // 3) Lê cidades
  const cidades = await getCidades(page);
  console.log(`📌 Encontradas ${cidades.length} cidades em RO.`);

  const urlsPorCidade = {};

  // 4) Para cada cidade: refaz busca e coleta URLs
  for (const cidade of cidades) {
    console.log(`\n🌆 Cidade: [${cidade.text}] (${cidade.value})`);

    try {
      await page.goto(BASE_BUSCA_URL, {
        waitUntil: "networkidle2",
        timeout: 120000,
      });
      await closeOverlays(page);

      await selectEstadoAndWaitCidades(page, "RO");
      await delay(800);

      // seleciona cidade
      await page.evaluate((cidadeValue) => {
        const cmbCidade = document.querySelector("#cmb_cidade");
        if (cmbCidade) {
          cmbCidade.value = cidadeValue;
          cmbCidade.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, cidade.value);

      await delay(1500);

      const btnNext0 = await page.$("#btn_next0");
      if (btnNext0) {
        await btnNext0.click();
        await page
          .waitForFunction(
            () =>
              document.querySelector("#btn_next1") ||
              document.querySelector("#listaimoveispaginacao") ||
              document.querySelector("#divImoveisLista"),
            { timeout: 120000 }
          )
          .catch(() =>
            console.warn("   ⚠️ Timeout após btn_next0.")
          );
      }

      const btnNext1 = await page.$("#btn_next1");
      if (btnNext1) await btnNext1.click();

      await page
        .waitForFunction(
          () =>
            document.querySelector("#listaimoveispaginacao .group-block-item") ||
            document.body.innerText
              .toUpperCase()
              .includes("NENHUM IMÓVEL ENCONTRADO"),
          { timeout: 120000 }
        )
        .catch(() =>
          console.warn("   ⚠️ Timeout aguardando lista/mensagem.")
        );

      const temImoveis = await page.evaluate(() => {
        return (
          document.querySelectorAll(
            "#listaimoveispaginacao .group-block-item"
          ).length > 0
        );
      });

      if (!temImoveis) {
        console.log(`  ⚠️ Nenhum imóvel encontrado para ${cidade.text}.`);
        urlsPorCidade[cidade.value] = { cidade: cidade.text, urls: [] };
        continue;
      }

      const urls = await coletarUrlsCidade(page);
      console.log(`  ✅ ${urls.length} imóveis encontrados em ${cidade.text}`);

      urlsPorCidade[cidade.value] = { cidade: cidade.text, urls };
    } catch (erroCidade) {
      console.error(
        `  ❌ Erro ao processar cidade ${cidade.text}:`,
        erroCidade.message
      );
      urlsPorCidade[cidade.value] = { cidade: cidade.text, urls: [] };
    }
  }

  // JSON intermediário
  const jsonPath = path.join(process.cwd(), "urls_ro_por_cidade.json");
  fs.writeFileSync(jsonPath, JSON.stringify(urlsPorCidade, null, 2), "utf-8");
  console.log(`\n💾 JSON de URLs salvo em: ${jsonPath}`);

  // 5) Detalhes
  const detalhes = [];

  for (const [codCidade, infoCidade] of Object.entries(urlsPorCidade)) {
    const { cidade: nomeCidade, urls } = infoCidade;
    console.log(
      `\n🏙  Extraindo detalhes da cidade: ${nomeCidade} (${codCidade})`
    );

    if (!urls || urls.length === 0) {
      console.log("   ⚠️ Não há URLs para esta cidade.");
      continue;
    }

    for (const u of urls) {
      const det = await extrairDetalhesImovel(page, u, {
        estado: "RO",
        cidadeCodigo: codCidade,
        cidadeNome: nomeCidade,
      });
      if (det) {
        detalhes.push(det);
        console.log("      ✅ OK");
      } else {
        console.log("      ⚠️ Retorno vazio ao extrair detalhes");
      }
      await delay(1500);
    }
  }

  // XLSX
  const xlsxPath = path.join(process.cwd(), "imoveis_ro_detalhes.xlsx");
  salvarComoXlsx(detalhes, xlsxPath);

  await browser.close();
  console.log("🏁 Scraper finalizado.");
  return { urlsPorCidade, detalhes, jsonPath, xlsxPath };
}

/** Detecção de main (Windows-friendly) */
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runScrape().catch((err) => {
    console.error("Erro geral no scraper:", err);
    process.exit(1);
  });
}
