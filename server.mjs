// NewsHub — локальный сервер: RSS -> ИИ-отбор -> JSON. Без внешних npm-зависимостей.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ONCE = process.argv.includes('--once');
const DATA = process.env.NEWSHUB_DATA ? path.resolve(process.env.NEWSHUB_DATA) : path.join(ROOT, 'data');
const PUB = path.join(ROOT, 'public');
const PORT = Number(process.env.NEWSHUB_PORT || 8787);
const HOUR = 60 * 60 * 1000;
fs.mkdirSync(DATA, { recursive: true });

// ---------- конфиг LLM (ключ берём из Hermes .env, в проект не копируем) ----------
function readEnvFile(p) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}
const hermesEnv = readEnvFile(path.join(process.env.LOCALAPPDATA || '', 'hermes', '.env'));
const localEnv = readEnvFile(path.join(ROOT, '.env'));
const LLM = {
  base: process.env.LLM_BASE_URL || localEnv.LLM_BASE_URL || '',
  key: process.env.LLM_API_KEY || localEnv.LLM_API_KEY || hermesEnv.HERMES_CUSTOM_TEST1_API_KEY || '',
  model: localEnv.LLM_MODEL || 'claude-sonnet-5-5',
};

// ---------- источники ----------
const WORLD_FEEDS = [
  ['РБК', 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss'],
  ['Интерфакс', 'https://www.interfax.ru/rss.asp'],
  ['ТАСС', 'https://tass.ru/rss/v2.xml'],
  ['Лента', 'https://lenta.ru/rss'],
  ['Коммерсант', 'https://www.kommersant.ru/RSS/news.xml'],
  ['Ведомости', 'https://www.vedomosti.ru/rss/news'],
  ['Банки.ру', 'https://www.banki.ru/xml/news.rss'],
  ['Консультант', 'https://www.consultant.ru/rss/hotdocs.xml'],
  ['Naked Science', 'https://naked-science.ru/feed'],
  ['N+1', 'https://nplus1.ru/rss'],
  ['Чемпионат', 'https://www.championat.com/rss/news/'],
  ['3DNews', 'https://3dnews.ru/news/rss/'],
];
const AI_FEEDS = [
  ['Хабр: ИИ', 'https://habr.com/ru/rss/hubs/artificial_intelligence/articles/'],
  ['Хабр', 'https://habr.com/ru/rss/articles/?fl=ru'],
  ['TechCrunch AI', 'https://techcrunch.com/category/artificial-intelligence/feed/'],
  ['The Verge AI', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'],
  ['OpenAI', 'https://openai.com/news/rss.xml'],
  ['Hugging Face', 'https://huggingface.co/blog/feed.xml'],
  ['MIT Tech Review', 'https://www.technologyreview.com/feed/'],
  ['Wired AI', 'https://www.wired.com/feed/tag/ai/latest/rss'],
  ['Ars Technica AI', 'https://arstechnica.com/ai/feed/'],
  ['Hacker News', 'https://hnrss.org/frontpage'],
  ['CNews', 'https://www.cnews.ru/inc/rss/news.xml'],
  ['iXBT', 'https://www.ixbt.com/export/news.rss'],
  ['vc.ru', 'https://vc.ru/rss'],
  ['Tproger', 'https://tproger.ru/feed/'],
];

// ---------- RSS/Atom парсер ----------
const decode = (s = '') => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};
function parseFeed(xml, source) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 60)) {
    const title = decode(tag(b, 'title'));
    let link = decode(tag(b, 'link'));
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); if (m) link = m[1].replace(/&amp;/g, '&'); }
    const dateStr = decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const date = Date.parse(dateStr) || 0;
    const desc = decode(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 260);
    const cat = decode(tag(b, 'category'));
    const img = (b.match(/<enclosure[^>]*url="([^"]+)"/i) || b.match(/<media:(?:content|thumbnail)[^>]*url="([^"]+)"/i) || [])[1] || '';
    if (title && link) items.push({ source, title, link, date, desc, cat, img });
  }
  return items;
}
async function fetchFeed([source, url]) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 NewsHub/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return parseFeed(await r.text(), source);
  } catch (e) { log(`feed fail ${source}: ${e.message}`); return []; }
}
async function collect(feeds, maxAgeH, perSource) {
  const all = (await Promise.all(feeds.map(fetchFeed))).flat();
  const now = Date.now();
  const seen = new Set();
  const fresh = all.filter(i => i.date && now - i.date < maxAgeH * HOUR && i.date < now + HOUR)
    .filter(i => { const k = i.title.toLowerCase().slice(0, 70); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.date - a.date);
  const bySrc = {};
  return fresh.filter(i => (bySrc[i.source] = (bySrc[i.source] || 0) + 1) <= perSource);
}

// ---------- LLM ----------
async function askLLM(system, user, maxTokens = 9000) {
  if (!LLM.key) throw new Error('нет ключа LLM');
  const r = await fetch(LLM.base.replace(/\/$/, '') + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LLM.key, authorization: 'Bearer ' + LLM.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: LLM.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(240000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('LLM ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM вернул не JSON');
  return JSON.parse(m[0]);
}
const listForLLM = items => items.map((i, n) => `${n}| ${i.source} | ${i.cat ? '[' + i.cat + '] ' : ''}${i.title}${i.desc ? ' — ' + i.desc.slice(0, 160) : ''}`).join('\n');

// ---------- фоллбек без ИИ: грубый фильтр политики ----------
const POLITICS = /(путин|песков|лавров|зеленск|трамп|байден|макрон|сенат|парламент|выбор|санкц|нато|минобороны|всу|сво|фронт|удар|обстрел|дрон|бпла|войн|военн|армия|переговор|дипломат|посол|кремл|госдум|депутат|партия|президент|премьер|министр иностр|оппозиц|протест|митинг|украин|израил|газа|хамас|иран)/i;
const fallbackPick = (items, n) => items.filter(i => !POLITICS.test(i.title + ' ' + i.cat)).slice(0, n)
  .map(i => ({ ...i, title_ru: i.title, summary: i.desc || '', why: '', tag: i.cat || 'Новости', importance: 3 }));

// ---------- задачи обновления ----------
async function updateWorld() {
  const items = await collect(WORLD_FEEDS, 14, 30);
  const sys = `Ты — главный редактор персонального дайджеста для взрослого мужчины 25–45 лет, живущего в России. Задача: из списка свежих новостей выбрать 18 САМЫХ ВАЖНЫХ, которые реально нужно знать, чтобы быть в курсе жизни в РФ и мире.
СТРОГО ИСКЛЮЧИ политику: выборы, политиков и их заявления, дипломатию, переговоры, санкционную риторику, войну/боевые действия/обстрелы/армию, протесты, геополитику. Если новость в основном про это — не бери.
БЕРИ: деньги и экономика (курс, ставка ЦБ, инфляция, цены, налоги, ипотека, вклады, зарплаты, рынок акций, крипта), законы и правила, которые меняют повседневную жизнь (штрафы, ПДД, налоги, ЖКХ, связь, интернет, блокировки сервисов, работа, пенсии, армейский учёт — только как бытовое правило), авто, технологии и гаджеты, наука и медицина, здоровье, транспорт и путешествия, крупные бизнес-события и компании, крупные ЧП/катастрофы с большим масштабом, большой спорт (только главное), погода/стихия масштабно.
Отдавай приоритет тому, что влияет на кошелёк и быт. Не дублируй одно событие.
Ответ — только JSON: {"items":[{"i":номер,"title":"короткий ясный заголовок по-русски","summary":"2 предложения сути, без воды","why":"одна фраза: что это значит лично для тебя/что делать","tag":"одно из: Деньги, Законы, Авто, Технологии, Наука, Здоровье, Бизнес, Транспорт, ЧП, Спорт, Мир, Жизнь","importance":1-5}]} отсортировано по важности.`;
  try {
    const res = await askLLM(sys, listForLLM(items));
    const out = res.items.filter(x => items[x.i]).map(x => ({ ...items[x.i], title_ru: x.title, summary: x.summary, why: x.why, tag: x.tag, importance: x.importance }));
    return { items: out, ai: true, pool: items.length };
  } catch (e) { log('world LLM fail: ' + e.message); return { items: fallbackPick(items, 25), ai: false, pool: items.length, error: e.message }; }
}

async function updateAI() {
  const items = await collect(AI_FEEDS, 48, 15);
  const sys = `Ты — аналитик рынка ИИ и IT, пишешь дайджест по-русски для предпринимателя, который продаёт ИИ-автоматизацию бизнесу и сам вайбкодит. Из списка выбери 16 самых значимых новостей про ИИ и IT: релизы и обновления моделей, бенчмарки и тесты, новые инструменты для разработки и вайбкодинга, агенты, open-source, железо/чипы/дата-центры, сделки, инвестиции, цены на API, регулирование ИИ (как фактор рынка, не политика), исследования, важное для российского IT-рынка.
Пропускай мелочь, рекламу, вакансии, обзоры гаджетов не про ИИ, чисто политические новости. Не дублируй события. Англоязычное переводи.
Ответ — только JSON: {"items":[{"i":номер,"title":"заголовок по-русски","summary":"2–3 предложения сути","why":"одна фраза: как это влияет на рынок / что можно с этим сделать на практике","tag":"одно из: Модели, Бенчмарки, Инструменты, Агенты, Open-source, Железо, Деньги, Регулирование, Исследования, Рынок РФ","importance":1-5}],"pulse":"2 предложения: главный тренд рынка ИИ за последние сутки"}`;
  try {
    const res = await askLLM(sys, listForLLM(items));
    const out = res.items.filter(x => items[x.i]).map(x => ({ ...items[x.i], title_ru: x.title, summary: x.summary, why: x.why, tag: x.tag, importance: x.importance }));
    return { items: out, pulse: res.pulse || '', ai: true, pool: items.length };
  } catch (e) {
    log('ai LLM fail: ' + e.message);
    const kw = /(ИИ|нейросет|AI|GPT|LLM|Claude|Gemini|OpenAI|Anthropic|модел|agent|агент|Nvidia|чип)/i;
    return { items: items.filter(i => kw.test(i.title)).slice(0, 25).map(i => ({ ...i, title_ru: i.title, summary: i.desc, why: '', tag: 'ИИ', importance: 3 })), ai: false, pool: items.length, error: e.message };
  }
}

async function updateIdeas(aiNews) {
  const prev = readJSON('ideas.json', { batches: [] });
  const oldTitles = prev.batches.flatMap(b => b.ideas.map(i => i.title)).slice(0, 80);
  const context = (aiNews.items || []).slice(0, 12).map(i => '- ' + i.title_ru).join('\n');
  const sys = `Ты генерируешь идеи для вайбкодинга (быстрая разработка с ИИ: Claude Code, Cursor, Codex, Lovable, Bolt, v0, Replit). Пользователь — из России, умеет собирать сайты, Telegram-ботов, ИИ-ассистентов, CRM, продаёт автоматизацию малому бизнесу.
Дай 10 НОВЫХ идей: 5 "fun" (для прикола и для себя: смешные, полезные в быту, необычные, можно собрать за вечер) и 5 "biz" (для бизнеса/партнёров/клиентов: решают конкретную боль, понятно кому и как продать в РФ).
Опирайся на свежие ИИ-новости ниже (новые модели/инструменты = новые возможности), но не обязательно каждая идея про новость. Идеи конкретные, без банальщины вроде "чат-бот для поддержки" и "todo-лист". Не повторяй уже бывшие идеи.
Ответ — только JSON: {"ideas":[{"type":"fun|biz","title":"короткое цепкое название","pitch":"1–2 предложения: что это и в чём фишка","who":"для кого (для biz — конкретный сегмент бизнеса)","stack":"чем собрать (коротко)","hours":"оценка времени, напр. 3–5 ч","money":"для biz: как монетизировать и примерная цена в ₽; для fun: пустая строка","prompt":"готовый стартовый промпт для ИИ-кодера на русском, 3–5 предложений","hook":"для biz: одна фраза-зацепка для первого сообщения клиенту; для fun: пустая строка"}]}`;
  const user = `Свежие ИИ-новости:\n${context || '(нет)'}\n\nУже были (не повторять):\n${oldTitles.join('; ') || '(нет)'}`;
  try {
    const res = await askLLM(sys, user, 10000);
    const batch = { at: Date.now(), ideas: res.ideas.map((x, n) => ({ ...x, id: Date.now().toString(36) + n })) };
    const batches = [batch, ...prev.batches].slice(0, 24);
    return { batches };
  } catch (e) { log('ideas LLM fail: ' + e.message); return { ...prev, error: e.message }; }
}

// ---------- состояние ----------
function readJSON(name, def) { try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return def; } }
function writeJSON(name, obj) { const p = path.join(DATA, name); fs.writeFileSync(p + '.tmp', JSON.stringify(obj)); fs.renameSync(p + '.tmp', p); }
function log(s) { const line = `[${new Date().toLocaleString('ru-RU')}] ${s}`; console.log(line); fs.appendFileSync(path.join(DATA, 'log.txt'), line + '\n'); }

let running = null;
async function refreshAll(reason) {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    log('обновление: ' + reason);
    const [world, ai] = await Promise.all([updateWorld(), updateAI()]);
    writeJSON('world.json', { at: Date.now(), ...world });
    writeJSON('ai.json', { at: Date.now(), ...ai });
    const ideas = await updateIdeas(ai);
    writeJSON('ideas.json', { at: Date.now(), ...ideas });
    log(`готово за ${Math.round((Date.now() - t0) / 1000)} c: мир ${world.items.length}/${world.pool}, ИИ ${ai.items.length}/${ai.pool}, идей ${ideas.batches?.[0]?.ideas?.length || 0}`);
  })().finally(() => { running = null; });
  return running;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
if (ONCE) { await refreshAll('GitHub Actions'); process.exit(0); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (url.pathname === '/api/state') {
    return send(200, { world: readJSON('world.json', null), ai: readJSON('ai.json', null), ideas: readJSON('ideas.json', null), updating: !!running, nextAt: nextAt });
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') { refreshAll('вручную'); return send(202, { ok: true }); }
  let p = path.normalize(path.join(PUB, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!p.startsWith(PUB)) return send(403, 'no', 'text/plain');
  fs.readFile(p, (err, buf) => err ? send(404, 'not found', 'text/plain') : send(200, buf, MIME[path.extname(p)] || 'application/octet-stream'));
}).listen(PORT, '127.0.0.1', () => log(`NewsHub: http://localhost:${PORT}  (модель ${LLM.model}, ключ ${LLM.key ? 'есть' : 'НЕТ'})`))
  .on('error', e => { if (e.code === 'EADDRINUSE') { console.log('Сервер уже запущен на порту ' + PORT); process.exit(0); } throw e; });

// каждый час; при старте — если данные старше 55 минут
let nextAt = 0;
const last = readJSON('world.json', null)?.at || 0;
if (Date.now() - last > 55 * 60 * 1000) refreshAll('старт');
setInterval(() => { nextAt = Date.now() + HOUR; refreshAll('по расписанию'); }, HOUR);
nextAt = Date.now() + HOUR;
