'use strict';

/* =========================================================
   Configuración base
   ========================================================= */

const STORAGE_KEY = 'mis-gastos.v1';

// Tarjetas iniciales; después se pueden editar, agregar o eliminar en Ajustes.
const DEFAULT_CARDS = [
  { id: 'cuscatlan',   name: 'Cuscatlán',      color: '#0d9488', corte: 22, pago: 15 },
  { id: 'bac',         name: 'BAC Credomatic', color: '#dc2626', corte: 24, pago: 15 },
  { id: 'pricesmart',  name: 'PriceSmart',     color: '#2563eb', corte: 24, pago: 15 },
  { id: 'bi-mc',       name: 'BI Mastercard',  color: '#ea580c', corte: 22, pago: 15 },
  { id: 'bi-platinum', name: 'BI Platinum',    color: '#7c3aed', corte: 22, pago: 15 },
];

const COLORS = ['#0d9488', '#dc2626', '#2563eb', '#ea580c', '#7c3aed', '#16a34a', '#db2777', '#ca8a04', '#0891b2', '#475569'];

const DEFAULT_SETTINGS = {
  rate: 7.70,      // Q por $1
  lastCard: null,
};

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/* =========================================================
   Datos
   ========================================================= */

let db = load();

function load() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (_) { /* vacío */ }
  return normalize(data);
}

function normalize(data) {
  data = data && typeof data === 'object' ? data : {};
  const s = data.settings || {};
  return {
    version: 2,
    settings: {
      ...DEFAULT_SETTINGS,
      rate: Number(s.rate) > 0 ? Number(s.rate) : DEFAULT_SETTINGS.rate,
      lastCard: s.lastCard || null,
      cards: normalizeCards(s),
    },
    expenses: Array.isArray(data.expenses) ? data.expenses.filter(e => e && e.id && e.card && e.date) : [],
  };
}

/** Tarjetas guardadas; migra el formato anterior (cortes, pago y presupuestos globales). */
function normalizeCards(s) {
  if (Array.isArray(s.cards)) {
    return s.cards
      .filter(c => c && c.id && c.name)
      .map(c => ({
        id: String(c.id),
        name: String(c.name),
        color: c.color || COLORS[0],
        corte: clampInt(c.corte, 1, 31, 22),
        pago: clampInt(c.pago, 1, 31, 15),
        budget: Number(c.budget) > 0 ? Number(c.budget) : null,
      }));
  }
  const cortes = s.cortes || {};
  const budgets = s.budgets || {};
  return DEFAULT_CARDS.map(c => ({
    ...c,
    corte: clampInt(cortes[c.id], 1, 31, c.corte),
    pago: clampInt(s.pagoDay, 1, 31, c.pago),
    budget: Number(budgets[c.id]) > 0 ? Number(budgets[c.id]) : null,
  }));
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return n >= min && n <= max ? n : fallback;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (err) {
    toast('No se pudo guardar. Descarga un respaldo.');
  }
}

/* =========================================================
   Nube (Firebase)
   ---------------------------------------------------------
   sync.js se conecta con setCloud(). Mientras no haya sesión activa,
   los cambios se anotan en una cola y se suben al conectar, para que
   ningún gasto hecho sin internet se pierda.
   ========================================================= */

const PENDING_KEY = 'mis-gastos.pending';
const cloud = { ready: false, active: false, unavailable: false };
let account = null;   // { name, email, photo, status }

function readPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch (_) { return []; }
}

function writePending(list) {
  try {
    if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_KEY);
  } catch (_) { /* sin espacio: el respaldo manual sigue disponible */ }
}

/** Envía un cambio a la nube, o lo deja en cola si aún no hay sesión. */
function sync(op) {
  if (cloud.active) {
    if (op.type === 'put') cloud.put(db.expenses.find(e => e.id === op.id));
    else if (op.type === 'remove') cloud.remove(op.id);
    else if (op.type === 'settings') cloud.putSettings();
    else if (op.type === 'all') cloud.replaceAll();
    return;
  }
  writePending([...readPending(), op]);
}

window.App = {
  get db() { return db; },
  toast,
  takePending() { const list = readPending(); writePending([]); return list; },
  setCloud(impl) { Object.assign(cloud, impl, { ready: true }); renderAccount(); },
  setCloudUnavailable() { cloud.unavailable = true; renderAccount(); },
  setActive(active) { cloud.active = active; },
  setAccount(a) { account = a; renderAccount(); },
  setSyncStatus(status) { if (account) { account.status = status; renderAccount(); } },
  /** Reemplaza los datos locales con los de la nube. */
  applyRemote({ settings, expenses }) {
    if (settings) db.settings = normalize({ settings: { ...settings, lastCard: db.settings.lastCard } }).settings;
    if (expenses) db.expenses = normalize({ expenses }).expenses;
    save();
    render();
  },
  resetLocal() {
    db = normalize(null);
    writePending([]);
    save();
    render();
  },
};

const cards = () => db.settings.cards;
const DELETED_CARD = { id: '', name: 'Tarjeta eliminada', color: '#94a3b8', corte: 22, pago: 15, budget: null };
const cardById = id => cards().find(c => c.id === id) || { ...DELETED_CARD, id };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** Monto del gasto expresado en quetzales. */
const inQ = e => (e.currency === 'USD' ? e.amount * (e.rate || db.settings.rate) : e.amount);

/* =========================================================
   Fechas y ciclos de facturación
   ---------------------------------------------------------
   Un ciclo se identifica por el mes de su fecha de corte ("2026-10").
   Para una tarjeta con corte el 22 y pago el 15:
     ciclo "2026-10" = 23 sep → 22 oct, se paga el 15 nov.
   Cada tarjeta tiene su propio día de corte y de pago.
   ========================================================= */

const pad = n => String(n).padStart(2, '0');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const clampDay = (y, m, day) => Math.min(day, daysInMonth(y, m));

function monthKey(y, m) { return `${y}-${pad(m)}`; }

function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return monthKey(Math.floor(idx / 12), (idx % 12) + 1);
}

function dateObj(y, m, d) { return new Date(y, m - 1, d); }

const corteDay = cardId => cardById(cardId).corte;

/** Ciclo (mes de corte) al que pertenece un gasto hecho en `dateStr`. */
function cycleKeyFor(cardId, dateStr) {
  const { y, m, d } = parseDate(dateStr);
  const corte = clampDay(y, m, corteDay(cardId));
  return d <= corte ? monthKey(y, m) : addMonths(monthKey(y, m), 1);
}

/** El pago es la primera fecha con el día de pago de la tarjeta posterior al corte. */
function cycleInfo(cardId, key) {
  const card = cardById(cardId);
  const [y, m] = key.split('-').map(Number);
  const corte = dateObj(y, m, clampDay(y, m, card.corte));
  const [py, pm] = addMonths(key, -1).split('-').map(Number);
  const start = dateObj(py, pm, clampDay(py, pm, card.corte) + 1);
  let pago = dateObj(y, m, clampDay(y, m, card.pago));
  if (pago <= corte) {
    const [ny, nm] = addMonths(key, 1).split('-').map(Number);
    pago = dateObj(ny, nm, clampDay(ny, nm, card.pago));
  }
  return { start, corte, pago };
}

/** Mes ("2026-11") en que se paga el ciclo `key`. */
function pagoKeyOf(cardId, key) {
  const { pago } = cycleInfo(cardId, key);
  return monthKey(pago.getFullYear(), pago.getMonth() + 1);
}

/** Ciclo que se paga en el mes `pagoKey`, o null si ninguno cae ahí. */
function cycleKeyForPago(cardId, pagoKey) {
  return [pagoKey, addMonths(pagoKey, -1)].find(k => pagoKeyOf(cardId, k) === pagoKey) || null;
}

const fmtDay = d => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const fmtDayLong = d => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
const fmtMonthKey = key => { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const fmtDateStr = s => { const { y, m, d } = parseDate(s); return fmtDay(dateObj(y, m, d)); };

function daysBetween(a, b) {
  return Math.round((dateObj(b.getFullYear(), b.getMonth() + 1, b.getDate()) -
                     dateObj(a.getFullYear(), a.getMonth() + 1, a.getDate())) / 86400000);
}

/* =========================================================
   Cálculos
   ========================================================= */

function expensesInCycle(cardId, key) {
  return db.expenses
    .filter(e => e.card === cardId && cycleKeyFor(cardId, e.date) === key)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

function cycleTotals(list) {
  let q = 0, usd = 0;
  for (const e of list) {
    q += inQ(e);
    if (e.currency === 'USD') usd += e.amount;
  }
  return { q, usd };
}

const currentCycle = cardId => cycleKeyFor(cardId, todayStr());

/* =========================================================
   Formato de dinero
   ========================================================= */

const nf = new Intl.NumberFormat('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQ = n => `Q${nf.format(n)}`;
const fmtUSD = n => `$${nf.format(n)}`;

/** Acepta "1,163.50", "285+285", "20". Devuelve NaN si no es válido. */
function parseAmount(str) {
  const clean = String(str).replace(/[Qq$\s,]/g, '');
  if (!clean) return NaN;
  if (!/^[0-9.+]+$/.test(clean)) return NaN;
  const parts = clean.split('+').filter(Boolean).map(Number);
  if (!parts.length || parts.some(isNaN)) return NaN;
  return Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100;
}

/* =========================================================
   UI helpers
   ========================================================= */

const $ = sel => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function renderCardPicker(container, selected, onPick) {
  if (!cards().length) {
    container.replaceChildren(el('button', { type: 'button', class: 'link', onclick: () => go('settings') },
      'No tienes tarjetas. Toca aquí para agregar una.'));
    return;
  }
  container.replaceChildren(...cards().map(c => el('button', {
    type: 'button',
    class: 'chip',
    role: 'radio',
    'aria-checked': String(c.id === selected),
    'data-card': c.id,
    onclick: ev => {
      container.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-checked', String(b === ev.currentTarget)));
      onPick(c.id);
    },
  }, el('span', { class: 'dot', style: `background:${c.color}` }), c.name)));
}

function setCurrencyButton(btn, currency) {
  btn.textContent = currency === 'USD' ? '$' : 'Q';
  btn.classList.toggle('usd', currency === 'USD');
  btn.title = currency === 'USD' ? 'Tocar para regresar a quetzales' : 'Tocar para cambiar a dólares';
}

function expenseItem(e, { showCard = true } = {}) {
  const card = cardById(e.card);
  const meta = [fmtDateStr(e.date), showCard ? card.name : null].filter(Boolean).join(' · ');
  return el('li', { onclick: () => openEdit(e.id) },
    el('span', { class: 'dot', style: `background:${card.color}` }),
    el('div', { class: 'main' },
      el('div', { class: 'desc' }, e.desc),
      el('div', { class: 'meta' }, meta)),
    el('div', { class: 'amt' },
      e.currency === 'USD' ? fmtUSD(e.amount) : fmtQ(e.amount),
      e.currency === 'USD' ? el('small', {}, `≈ ${fmtQ(inQ(e))}`) : null));
}

/* =========================================================
   Navegación
   ========================================================= */

const TITLES = { add: 'Nuevo gasto', cards: 'Tarjetas', detail: 'Detalle', settings: 'Ajustes' };
let currentView = 'add';

function go(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  const tab = view === 'detail' ? 'cards' : view;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.goto === tab));
  $('#view-title').textContent = TITLES[view];
  render();
  window.scrollTo(0, 0);
}

document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => go(b.dataset.goto)));

function render() {
  if (currentView === 'add') renderAdd();
  else if (currentView === 'cards') renderCards();
  else if (currentView === 'detail') renderDetail();
  else if (currentView === 'settings') renderSettings();
}

/* =========================================================
   Vista: Agregar
   ========================================================= */

const form = {
  currency: 'GTQ',
  card: db.settings.lastCard,
};

function renderAdd() {
  renderReminders();
  renderSuggestions();
  if (!cards().some(c => c.id === form.card)) form.card = null;
  renderCardPicker($('#card-picker'), form.card, id => { form.card = id; });
  if (!$('#date').value) $('#date').value = todayStr();
  setCurrencyButton($('#currency-toggle'), form.currency);
  updateConversionHint();

  const recent = [...db.expenses].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
  $('#recent-list').replaceChildren(...(recent.length
    ? recent.map(e => expenseItem(e))
    : [el('li', { class: 'empty' }, 'Aún no hay gastos registrados')]));
}

/** Avisos cuando faltan 3 días o menos para el corte o el pago de cada tarjeta. */
function renderReminders() {
  const today = new Date();
  const notes = [];

  for (const c of cards()) {
    const cur = currentCycle(c.id);
    const info = cycleInfo(c.id, cur);

    const corteDiff = daysBetween(today, info.corte);
    if (corteDiff <= 3) {
      const total = cycleTotals(expensesInCycle(c.id, cur)).q;
      notes.push({ diff: corteDiff, text: `${whenText(corteDiff, info.corte)} es el corte de ${c.name}. Llevas ${fmtQ(total)} en este ciclo.` });
    }

    // El próximo pago puede ser del ciclo anterior (ya cortado) o del actual.
    const prev = addMonths(cur, -1);
    const prevPago = cycleInfo(c.id, prev).pago;
    const [pagoKey, pagoDate] = daysBetween(today, prevPago) >= 0 ? [prev, prevPago] : [cur, info.pago];
    const pagoDiff = daysBetween(today, pagoDate);
    const due = pagoDiff <= 3 ? cycleTotals(expensesInCycle(c.id, pagoKey)).q : 0;
    if (due > 0) {
      notes.push({ diff: pagoDiff, text: `${whenText(pagoDiff, pagoDate)} es el pago de ${c.name}. Total a pagar: ${fmtQ(due)}.` });
    }
  }

  notes.sort((a, b) => a.diff - b.diff);
  $('#reminders').replaceChildren(...notes.map(n => el('div', { class: 'reminder' }, '⏰ ', n.text)));
}

function whenText(diff, date) {
  if (diff === 0) return 'Hoy';
  if (diff === 1) return `Mañana (${fmtDayLong(date)})`;
  return `En ${diff} días (${fmtDayLong(date)})`;
}

function renderSuggestions() {
  const seen = new Set();
  const opts = [];
  for (const e of [...db.expenses].sort((a, b) => b.createdAt - a.createdAt)) {
    const k = e.desc.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    opts.push(el('option', { value: e.desc }));
    if (opts.length >= 60) break;
  }
  $('#desc-suggestions').replaceChildren(...opts);
}

function updateConversionHint() {
  const hint = $('#conversion-hint');
  const amount = parseAmount($('#amount').value);
  if (form.currency === 'USD' && !isNaN(amount)) {
    hint.hidden = false;
    hint.textContent = `≈ ${fmtQ(amount * db.settings.rate)} (tipo de cambio ${db.settings.rate})`;
  } else if (form.currency === 'USD') {
    hint.hidden = false;
    hint.textContent = `En dólares · tipo de cambio ${db.settings.rate}`;
  } else {
    hint.hidden = true;
  }
}

$('#currency-toggle').addEventListener('click', () => {
  form.currency = form.currency === 'USD' ? 'GTQ' : 'USD';
  setCurrencyButton($('#currency-toggle'), form.currency);
  updateConversionHint();
  $('#amount').focus();
});

$('#amount').addEventListener('input', updateConversionHint);

// Si la descripción ya se usó antes, sugiere la misma tarjeta.
$('#desc').addEventListener('change', () => {
  const desc = $('#desc').value.trim().toLowerCase();
  const prev = [...db.expenses].sort((a, b) => b.createdAt - a.createdAt).find(e => e.desc.toLowerCase() === desc);
  if (prev && prev.card !== form.card) {
    form.card = prev.card;
    renderCardPicker($('#card-picker'), form.card, id => { form.card = id; });
  }
});

$('#expense-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const amount = parseAmount($('#amount').value);
  const desc = $('#desc').value.trim();
  const date = $('#date').value;
  if (isNaN(amount) || amount <= 0) { toast('Escribe un monto válido'); $('#amount').focus(); return; }
  if (!desc) { toast('¿En qué lo gastaste?'); $('#desc').focus(); return; }
  if (!form.card) { toast('Elige una tarjeta'); return; }
  if (!date) { toast('Elige una fecha'); return; }

  const expense = {
    id: uid(),
    amount,
    currency: form.currency,
    rate: form.currency === 'USD' ? db.settings.rate : null,
    desc,
    card: form.card,
    date,
    createdAt: Date.now(),
  };
  db.expenses.push(expense);
  db.settings.lastCard = form.card;
  save();
  sync({ type: 'put', id: expense.id });

  const card = cardById(form.card);
  const key = cycleKeyFor(card.id, date);
  const total = cycleTotals(expensesInCycle(card.id, key)).q;
  toast(`Guardado · ${card.name}: ${fmtQ(total)} este ciclo`);

  $('#amount').value = '';
  $('#desc').value = '';
  $('#date').value = todayStr();
  form.currency = 'GTQ';
  renderAdd();
});

/* =========================================================
   Vista: Tarjetas
   ========================================================= */

function renderCards() {
  let grand = 0;
  $('#card-summary').replaceChildren(...cards().map(c => {
    const key = currentCycle(c.id);
    const { q } = cycleTotals(expensesInCycle(c.id, key));
    const info = cycleInfo(c.id, key);
    grand += q;
    return el('button', {
      type: 'button', class: 'card card-tile', style: `--c:${c.color}`,
      onclick: () => openDetail(c.id, key),
    },
      el('span', { class: 'name' }, c.name),
      el('span', { class: 'total' }, fmtQ(q)),
      el('span', { class: 'range' }, `${fmtDay(info.start)} – ${fmtDay(info.corte)} · paga ${fmtDay(info.pago)}`));
  }));
  if (!cards().length) {
    $('#card-summary').replaceChildren(el('button', { type: 'button', class: 'link', onclick: () => go('settings') },
      'No tienes tarjetas. Agrega una en Ajustes.'));
  }
  $('#grand-total').textContent = fmtQ(grand);
  renderHistoryTable();
}

/** Tabla por mes de pago: cada celda es el ciclo de esa tarjeta que se paga ese mes. */
function renderHistoryTable() {
  const keys = new Set();
  for (const e of db.expenses) {
    if (cards().some(c => c.id === e.card)) keys.add(pagoKeyOf(e.card, cycleKeyFor(e.card, e.date)));
  }
  for (const c of cards()) keys.add(pagoKeyOf(c.id, currentCycle(c.id)));
  const sorted = [...keys].sort().reverse();

  const head = el('thead', {}, el('tr', {},
    el('th', {}, 'Mes de pago'),
    cards().map(c => el('th', {}, c.name.replace('Credomatic', '').trim())),
    el('th', {}, 'Total')));

  const body = el('tbody', {}, sorted.map(pagoKey => {
    let total = 0;
    const cells = cards().map(c => {
      const key = cycleKeyForPago(c.id, pagoKey);
      if (!key) return el('td', {}, '–');
      const q = cycleTotals(expensesInCycle(c.id, key)).q;
      total += q;
      return el('td', {}, el('button', {
        type: 'button', class: 'link', style: 'padding:0',
        onclick: () => openDetail(c.id, key),
      }, q ? nf.format(q) : '–'));
    });
    return el('tr', {}, el('td', {}, fmtMonthKey(pagoKey)), cells, el('td', { class: 'total' }, nf.format(total)));
  }));

  $('#history-table').replaceChildren(head, body);
}

/* =========================================================
   Vista: Detalle de tarjeta
   ========================================================= */

const detail = { card: null, key: null };

function openDetail(cardId, key) {
  detail.card = cardId;
  detail.key = key || currentCycle(cardId);
  go('detail');
}

$('#cycle-prev').addEventListener('click', () => { detail.key = addMonths(detail.key, -1); renderDetail(); });
$('#cycle-next').addEventListener('click', () => { detail.key = addMonths(detail.key, 1); renderDetail(); });

function renderDetail() {
  const card = cards().find(c => c.id === detail.card);
  if (!card) return go('cards');
  const list = expensesInCycle(card.id, detail.key);
  const { q, usd } = cycleTotals(list);
  const info = cycleInfo(card.id, detail.key);
  const isCurrent = detail.key === currentCycle(card.id);

  $('#detail-name').textContent = card.name;
  $('#detail-range').textContent =
    `${fmtDay(info.start)} – ${fmtDay(info.corte)} ${info.corte.getFullYear()} · pago ${fmtDay(info.pago)}${isCurrent ? ' · actual' : ''}`;
  $('#detail-total').textContent = fmtQ(q);
  $('#detail-total').style.color = card.color;
  $('#detail-sub').textContent =
    `${list.length} gasto${list.length === 1 ? '' : 's'}${usd ? ` · incluye ${fmtUSD(usd)} en dólares` : ''}`;

  const budget = card.budget || 0;
  const box = $('#detail-budget');
  box.hidden = !budget;
  if (budget) {
    const pct = Math.min(100, (q / budget) * 100);
    box.classList.toggle('over', q > budget);
    box.querySelector('.bar span').style.width = `${pct}%`;
    $('#detail-budget-text').textContent = q > budget
      ? `Te pasaste por ${fmtQ(q - budget)} de ${fmtQ(budget)}`
      : `Restante: ${fmtQ(budget - q)} de ${fmtQ(budget)}`;
  }

  renderChart(card);

  $('#detail-list').replaceChildren(...(list.length
    ? list.map(e => expenseItem(e, { showCard: false }))
    : [el('li', { class: 'empty' }, 'Sin gastos en este ciclo')]));
}

function renderChart(card) {
  const keys = Array.from({ length: 6 }, (_, i) => addMonths(detail.key, i - 5));
  const totals = keys.map(k => cycleTotals(expensesInCycle(card.id, k)).q);
  const max = Math.max(...totals, 1);
  $('#detail-chart').style.setProperty('--c', card.color);
  $('#detail-chart').replaceChildren(...keys.map((k, i) => el('button', {
    type: 'button',
    class: `col${k === detail.key ? ' sel' : ''}`,
    onclick: () => { detail.key = k; renderDetail(); },
    'aria-label': `Ciclo ${fmtMonthKey(k)}: ${fmtQ(totals[i])}`,
  },
    el('span', { class: 'val' }, totals[i] ? Math.round(totals[i]).toLocaleString('es-GT') : ''),
    el('span', { class: 'bar', style: `height:${(totals[i] / max) * 100}%` }),
    el('span', { class: 'lbl' }, MONTHS[Number(k.split('-')[1]) - 1]))));
}

/* =========================================================
   Editar / eliminar
   ========================================================= */

const edit = { id: null, currency: 'GTQ', card: null };

function openEdit(id) {
  const e = db.expenses.find(x => x.id === id);
  if (!e) return;
  edit.id = id;
  edit.currency = e.currency;
  edit.card = e.card;
  $('#edit-amount').value = e.amount;
  $('#edit-desc').value = e.desc;
  $('#edit-date').value = e.date;
  setCurrencyButton($('#edit-currency'), edit.currency);
  renderCardPicker($('#edit-card-picker'), edit.card, cid => { edit.card = cid; });
  $('#edit-dialog').showModal();
}

$('#edit-currency').addEventListener('click', () => {
  edit.currency = edit.currency === 'USD' ? 'GTQ' : 'USD';
  setCurrencyButton($('#edit-currency'), edit.currency);
});

$('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());

$('#edit-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const e = db.expenses.find(x => x.id === edit.id);
  const amount = parseAmount($('#edit-amount').value);
  const desc = $('#edit-desc').value.trim();
  if (!e || isNaN(amount) || amount <= 0 || !desc || !$('#edit-date').value) { toast('Revisa los datos'); return; }
  if (edit.currency === 'USD' && e.currency !== 'USD') e.rate = db.settings.rate;
  if (edit.currency !== 'USD') e.rate = null;
  Object.assign(e, { amount, desc, currency: edit.currency, card: edit.card, date: $('#edit-date').value });
  save();
  sync({ type: 'put', id: e.id });
  $('#edit-dialog').close();
  toast('Gasto actualizado');
  render();
});

$('#edit-delete').addEventListener('click', () => {
  if (!confirm('¿Eliminar este gasto?')) return;
  db.expenses = db.expenses.filter(x => x.id !== edit.id);
  save();
  sync({ type: 'remove', id: edit.id });
  $('#edit-dialog').close();
  toast('Gasto eliminado');
  render();
});

/* =========================================================
   Vista: Ajustes
   ========================================================= */

function renderAccount() {
  const box = $('#account');
  const pill = $('#sync-pill');
  const status = account && SYNC_TEXT[account.status];
  pill.hidden = !account && !cloud.ready;
  pill.textContent = account ? `☁ ${status ? status.short : ''}` : '☁ Guardar en la nube';
  pill.dataset.state = account ? account.status : 'off';

  if (account) {
    box.replaceChildren(
      el('div', { class: 'account-row' },
        account.photo ? el('img', { src: account.photo, alt: '', referrerpolicy: 'no-referrer', class: 'avatar' }) : null,
        el('div', { class: 'main' },
          el('strong', {}, account.name || 'Tu cuenta'),
          el('div', { class: 'muted small' }, account.email || ''))),
      el('p', { class: 'small sync-status', 'data-state': account.status }, status ? status.long : ''),
      el('button', { type: 'button', onclick: () => cloud.signOut() }, 'Cerrar sesión'));
  } else if (cloud.ready) {
    box.replaceChildren(
      el('h3', {}, 'Guarda tus gastos en tu cuenta'),
      el('p', { class: 'muted small' },
        'Inicia sesión con Google para respaldar tus gastos automáticamente y verlos en cualquier teléfono. Solo tú puedes verlos.'),
      el('button', { type: 'button', class: 'primary google', onclick: () => cloud.signIn() }, 'Iniciar sesión con Google'));
  } else {
    box.replaceChildren(el('p', { class: 'muted small' }, cloud.unavailable
      ? 'Sin conexión: podrás iniciar sesión con Google cuando tengas internet. Tus gastos se siguen guardando en este teléfono.'
      : 'Conectando…'));
  }
}

const SYNC_TEXT = {
  syncing: { short: 'Sincronizando…', long: 'Sincronizando tus gastos…' },
  pending: { short: 'Guardando…', long: 'Guardando cambios en la nube…' },
  offline: { short: 'Sin conexión', long: 'Sin conexión. Tus cambios se guardan aquí y se subirán al reconectar.' },
  ok: { short: 'Sincronizado', long: '✓ Todo guardado en tu cuenta de Google.' },
  error: { short: 'Error', long: 'No se pudo sincronizar. Revisa tu conexión; se reintentará solo.' },
};

function renderSettings() {
  renderAccount();
  $('#set-rate').value = db.settings.rate;
  $('#set-cards').replaceChildren(...cards().map(c => el('li', { style: `--c:${c.color}`, onclick: () => openCardEditor(c.id) },
    el('div', { class: 'main' },
      el('div', {}, c.name),
      el('div', { class: 'meta' },
        `Corte ${c.corte} · Pago ${c.pago}${c.budget ? ` · Presupuesto ${fmtQ(c.budget)}` : ''}`)),
    el('span', { class: 'chev', 'aria-hidden': 'true' }, '›'))));
  if (!cards().length) $('#set-cards').replaceChildren(el('li', { class: 'muted small' }, 'Aún no tienes tarjetas.'));
}

$('#settings-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const rate = parseAmount($('#set-rate').value);
  if (isNaN(rate) || rate <= 0) { toast('Tipo de cambio inválido'); return; }
  db.settings.rate = rate;
  save();
  sync({ type: 'settings' });
  toast('Tipo de cambio guardado');
  renderSettings();
});

/* ---------- Agregar / editar / eliminar tarjetas ---------- */

const cardEdit = { id: null, color: COLORS[0] };

function renderSwatches() {
  $('#card-colors').replaceChildren(...COLORS.map(color => el('button', {
    type: 'button', class: 'swatch', role: 'radio', style: `--c:${color}`,
    'aria-checked': String(color === cardEdit.color), 'aria-label': color,
    onclick: () => { cardEdit.color = color; renderSwatches(); },
  })));
}

function openCardEditor(id) {
  const card = id ? cards().find(c => c.id === id) : null;
  cardEdit.id = card ? card.id : null;
  // Para una tarjeta nueva, propone un color que aún no se use.
  cardEdit.color = card ? card.color : (COLORS.find(col => !cards().some(c => c.color === col)) || COLORS[0]);
  $('#card-dialog-title').textContent = card ? 'Editar tarjeta' : 'Nueva tarjeta';
  $('#card-name').value = card ? card.name : '';
  $('#card-corte').value = card ? card.corte : '';
  $('#card-pago').value = card ? card.pago : '';
  $('#card-budget').value = card && card.budget ? card.budget : '';
  $('#card-delete').hidden = !card;
  renderSwatches();
  $('#card-dialog').showModal();
}

$('#add-card-btn').addEventListener('click', () => openCardEditor(null));
$('#card-cancel').addEventListener('click', () => $('#card-dialog').close());

$('#card-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const name = $('#card-name').value.trim();
  const corte = clampInt($('#card-corte').value, 1, 31, null);
  const pago = clampInt($('#card-pago').value, 1, 31, null);
  const budgetRaw = $('#card-budget').value.trim();
  const budget = budgetRaw ? parseAmount(budgetRaw) : null;
  if (!name) { toast('Escribe el nombre de la tarjeta'); return; }
  if (cards().some(c => c.id !== cardEdit.id && c.name.toLowerCase() === name.toLowerCase())) {
    toast('Ya tienes una tarjeta con ese nombre'); return;
  }
  if (!corte) { toast('Día de corte entre 1 y 31'); return; }
  if (!pago) { toast('Día de pago entre 1 y 31'); return; }
  if (budgetRaw && (isNaN(budget) || budget <= 0)) { toast('Presupuesto inválido'); return; }

  const data = { name, color: cardEdit.color, corte, pago, budget: budget || null };
  if (cardEdit.id) {
    Object.assign(cards().find(c => c.id === cardEdit.id), data);
  } else {
    cards().push({ id: uid(), ...data });
  }
  save();
  sync({ type: 'settings' });
  $('#card-dialog').close();
  toast(cardEdit.id ? 'Tarjeta actualizada' : 'Tarjeta agregada');
  render();
});

$('#card-delete').addEventListener('click', () => {
  const card = cards().find(c => c.id === cardEdit.id);
  if (!card) return;
  const count = db.expenses.filter(e => e.card === card.id).length;
  const msg = count
    ? `${card.name} tiene ${count} gasto${count === 1 ? '' : 's'} registrado${count === 1 ? '' : 's'}. ` +
      'Si la eliminas, también se borrarán esos gastos de tu historial. ¿Eliminarla?'
    : `¿Eliminar la tarjeta ${card.name}?`;
  if (!confirm(msg)) return;
  db.settings.cards = cards().filter(c => c.id !== card.id);
  const removed = db.expenses.filter(e => e.card === card.id);
  db.expenses = db.expenses.filter(e => e.card !== card.id);
  if (db.settings.lastCard === card.id) db.settings.lastCard = null;
  save();
  sync({ type: 'settings' });
  removed.forEach(e => sync({ type: 'remove', id: e.id }));
  $('#card-dialog').close();
  toast('Tarjeta eliminada');
  render();
});

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#export-btn').addEventListener('click', () => {
  download(`mis-gastos-${todayStr()}.json`, JSON.stringify(db, null, 2), 'application/json');
});

$('#export-csv-btn').addEventListener('click', () => {
  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Fecha', 'Tarjeta', 'Descripción', 'Moneda', 'Monto', 'Monto en Q', 'Ciclo (corte)', 'Mes de pago']];
  for (const e of [...db.expenses].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = cycleKeyFor(e.card, e.date);
    rows.push([e.date, cardById(e.card).name, e.desc, e.currency === 'USD' ? 'USD' : 'GTQ',
      e.amount.toFixed(2), inQ(e).toFixed(2), key, addMonths(key, 1)]);
  }
  download(`mis-gastos-${todayStr()}.csv`, '﻿' + rows.map(r => r.map(esc).join(',')).join('\n'), 'text/csv');
});

$('#import-input').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = normalize(JSON.parse(await file.text()));
    if (!confirm(`El respaldo tiene ${data.expenses.length} gastos. Esto reemplazará los datos actuales. ¿Continuar?`)) return;
    db = data;
    save();
    sync({ type: 'all' });
    toast('Respaldo restaurado');
    render();
  } catch (_) {
    toast('Archivo de respaldo inválido');
  }
});

/* =========================================================
   Inicio
   ========================================================= */

// Al volver a la app (p. ej. al día siguiente) refresca fechas y recordatorios.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (currentView === 'add' && !$('#amount').value && !$('#desc').value) $('#date').value = todayStr();
  render();
});

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

go('add');
renderAccount();
