const fs = require('fs');

const CHAVE = process.env.SERPAPI_KEY;
const SO_ID = (process.env.SO_ID || '').trim();
const LIMITE_MES = 240;

function ler(arquivo, padrao) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (e) { return padrao; }
}

async function serp(parametros) {
  const url = 'https://serpapi.com/search.json?' +
    new URLSearchParams({ ...parametros, api_key: CHAVE, hl: 'pt-br', gl: 'br' });
  const resposta = await fetch(url);
  const dados = await resposta.json();
  if (dados.error) throw new Error(dados.error);
  return dados;
}

async function buscarProduto(item, lojas) {
  const dados = await serp({ engine: 'google_shopping', q: item.termo });
  let ofertas = (dados.shopping_results || [])
    .map(p => ({
      titulo: p.title || '',
      loja: p.source || '',
      preco: p.extracted_price,
      link: p.product_link || p.link || ''
    }))
    .filter(p => typeof p.preco === 'number' && p.preco > 0);

  if (lojas.length) {
    ofertas = ofertas.filter(p => lojas.some(l => p.loja.toLowerCase().includes(l.toLowerCase())));
  }
  if (item.min) ofertas = ofertas.filter(p => p.preco >= item.min);
  if (item.max) ofertas = ofertas.filter(p => p.preco <= item.max);

  ofertas.sort((a, b) => a.preco - b.preco);
  return { ofertas: ofertas.slice(0, 8) };
}

async function buscarViagem(item) {
  const saida = { voos: [], hoteis: [], linkVoos: '' };
  const pessoas = String(item.pessoas || 1);

  try {
    const v = await serp({
      engine: 'google_flights', type: '1',
      departure_id: item.origem, arrival_id: item.destino,
      outbound_date: item.ida, return_date: item.volta,
      adults: pessoas, currency: 'BRL'
    });
    const todos = (v.best_flights || []).concat(v.other_flights || []);
    saida.voos = todos
      .filter(x => typeof x.price === 'number' && Array.isArray(x.flights) && x.flights.length)
      .map(x => ({
        cia: [...new Set(x.flights.map(f => f.airline))].join(' + '),
        preco: x.price,
        minutos: x.total_duration || 0,
        paradas: x.flights.length - 1,
        saida: (x.flights[0].departure_airport || {}).time || ''
      }))
      .sort((a, b) => a.preco - b.preco)
      .slice(0, 5);
    saida.linkVoos = (v.search_metadata || {}).google_flights_url || '';
  } catch (e) {
    saida.erroVoos = 'Voos: ' + e.message;
  }

  try {
    const h = await serp({
      engine: 'google_hotels', q: 'hotéis em ' + item.destinoNome,
      check_in_date: item.ida, check_out_date: item.volta,
      adults: pessoas, currency: 'BRL', sort_by: '3'
    });
    saida.hoteis = (h.properties || [])
      .map(p => ({
        nome: p.name || '',
        diaria: (p.rate_per_night || {}).extracted_lowest,
        total: (p.total_rate || {}).extracted_lowest,
        nota: p.overall_rating || null,
        link: p.link || ''
      }))
      .filter(p => typeof p.diaria === 'number')
      .sort((a, b) => a.diaria - b.diaria)
      .slice(0, 5);
  } catch (e) {
    saida.erroHoteis = 'Hotéis: ' + e.message;
  }

  return saida;
}

async function principal() {
  if (!CHAVE) throw new Error('Falta o segredo SERPAPI_KEY no repositório.');

  const lista = ler('buscas.json', { lojas: [], itens: [] });
  const precos = ler('precos.json', {});
  precos.resultados = precos.resultados || {};

  const mes = new Date().toISOString().slice(0, 7);
  if (!precos.uso || precos.uso.mes !== mes) precos.uso = { mes: mes, buscas: 0 };

  const itens = lista.itens || [];
  const alvo = SO_ID ? itens.filter(i => i.id === SO_ID) : itens;

  for (const item of alvo) {
    const custo = item.tipo === 'viagem' ? 2 : 1;
    if (precos.uso.buscas + custo > LIMITE_MES) {
      precos.resultados[item.id] = { erro: 'Limite de buscas do mês atingido.' };
      continue;
    }
    try {
      precos.resultados[item.id] = item.tipo === 'viagem'
        ? await buscarViagem(item)
        : await buscarProduto(item, lista.lojas || []);
    } catch (e) {
      precos.resultados[item.id] = { erro: e.message };
    }
    precos.uso.buscas += custo;
    console.log('Buscado:', item.termo || (item.origem + ' -> ' + item.destino));
  }

  // Remove resultados de itens que saíram da lista
  const idsValidos = new Set(itens.map(i => i.id));
  for (const id of Object.keys(precos.resultados)) {
    if (!idsValidos.has(id)) delete precos.resultados[id];
  }

  precos.atualizado = new Date().toISOString();
  fs.writeFileSync('precos.json', JSON.stringify(precos, null, 2));
}

principal().catch(e => { console.error(e); process.exit(1); });
