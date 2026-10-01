'use strict';

/* =========================================================
   Configuración base
   ========================================================= */

const STORAGE_KEY = 'mis-gastos.v1';

const CARDS = [
  { id: 'cuscatlan',   name: 'Cuscatlán',      color: '#0d9488', corte: 22 },
  { id: 'bac',         name: 'BAC Credomatic', color: '#dc2626', corte: 24 },
  { id: 'pricesmart',  name: 'PriceSmart',     color: '#2563eb', corte: 24 },
  { id: 'bi-mc',       name: 'BI Mastercard',  color: '#ea580c', corte: 22 },
  { id: 'bi-platinum', name: 'BI Platinum',    color: '#7c3aed', corte: 22 },
];

const DEFAULT_SETTINGS = {
  rate: 7.70,      // Q por $1
  pagoDay: 15,
  cortes: Object.fromEntries(CARDS.map(c => [c.id, c.corte])),
  budgets: {},     // { cardId: monto en Q }
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
    version: 1,
    settings: {
      ...DEFAULT_SETTINGS,
      ...s,
      cortes: { ...DEFAULT_SETTINGS.cortes, ...(s.cortes || {}) },
      budgets: { ...(s.budgets || {}) },
    },
    expenses: Array.isArray(data.expenses) ? data.expenses.filter(e => e && e.id && e.card && e.date) : [],
  };
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (err) {
    toast('No se pudo guardar. Descarga un respaldo.');
  }
}

const cardById = id => CARDS.find(c => c.id === id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** Monto del gasto expresado en quetzales. */
const inQ = e => (e.currency === 'USD' ? e.amount * (e.rate || db.settings.rate) : e.amount);

/* =========================================================
   Fechas y ciclos de facturación
   ---------------------------------------------------------
   Un ciclo se identifica por el mes de su fecha de corte ("2026-10").
   Para una tarjeta con corte el 22:
     ciclo "2026-10" = 23 sep → 22 oct, se paga el 15 nov.
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

function corteDay(cardId) { return db.settings.cortes[cardId] || cardById(cardId).corte; }

/** Ciclo (mes de corte) al que pertenece un gasto hecho en `dateStr`. */
function cycleKeyFor(cardId, dateStr) {
  const { y, m, d } = parseDate(dateStr);
  const corte = clampDay(y, m, corteDay(cardId));
  return d <= corte ? monthKey(y, m) : addMonths(monthKey(y, m), 1);
}

function cycleInfo(cardId, key) {
  const [y, m] = key.split('-').map(Number);
  const corte = dateObj(y, m, clampDay(y, m, corteDay(cardId)));
  const [py, pm] = addMonths(key, -1).split('-').map(Number);
  const start = dateObj(py, pm, clampDay(py, pm, corteDay(cardId)) + 1);
  const [ny, nm] = addMonths(key, 1).split('-').map(Number);
  const pago = dateObj(ny, nm, clampDay(ny, nm, db.settings.pagoDay));
  return { start, corte, pago };
}

const fmtDay = d => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const fmtDayLong = d => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
const fmtMonthKey = key => { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const fmtDateStr = s => { const { y, m, d } = parseDate(s); return fmtDay(dateObj(y, m, d)); };

function daysBetween(a, b) {
  return Math.round((dateObj(b.getFullYear(), b.getMonth() + 1, b.getDate()) -
                     dateObj(a.getFullYear(), a.getMonth() + 1, a.getDate())) / 86400000);
}

/** Próxima fecha (hoy incluido) que cae en el día `day` del mes. */
function nextOccurrence(day, from = new Date()) {
  let y = from.getFullYear(), m = from.getMonth() + 1;
  if (from.getDate() > clampDay(y, m, day)) { m++; if (m > 12) { m = 1; y++; } }
  return dateObj(y, m, clampDay(y, m, day));
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
  container.replaceChildren(...CARDS.map(c => el('button', {
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
  renderCardPicker($('#card-picker'), form.card, id => { form.card = id; });
  if (!$('#date').value) $('#date').value = todayStr();
  setCurrencyButton($('#currency-toggle'), form.currency);
  updateConversionHint();

  const recent = [...db.expenses].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
  $('#recent-list').replaceChildren(...(recent.length
    ? recent.map(e => expenseItem(e))
    : [el('li', { class: 'empty' }, 'Aún no hay gastos registrados')]));
}

function renderReminders() {
  const today = new Date();
  const notes = [];

  // Cortes: agrupa tarjetas por día de corte
  const groups = {};
  for (const c of CARDS) (groups[corteDay(c.id)] ||= []).push(c);
  for (const [day, cards] of Object.entries(groups)) {
    const date = nextOccurrence(Number(day), today);
    const diff = daysBetween(today, date);
    if (diff > 3) continue;
    const names = listNames(cards.map(c => c.name));
    const total = cards.reduce((sum, c) => sum + cycleTotals(expensesInCycle(c.id, currentCycle(c.id))).q, 0);
    notes.push({ diff, text: `${whenText(diff, date)} es el corte de ${names}. Llevas ${fmtQ(total)} en este ciclo.` });
  }

  // Pago: mismo día para todas
  const pagoDate = nextOccurrence(db.settings.pagoDay, today);
  const pagoDiff = daysBetween(today, pagoDate);
  if (pagoDiff <= 3) {
    const pagoKey = monthKey(pagoDate.getFullYear(), pagoDate.getMonth() + 1);
    const due = totalForPagoMonth(pagoKey);
    notes.push({ diff: pagoDiff, text: `${whenText(pagoDiff, pagoDate)} es la fecha de pago de tus tarjetas. Total a pagar: ${fmtQ(due)}.` });
  }

  notes.sort((a, b) => a.diff - b.diff);
  $('#reminders').replaceChildren(...notes.map(n => el('div', { class: 'reminder' }, '⏰ ', n.text)));
}

function whenText(diff, date) {
  if (diff === 0) return 'Hoy';
  if (diff === 1) return `Mañana (${fmtDayLong(date)})`;
  return `En ${diff} días (${fmtDayLong(date)})`;
}

function listNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0];
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

function totalForPagoMonth(pagoKey) {
  const corteKey = addMonths(pagoKey, -1);
  return CARDS.reduce((sum, c) => sum + cycleTotals(expensesInCycle(c.id, corteKey)).q, 0);
}

function renderCards() {
  let grand = 0;
  $('#card-summary').replaceChildren(...CARDS.map(c => {
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
  $('#grand-total').textContent = fmtQ(grand);
  renderHistoryTable();
}

function renderHistoryTable() {
  // Meses de pago con datos + el mes de pago actual
  const keys = new Set();
  for (const e of db.expenses) keys.add(addMonths(cycleKeyFor(e.card, e.date), 1));
  for (const c of CARDS) keys.add(addMonths(currentCycle(c.id), 1));
  const sorted = [...keys].sort().reverse();

  const head = el('thead', {}, el('tr', {},
    el('th', {}, 'Pago 15'),
    CARDS.map(c => el('th', {}, c.name.replace('Credomatic', '').trim())),
    el('th', {}, 'Total')));

  const body = el('tbody', {}, sorted.map(pagoKey => {
    const corteKey = addMonths(pagoKey, -1);
    let total = 0;
    const cells = CARDS.map(c => {
      const q = cycleTotals(expensesInCycle(c.id, corteKey)).q;
      total += q;
      return el('td', {}, el('button', {
        type: 'button', class: 'link', style: 'padding:0',
        onclick: () => openDetail(c.id, corteKey),
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
  const card = cardById(detail.card);
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

  const budget = Number(db.settings.budgets[card.id]) || 0;
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
  $('#edit-dialog').close();
  toast('Gasto actualizado');
  render();
});

$('#edit-delete').addEventListener('click', () => {
  if (!confirm('¿Eliminar este gasto?')) return;
  db.expenses = db.expenses.filter(x => x.id !== edit.id);
  save();
  $('#edit-dialog').close();
  toast('Gasto eliminado');
  render();
});

/* =========================================================
   Vista: Ajustes
   ========================================================= */

function renderSettings() {
  $('#set-rate').value = db.settings.rate;
  $('#set-pago').value = db.settings.pagoDay;
  $('#set-cards').replaceChildren(
    el('div', { class: 'set-card set-head' }, el('span', {}, 'Tarjeta'), el('span', {}, 'Corte'), el('span', {}, 'Presupuesto Q')),
    ...CARDS.map(c => el('div', { class: 'set-card' },
      el('span', {}, c.name),
      el('input', { type: 'number', min: 1, max: 31, value: corteDay(c.id), 'data-corte': c.id, 'aria-label': `Día de corte ${c.name}` }),
      el('input', { type: 'text', inputmode: 'decimal', placeholder: 'opcional', value: db.settings.budgets[c.id] || '', 'data-budget': c.id, 'aria-label': `Presupuesto ${c.name}` }))));
}

$('#settings-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const rate = parseAmount($('#set-rate').value);
  const pago = Number($('#set-pago').value);
  if (isNaN(rate) || rate <= 0) { toast('Tipo de cambio inválido'); return; }
  if (!(pago >= 1 && pago <= 28)) { toast('Día de pago entre 1 y 28'); return; }
  db.settings.rate = rate;
  db.settings.pagoDay = pago;
  document.querySelectorAll('[data-corte]').forEach(inp => {
    const v = Number(inp.value);
    if (v >= 1 && v <= 31) db.settings.cortes[inp.dataset.corte] = v;
  });
  document.querySelectorAll('[data-budget]').forEach(inp => {
    const v = parseAmount(inp.value);
    if (!isNaN(v) && v > 0) db.settings.budgets[inp.dataset.budget] = v;
    else delete db.settings.budgets[inp.dataset.budget];
  });
  save();
  toast('Ajustes guardados');
  renderSettings();
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
