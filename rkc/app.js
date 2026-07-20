/* РКЦ «Кедровый» — интерфейс и бизнес-операции.
   Экраны: главная (дашборд), абоненты, карточка абонента, услуга,
   начисления (закрытие периода), платежи, настройки. */
'use strict';

const App = {
  settings: null,
  abonents: [],          // все абоненты в памяти (для поиска и агрегатов)
  byId: new Map(),
  closedMonths: [],
  stats: { byYm: {} },
  plans: [],             // тарифные планы (кроме базового)
  ready: false,
};

/* ---------- утилиты ---------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = n => (Number(n) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtVol = n => (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
const fmtCompact = n => {
  const x = Number(n) || 0;
  if (Math.abs(x) >= 1e6) return (x / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' млн ₽';
  if (Math.abs(x) >= 1e4) return (x / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' тыс ₽';
  return fmtMoney(x) + ' ₽';
};
const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const ymName = ym => { const [y, m] = ym.split('-').map(Number); return MONTHS_RU[m - 1] + ' ' + y; };
const ymShort = ym => { const [y, m] = ym.split('-').map(Number); return MONTHS_RU[m - 1].slice(0, 3) + ' ’' + String(y).slice(2); };
const todayISO = () => new Date().toISOString().slice(0, 10);
const nextYm = ym => { let [y, m] = ym.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}`; };
const svcByKey = key => Billing.SERVICES.find(s => s.key === key);
const SVC_COLORS = { cold: 'var(--svc-cold)', hot: 'var(--svc-hot)', sewer: 'var(--svc-sewer)', heat: 'var(--svc-heat)', gas: 'var(--svc-gas)', elec: 'var(--svc-elec)', tko: 'var(--svc-tko)' };
const enabledServices = () => Billing.SERVICES.filter(s => !App.settings.enabledServices || App.settings.enabledServices[s.key] !== false);

/* Пени абонента: при действующей рассрочке пени на долг не начисляются. */
const penaltyOf = (ab, now) => ab.installment ? 0 : Billing.calcPenaltyTotal(ab.debtByMonth, now, App.settings.keyRate);

/* Эффективные настройки абонента: тарифный план поверх базовых тарифов. */
const planById = id => App.plans.find(p => p.id === id);
function effSettings(ab) {
  const p = ab.planId && planById(ab.planId);
  return p ? { ...App.settings, tariffs: { ...App.settings.tariffs, ...p.tariffs } } : App.settings;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove('show'), 2600);
}

/* Расчётный период, следующий за последним закрытым. */
function currentPeriod() {
  if (App.closedMonths.length) return nextYm(App.closedMonths[App.closedMonths.length - 1]);
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const lastClosed = () => App.closedMonths[App.closedMonths.length - 1] || null;

/* Сводные показатели по всем абонентам (в памяти, мгновенно). */
function totals() {
  const now = new Date();
  let debt = 0, debtors = 0, penalty = 0, subsidized = 0, advance = 0;
  for (const ab of App.abonents) {
    if (ab.balance > 0.005) { debt += ab.balance; debtors++; }
    else if (ab.balance < -0.005) advance += -ab.balance;
    if (ab.subsidyOn) subsidized++;
    penalty += penaltyOf(ab, now);
  }
  return { debt: Billing.round2(debt), debtors, penalty: Billing.round2(penalty), subsidized, advance: Billing.round2(advance) };
}

/* ---------- инициализация ---------- */
/* ---------- вход по паролю ---------- */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function renderLock() {
  $('#topbar').hidden = true;
  $('#view').innerHTML = `
    <div class="card welcome">
      <div class="mark">🔒</div>
      <h1>РКЦ «Кедровый»</h1>
      <p>Система защищена паролем. Введите пароль для входа.</p>
      <form id="lockForm" class="toolbar" style="justify-content:center">
        <input type="password" name="pw" placeholder="Пароль" autocomplete="current-password" required style="min-width:220px" autofocus>
        <button class="btn">Войти</button>
      </form>
      <p class="muted small" id="lockErr" style="margin-top:12px"></p>
    </div>`;
  $('#lockForm').onsubmit = async e => {
    e.preventDefault();
    const hash = await sha256(new FormData(e.target).get('pw'));
    if (hash === App.security.hash) {
      sessionStorage.setItem('rkc-auth', hash);
      location.reload();
    } else {
      $('#lockErr').textContent = 'Неверный пароль. Попробуйте ещё раз.';
      e.target.reset();
    }
  };
}

function renderAdminGate() {
  $('#view').innerHTML = `
    <div class="card welcome">
      <div class="mark">🔒</div>
      <h1>Раздел «Админ»</h1>
      <p>Для входа в администрирование введите пароль ещё раз.</p>
      <form id="gateForm" class="toolbar" style="justify-content:center">
        <input type="password" name="pw" placeholder="Пароль" required style="min-width:220px" autofocus>
        <button class="btn">Открыть</button>
      </form>
      <p class="muted small" id="gateErr" style="margin-top:12px"></p>
    </div>`;
  $('#gateForm').onsubmit = async e => {
    e.preventDefault();
    const hash = await sha256(new FormData(e.target).get('pw'));
    if (hash === App.security.hash) {
      sessionStorage.setItem('rkc-admin', hash);
      renderAdmin();
    } else {
      $('#gateErr').textContent = 'Неверный пароль.';
      e.target.reset();
    }
  };
}

/* Дополнение баз, созданных прошлыми версиями: новые услуги и поля. */
function migrate() {
  const d = Billing.DEFAULT_SETTINGS, s = App.settings;
  s.tariffs = { ...d.tariffs, ...s.tariffs };
  s.norms = { ...d.norms, ...s.norms };
  s.subsidy = { ...d.subsidy, ...s.subsidy };
  if (!s.enabledServices) s.enabledServices = { ...d.enabledServices };
  for (const ab of App.abonents) {
    if (!ab.meters.elec) ab.meters.elec = { has: false, can: false };
  }
}

async function init() {
  await DB.open();
  App.settings = await DB.kvGet('settings', null);
  App.security = await DB.kvGet('security', null);
  if (App.security && App.security.hash && sessionStorage.getItem('rkc-auth') !== App.security.hash) {
    renderLock();
    return;
  }
  if (!App.settings) { renderWelcome(); return; }
  App.closedMonths = await DB.kvGet('closedMonths', []);
  App.stats = await DB.kvGet('stats', { byYm: {} });
  App.plans = await DB.kvGet('tariffPlans', []);
  App.abonents = await DB.getAll('abonents');
  App.abonents.sort((a, b) => a.id - b.id);
  App.byId = new Map(App.abonents.map(a => [a.id, a]));
  migrate();
  App.ready = true;
  $('#topbar').hidden = false;
  render();
}

function renderWelcome() {
  $('#topbar').hidden = true;
  $('#view').innerHTML = `
    <div class="card welcome">
      <div class="mark">₽</div>
      <h1>РКЦ «Кедровый»</h1>
      <p>Расчётная система ЖКХ для посёлка: холодная и горячая вода, водоотведение,
         отопление, газ, электроэнергия и вывоз ТКО. Начисления по ПП №354, пени
         по ст. 155 ЖК РФ, субсидии по ст. 159 ЖК РФ, тарифные планы.
         Все данные хранятся в вашем браузере.</p>
      <div class="btn-row">
        <button class="btn" id="seedBig">Создать демо-базу: 10 000 абонентов</button>
        <button class="btn secondary" id="seedEmpty">Начать с пустой базы</button>
      </div>
      <div id="seedProgress" style="margin-top:22px" hidden>
        <div class="progress"><div id="seedBar" style="width:0%"></div></div>
        <p class="muted small" id="seedMsg" style="margin-top:8px">Подготовка…</p>
      </div>
    </div>`;
  $('#seedBig').onclick = () => runSeed(10000);
  $('#seedEmpty').onclick = async () => {
    await DB.kvSet('settings', Billing.DEFAULT_SETTINGS);
    location.reload();
  };
  const qs = new URLSearchParams(location.search);
  if (qs.get('autoseed')) runSeed(Number(qs.get('autoseed')) || 1000);
}

async function runSeed(count) {
  $('#seedBig').disabled = true; $('#seedEmpty').disabled = true;
  $('#seedProgress').hidden = false;
  const months = ['2026-04', '2026-05', '2026-06'];
  const res = await Seed.generate({
    count, months, settings: Billing.DEFAULT_SETTINGS,
    onProgress: (label, done, total) => {
      $('#seedBar').style.width = Math.round(done / total * 100) + '%';
      $('#seedMsg').textContent = `Записываем ${label}… ${done.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')}`;
    },
  });
  toast(`База создана: ${res.abonents.toLocaleString('ru-RU')} абонентов`);
  location.hash = '#/';
  location.reload();
}

/* ---------- маршрутизация ---------- */
function render() {
  if (!App.ready) return;
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/').filter(Boolean);
  const route = parts[0] || 'dash';
  document.querySelectorAll('#mainNav a').forEach(a => {
    a.toggleAttribute('aria-current', false);
    if (a.dataset.route === (route === 'abonent' ? 'abonents' : route === 'service' ? 'dash' : route || 'dash'))
      a.setAttribute('aria-current', 'page');
  });
  window.scrollTo(0, 0);
  if (route === 'dash') return renderDash();
  if (route === 'abonents') return renderAbonents();
  if (route === 'abonent') return renderAbonent(Number(parts[1]));
  if (route === 'service') return renderService(parts[1]);
  if (route === 'billing') return renderBilling();
  if (route === 'payments') return renderPayments();
  if (route === 'reports') return renderReports();
  if (route === 'admin') {
    if (App.security && App.security.hash && App.security.adminLock && sessionStorage.getItem('rkc-admin') !== App.security.hash)
      return renderAdminGate();
    return renderAdmin();
  }
  if (route === 'settings') return renderSettings();
  renderDash();
}

/* ---------- главная ---------- */
function renderDash() {
  const t = totals();
  const lc = lastClosed();
  const st = lc ? App.stats.byYm[lc] : null;
  const period = currentPeriod();

  const svcCards = enabledServices().map(s => {
    const sum = st ? st.accrued[s.key] : 0;
    const vol = st ? st.volume[s.key] : 0;
    return `
      <a class="card svc-card" href="#/service/${s.key}">
        <div class="svc-head"><span class="dot" style="background:${SVC_COLORS[s.key]}"></span>${s.name}</div>
        <div class="svc-meta">${esc(s.provider)} · ${fmtMoney(App.settings.tariffs[s.key])} ₽/${s.unit}</div>
        <div class="svc-nums">
          <span>Начислено${lc ? ' за ' + ymShort(lc) : ''}<b class="num">${fmtCompact(sum)}</b></span>
          <span>Объём<b class="num">${fmtVol(vol)} ${s.unit}</b></span>
        </div>
      </a>`;
  }).join('');

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>Посёлок Кедровый</h1>
        <div class="sub">${App.abonents.length.toLocaleString('ru-RU')} лицевых счетов · расчётный период — ${ymName(period)}</div>
      </div>
      <form class="toolbar" id="quickSearch" role="search">
        <input type="search" placeholder="Лицевой счёт, ФИО или адрес…" id="quickQ" style="min-width:240px">
        <button class="btn secondary">Найти</button>
      </form>
    </div>

    <div class="kpi-row">
      <div class="card kpi"><div class="label">Абонентов</div><div class="value">${App.abonents.length.toLocaleString('ru-RU')}</div><div class="note">${t.subsidized.toLocaleString('ru-RU')} с субсидией</div></div>
      <div class="card kpi"><div class="label">Начислено за ${lc ? ymShort(lc) : '—'}</div><div class="value">${st ? fmtCompact(st.accruedTotal) : '—'}</div><div class="note">субсидии: −${st ? fmtCompact(st.subsidyTotal) : '0'}</div></div>
      <div class="card kpi crit"><div class="label">Задолженность</div><div class="value">${fmtCompact(t.debt)}</div><div class="note">${t.debtors.toLocaleString('ru-RU')} должников</div></div>
      <div class="card kpi crit"><div class="label">Пени (расчётно)</div><div class="value">${fmtCompact(t.penalty)}</div><div class="note">ст. 155 ЖК РФ, на сегодня</div></div>
      <div class="card kpi good"><div class="label">Авансы</div><div class="value">${fmtCompact(t.advance)}</div><div class="note">переплата на счетах</div></div>
    </div>

    <h2 class="eyebrow">Начисления и оплата, 6 месяцев</h2>
    <div class="card pad chart-wrap" id="chartCard">
      <div class="chart-legend">
        <span><span class="dot" style="background:var(--svc-cold)"></span>Начислено</span>
        <span><span class="dot" style="background:var(--svc-hot)"></span>Оплачено</span>
      </div>
      <div class="chart" id="dashChart"></div>
      <div class="chart-tip" id="chartTip"></div>
    </div>

    <h2 class="eyebrow">Услуги</h2>
    <div class="svc-grid">${svcCards}</div>`;

  $('#quickSearch').onsubmit = e => {
    e.preventDefault();
    sessionStorage.setItem('abQuery', $('#quickQ').value.trim());
    location.hash = '#/abonents';
  };
  drawChart();
}

function drawChart() {
  const host = $('#dashChart');
  const months = Object.keys(App.stats.byYm).sort().slice(-6);
  const data = months.map(ym => ({
    ym,
    accrued: App.stats.byYm[ym].accruedTotal || 0,
    paid: App.stats.byYm[ym].paid || 0,
  }));
  if (!data.length) { host.innerHTML = '<div class="empty">Пока нет закрытых периодов</div>'; return; }

  const W = 720, H = 240, padL = 46, padR = 8, padT = 10, padB = 26;
  const max = Math.max(1, ...data.map(d => Math.max(d.accrued, d.paid))) * 1.08;
  const iw = W - padL - padR, ih = H - padT - padB;
  const groupW = iw / data.length;
  const barW = Math.min(34, groupW * 0.32);
  const y = v => padT + ih - (v / max) * ih;

  let bars = '', labels = '', grid = '';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = max / steps * i, yy = y(v);
    grid += `<line class="grid-line" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"></line>
             <text x="${padL - 6}" y="${yy + 4}" text-anchor="end">${v >= 1e6 ? (v / 1e6).toFixed(1) + ' млн' : v > 0 ? Math.round(v / 1000) + ' тыс' : '0'}</text>`;
  }
  data.forEach((d, i) => {
    const cx = padL + groupW * i + groupW / 2;
    bars += `<rect class="bar" data-i="${i}" data-k="accrued" x="${cx - barW - 1}" y="${y(d.accrued)}" width="${barW}" height="${Math.max(0, padT + ih - y(d.accrued))}" fill="var(--svc-cold)"></rect>
             <rect class="bar" data-i="${i}" data-k="paid" x="${cx + 1}" y="${y(d.paid)}" width="${barW}" height="${Math.max(0, padT + ih - y(d.paid))}" fill="var(--svc-hot)"></rect>`;
    labels += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${ymShort(d.ym)}</text>`;
  });

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Начислено и оплачено по месяцам">${grid}${bars}${labels}</svg>`;

  const tip = $('#chartTip');
  host.querySelectorAll('.bar').forEach(r => {
    r.addEventListener('mousemove', e => {
      const d = data[Number(r.dataset.i)];
      const k = r.dataset.k;
      tip.innerHTML = `<b>${ymName(d.ym)}</b><br>${k === 'accrued' ? 'Начислено' : 'Оплачено'}: ${fmtMoney(k === 'accrued' ? d.accrued : d.paid)} ₽`;
      const box = $('#chartCard').getBoundingClientRect();
      tip.style.left = Math.min(e.clientX - box.left + 14, box.width - 180) + 'px';
      tip.style.top = (e.clientY - box.top - 14) + 'px';
      tip.style.opacity = 1;
    });
    r.addEventListener('mouseleave', () => tip.style.opacity = 0);
  });
}

/* ---------- абоненты: список ---------- */
const AbList = { page: 0, per: 50 };

function abonentBadges(ab) {
  const out = [];
  const now = new Date();
  if (ab.installment && ab.balance > 0.005) out.push('<span class="badge sub">Рассрочка</span>');
  else if (ab.balance > 0.005) {
    const pen = penaltyOf(ab, now);
    out.push(pen > 0 ? '<span class="badge debt">Просрочка</span>' : '<span class="badge overdue">Долг</span>');
  } else if (ab.balance < -0.005) out.push('<span class="badge ok">Аванс</span>');
  else out.push('<span class="badge ok">Оплачено</span>');
  if (ab.subsidyOn) out.push('<span class="badge sub">Субсидия</span>');
  return out.join(' ');
}

function renderAbonents() {
  const q = sessionStorage.getItem('abQuery') || '';
  const streets = [...new Set(App.abonents.map(a => a.street))].sort();
  $('#view').innerHTML = `
    <div class="page-head">
      <div><h1>Абоненты</h1><div class="sub">${App.abonents.length.toLocaleString('ru-RU')} лицевых счетов</div></div>
      <div class="toolbar">
        <button class="btn secondary" id="noticesBtn">🖨 Уведомления должникам</button>
        <button class="btn" id="addAb">+ Новый абонент</button>
      </div>
    </div>
    <div class="card pad">
      <div class="toolbar">
        <input type="search" id="abQ" placeholder="Лицевой счёт, ФИО или адрес…" value="${esc(q)}">
        <select id="abFilter">
          <option value="">Все абоненты</option>
          <option value="debt">Должники</option>
          <option value="overdue">С просрочкой (пени)</option>
          <option value="subsidy">С субсидией</option>
          <option value="nometer">Без ИПУ воды</option>
        </select>
        <select id="abStreet"><option value="">Все улицы</option>${streets.map(s => `<option>${esc(s)}</option>`).join('')}</select>
      </div>
      <div class="table-scroll" style="margin-top:12px">
        <table>
          <thead><tr><th>Лицевой счёт</th><th>ФИО</th><th>Адрес</th><th class="num">Чел.</th><th class="num">Площадь</th><th class="num">Задолженность</th><th>Статус</th></tr></thead>
          <tbody id="abRows"></tbody>
        </table>
      </div>
      <div class="pager" id="abPager"></div>
    </div>`;

  const refresh = () => {
    const query = $('#abQ').value.trim().toLowerCase();
    const filter = $('#abFilter').value;
    const street = $('#abStreet').value;
    const now = new Date();
    let list = App.abonents;
    if (query) list = list.filter(a => a.search.includes(query));
    if (street) list = list.filter(a => a.street === street);
    if (filter === 'debt') list = list.filter(a => a.balance > 0.005);
    if (filter === 'overdue') list = list.filter(a => a.balance > 0.005 && penaltyOf(a, now) > 0);
    if (filter === 'subsidy') list = list.filter(a => a.subsidyOn);
    if (filter === 'nometer') list = list.filter(a => !a.meters.cold.has || !a.meters.hot.has);

    const pages = Math.max(1, Math.ceil(list.length / AbList.per));
    AbList.page = Math.min(AbList.page, pages - 1);
    const slice = list.slice(AbList.page * AbList.per, (AbList.page + 1) * AbList.per);

    $('#abRows').innerHTML = slice.map(a => `
      <tr class="click" data-id="${a.id}">
        <td><a href="#/abonent/${a.id}" class="num">${esc(a.account)}</a></td>
        <td>${esc(a.fio)}</td>
        <td class="muted">${esc(a.address)}</td>
        <td class="num">${a.residents}</td>
        <td class="num">${fmtVol(a.area)} м²</td>
        <td class="num ${a.balance > 0.005 ? 'money-neg' : ''}">${a.balance > 0.005 ? fmtMoney(a.balance) + ' ₽' : '—'}</td>
        <td>${abonentBadges(a)}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">Ничего не найдено</td></tr>';

    $('#abPager').innerHTML = `
      <span>${list.length.toLocaleString('ru-RU')} записей</span>
      <button class="btn secondary sm" id="pgPrev" ${AbList.page === 0 ? 'disabled' : ''}>←</button>
      <span class="num">${AbList.page + 1} / ${pages}</span>
      <button class="btn secondary sm" id="pgNext" ${AbList.page >= pages - 1 ? 'disabled' : ''}>→</button>`;
    $('#pgPrev').onclick = () => { AbList.page--; refresh(); };
    $('#pgNext').onclick = () => { AbList.page++; refresh(); };
    document.querySelectorAll('#abRows tr.click').forEach(tr =>
      tr.addEventListener('click', e => { if (e.target.tagName !== 'A') location.hash = '#/abonent/' + tr.dataset.id; }));
  };

  ['abQ', 'abFilter', 'abStreet'].forEach(id => $('#' + id).addEventListener('input', () => { AbList.page = 0; refresh(); }));
  $('#addAb').onclick = showNewAbonentDialog;
  $('#noticesBtn').onclick = () => {
    const query = $('#abQ').value.trim().toLowerCase();
    const street = $('#abStreet').value;
    let list = App.abonents.filter(a => a.balance > 0.005 && !a.installment);
    if (query) list = list.filter(a => a.search.includes(query));
    if (street) list = list.filter(a => a.street === street);
    printNotices(list);
  };
  refresh();
  sessionStorage.removeItem('abQuery');
}

/* Печать уведомлений (претензий) о задолженности: страница на каждого должника.
   Учитывает текущий поиск и фильтр улицы; абоненты с рассрочкой не включаются. */
function printNotices(list) {
  if (!list.length) { toast('Должников по текущему фильтру нет'); return; }
  if (list.length > 400 && !confirm(`Будет напечатано ${list.length.toLocaleString('ru-RU')} уведомлений (страниц). Продолжить?`)) return;
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU');
  $('#printArea').innerHTML = list.map(ab => {
    const months = Object.keys(ab.debtByMonth).sort();
    const pen = penaltyOf(ab, now);
    return `
    <div class="notice">
      <h2>Уведомление о задолженности за жилищно-коммунальные услуги</h2>
      <p>РКЦ «Кедровый» · ${dateStr}<br>
         Кому: <b>${esc(ab.fio)}</b> · ${esc(ab.address)} · лицевой счёт <b>${esc(ab.account)}</b></p>
      <table>
        <thead><tr><th>Период</th><th class="num">Долг, ₽</th><th class="num">Дней просрочки</th><th class="num">Пени, ₽</th></tr></thead>
        <tbody>
          ${months.map(ym => {
            const amount = ab.debtByMonth[ym];
            const days = Math.max(0, Math.floor((now - Billing.dueDate(ym)) / 86400000));
            return `<tr><td>${ymName(ym)}</td><td class="num">${fmtMoney(amount)}</td>
              <td class="num">${days}</td><td class="num">${fmtMoney(Billing.calcPenalty(amount, ym, now, App.settings.keyRate))}</td></tr>`;
          }).join('')}
          <tr><td><b>Итого</b></td><td class="num"><b>${fmtMoney(ab.balance)}</b></td><td></td><td class="num"><b>${fmtMoney(pen)}</b></td></tr>
        </tbody>
      </table>
      <p><b>Всего к оплате: ${fmtMoney(Billing.round2(ab.balance + pen))} ₽.</b></p>
      <p>В соответствии со ст. 155 Жилищного кодекса РФ плата за жилое помещение и коммунальные услуги
         вносится ежемесячно до 10-го числа месяца, следующего за истёкшим. На сумму задолженности
         начисляются пени (ч. 14 ст. 155 ЖК РФ, ключевая ставка ${App.settings.keyRate}% годовых).
         Просим погасить задолженность в течение 30 дней с даты настоящего уведомления.
         При непогашении долга РКЦ вправе обратиться в суд, а также ограничить предоставление
         коммунальных услуг в порядке, предусмотренном ПП РФ №354.</p>
      <p>Оформить рассрочку или уточнить расчёт можно в РКЦ «Кедровый».</p>
    </div>`;
  }).join('');
  window.print();
  toast(`Подготовлено уведомлений: ${list.length.toLocaleString('ru-RU')}`);
}

function showNewAbonentDialog() {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `
    <h2 style="margin:0 0 14px">Новый абонент</h2>
    <form method="dialog" class="grid" id="newAbForm">
      <label class="fld">ФИО<input required name="fio" type="text"></label>
      <div class="fld-row">
        <label class="fld">Улица<input required name="street" type="text" value="ул. "></label>
        <label class="fld">Дом<input required name="house" type="number" min="1" value="1"></label>
        <label class="fld">Кв.<input name="apt" type="number" min="0" value="0"></label>
      </div>
      <div class="fld-row">
        <label class="fld">Площадь, м²<input required name="area" type="number" min="1" step="0.1" value="45"></label>
        <label class="fld">Проживает, чел.<input required name="residents" type="number" min="1" value="2"></label>
        <label class="fld">Доход семьи, ₽/мес<input name="familyIncome" type="number" min="0" value="40000"></label>
      </div>
      <div class="fld-row">
        <label class="fld">ИПУ холодной воды<select name="mcold"><option value="1">Установлен</option><option value="0">Нет</option></select></label>
        <label class="fld">ИПУ горячей воды<select name="mhot"><option value="1">Установлен</option><option value="0">Нет</option></select></label>
        <label class="fld">ИПУ газа<select name="mgas"><option value="1">Установлен</option><option value="0">Нет</option></select></label>
        <label class="fld">ИПУ электроэнергии<select name="melec"><option value="1">Установлен</option><option value="0">Нет</option></select></label>
      </div>
      <div class="toolbar" style="justify-content:flex-end; margin-top:6px">
        <button class="btn secondary" value="cancel" formnovalidate>Отмена</button>
        <button class="btn" value="ok" id="newAbOk">Создать</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'ok') {
      const f = new FormData($('#newAbForm'));
      const id = (App.abonents.reduce((m, a) => Math.max(m, a.id), 0) || 0) + 1;
      const apt = Number(f.get('apt')) || 0;
      const ab = {
        id, account: 'ЛС-' + String(100000 + id),
        fio: f.get('fio').trim(),
        street: f.get('street').trim(), house: Number(f.get('house')), apt,
        address: `${f.get('street').trim()}, д. ${f.get('house')}${apt ? ', кв. ' + apt : ''}`,
        area: Number(f.get('area')), residents: Number(f.get('residents')),
        familyIncome: Number(f.get('familyIncome')) || 0, subsidyOn: false,
        meters: {
          cold: { has: f.get('mcold') === '1', can: true },
          hot: { has: f.get('mhot') === '1', can: true },
          gas: { has: f.get('mgas') === '1', can: true },
          elec: { has: f.get('melec') === '1', can: true },
        },
        balance: 0, debtByMonth: {}, search: '', planId: null,
      };
      ab.search = (ab.account + ' ' + ab.fio + ' ' + ab.address).toLowerCase();
      await DB.put('abonents', ab);
      App.abonents.push(ab); App.byId.set(id, ab);
      toast('Абонент создан: ' + ab.account);
      location.hash = '#/abonent/' + id;
    }
    dlg.remove();
  });
}

/* ---------- карточка абонента ---------- */
async function renderAbonent(id) {
  const ab = App.byId.get(id);
  if (!ab) { $('#view').innerHTML = '<div class="empty card">Абонент не найден</div>'; return; }
  const now = new Date();
  const period = currentPeriod();
  const [charges, payments, curReadings] = await Promise.all([
    DB.byIndex('charges', 'aid', id),
    DB.byIndex('payments', 'aid', id),
    DB.get('readings', [id, period]),
  ]);
  charges.sort((a, b) => b.ym.localeCompare(a.ym) || a.id - b.id);
  payments.sort((a, b) => b.date.localeCompare(a.date));
  const penalty = penaltyOf(ab, now);

  // последние переданные показания для подстановки "предыдущих"
  const allReadings = [];
  for (const ym of [...App.closedMonths].reverse()) {
    const r = await DB.get('readings', [id, ym]);
    if (r) { allReadings.push(r); break; }
  }
  const prevOf = key => {
    if (curReadings && curReadings[key]) return curReadings[key].prev;
    if (allReadings[0] && allReadings[0][key]) return allReadings[0][key].curr;
    return 0;
  };
  const currOf = key => (curReadings && curReadings[key] ? curReadings[key].curr : '');

  const debtRows = Object.keys(ab.debtByMonth).sort().map(ym => {
    const amount = ab.debtByMonth[ym];
    const days = Math.max(0, Math.floor((now - Billing.dueDate(ym)) / 86400000));
    const pen = ab.installment ? 0 : Billing.calcPenalty(amount, ym, now, App.settings.keyRate);
    return `<tr><td>${ymName(ym)}</td><td class="num">${fmtMoney(amount)} ₽</td>
      <td class="num">${days}</td><td class="num ${pen > 0 ? 'money-neg' : ''}">${fmtMoney(pen)} ₽</td></tr>`;
  }).join('');

  // превью субсидии за следующий период (по тарифному плану абонента)
  const previewRows = Billing.calcCharges(ab, curReadings, effSettings(ab));
  const previewSum = previewRows.reduce((s, r) => s + r.sum, 0);
  const previewSubsidy = Billing.calcSubsidy(ab, previewSum, App.settings);

  const historyByYm = {};
  for (const c of charges) (historyByYm[c.ym] = historyByYm[c.ym] || []).push(c);
  const histMonths = Object.keys(historyByYm).sort().reverse();
  const histHtml = histMonths.map(ym => {
    const rows = historyByYm[ym];
    const sum = rows.reduce((s, r) => s + r.sum, 0);
    return `
      <tr class="total"><td colspan="4">${ymName(ym)}</td><td class="num">${fmtMoney(sum)} ₽</td></tr>
      ${rows.map(r => `<tr>
        <td>${r.service === 'subsidy' ? 'Субсидия' : esc(svcByKey(r.service).name)}</td>
        <td class="muted">${esc(r.method)}</td>
        <td class="num">${r.service === 'subsidy' ? '—' : fmtVol(r.volume) + ' ' + r.unit}</td>
        <td class="num">${r.service === 'subsidy' ? '' : fmtMoney(r.tariff)}</td>
        <td class="num ${r.sum < 0 ? 'money-pos' : ''}">${fmtMoney(r.sum)} ₽</td>
      </tr>`).join('')}`;
  }).join('');

  const meterInput = key => {
    const m = ab.meters[key];
    const s = svcByKey(key);
    if (!m.has) return `<label class="fld">${s.name}<input type="text" disabled value="ИПУ не установлен${m.can ? ' (норматив ×' + App.settings.raisingCoef + ')' : ''}"></label>`;
    return `<label class="fld">${s.name} — было: <span class="num">${fmtVol(prevOf(key))}</span>
      <input type="number" step="0.001" min="0" name="r_${key}" value="${currOf(key)}" placeholder="текущее показание"></label>`;
  };

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(ab.fio)}</h1>
        <div class="sub num">${esc(ab.account)} · ${esc(ab.address)} · ${fmtVol(ab.area)} м² · ${ab.residents} чел. ${abonentBadges(ab)}</div>
      </div>
      <div class="toolbar">
        <button class="btn secondary" id="receiptBtn">🖨 Квитанция</button>
        <button class="btn danger sm" id="delAb">Удалить</button>
      </div>
    </div>

    <div class="kpi-row">
      <div class="card kpi ${ab.balance > 0.005 ? 'crit' : 'good'}"><div class="label">${ab.balance >= 0 ? 'Задолженность' : 'Аванс'}</div>
        <div class="value">${fmtMoney(Math.abs(ab.balance))} <small>₽</small></div></div>
      <div class="card kpi ${penalty > 0 ? 'crit' : ''}"><div class="label">Пени на сегодня</div><div class="value">${fmtMoney(penalty)} <small>₽</small></div><div class="note">ст. 155 ЖК РФ, ставка ${App.settings.keyRate}%</div></div>
      <div class="card kpi"><div class="label">Начисление за ${ymShort(period)} (прогноз)</div><div class="value">${fmtMoney(previewSum - previewSubsidy)} <small>₽</small></div><div class="note">${previewSubsidy > 0 ? 'с учётом субсидии −' + fmtMoney(previewSubsidy) + ' ₽' : 'без субсидии'}</div></div>
    </div>

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); margin-top:14px">
      <section class="card pad">
        <h2 class="eyebrow">Показания за ${ymName(period)}</h2>
        <form id="readingsForm" class="grid">
          ${meterInput('cold')}${meterInput('hot')}${meterInput('gas')}${meterInput('elec')}
          <button class="btn" style="justify-self:start">Сохранить показания</button>
        </form>
        <p class="note-law">Если показания не переданы до закрытия периода, начисление выполняется по нормативу (п. 42 ПП №354).</p>
      </section>

      <section class="card pad">
        <h2 class="eyebrow">Приём платежа</h2>
        <form id="payForm" class="fld-row">
          <label class="fld">Сумма, ₽<input type="number" step="0.01" min="0.01" name="sum" value="${ab.balance > 0 ? fmtMoney(ab.balance).replace(/\s/g, '').replace(',', '.') : ''}" required></label>
          <button class="btn">Принять платёж</button>
        </form>
        <p class="note-law">Платёж разносится на самые старые долги (FIFO). Переплата хранится как аванс.</p>

        <h2 class="eyebrow">Субсидия (ст. 159 ЖК РФ) и тарифный план</h2>
        <form id="subsidyForm" class="fld-row">
          <label class="fld">Доход семьи, ₽/мес<input type="number" min="0" step="100" name="familyIncome" value="${ab.familyIncome || 0}"></label>
          <label class="fld">Субсидия<select name="subsidyOn"><option value="0"${ab.subsidyOn ? '' : ' selected'}>не назначена</option><option value="1"${ab.subsidyOn ? ' selected' : ''}>назначена</option></select></label>
          <label class="fld">Тарифный план<select name="planId">
            <option value="">Базовый</option>
            ${App.plans.map(p => `<option value="${esc(p.id)}"${ab.planId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select></label>
          <button class="btn secondary">Сохранить</button>
        </form>
        <p class="note-law" id="subsidyPreview"></p>
      </section>
    </div>

    ${ab.installment ? `
    <h2 class="eyebrow">Рассрочка долга</h2>
    <div class="card pad">
      <p class="small">Соглашение от ${ab.installment.createdAt}: долг <b class="num">${fmtMoney(ab.installment.total)} ₽</b>
        на ${ab.installment.schedule.length} мес. Пени на реструктуризированный долг не начисляются, пока действует рассрочка.</p>
      <div class="table-scroll" style="margin-top:8px">
        <table>
          <thead><tr><th>Платёж</th><th>Оплатить до</th><th class="num">Сумма, ₽</th></tr></thead>
          <tbody>${ab.installment.schedule.map((r, i) => {
            const due = Billing.dueDate(r.ym);
            return `<tr><td>${i + 1} — ${ymName(r.ym)}</td>
              <td class="num ${due < now ? 'money-neg' : ''}">${due.toLocaleDateString('ru-RU')}</td>
              <td class="num">${fmtMoney(r.sum)}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <div class="toolbar" style="margin-top:12px">
        <button class="btn danger sm" id="cancelInst">Расторгнуть рассрочку</button>
        <span class="muted small">При расторжении пени снова начисляются по ст. 155 ЖК РФ.</span>
      </div>
    </div>` : ab.balance > 0.005 ? `
    <h2 class="eyebrow">Рассрочка долга</h2>
    <form class="card pad toolbar" id="instForm">
      <span class="small">Оформить рассрочку долга <b class="num">${fmtMoney(ab.balance)} ₽</b> на</span>
      <select name="months">${[3, 6, 12, 18, 24].map(m => `<option value="${m}"${m === 6 ? ' selected' : ''}>${m} мес.</option>`).join('')}</select>
      <button class="btn secondary sm">Оформить</button>
      <span class="muted small">Пени замораживаются, долг гасится равными долями начиная со следующего месяца.</span>
    </form>` : ''}

    <h2 class="eyebrow">Задолженность по месяцам и пени</h2>
    <div class="card table-scroll">
      <table>
        <thead><tr><th>Период</th><th class="num">Остаток долга</th><th class="num">Дней с срока оплаты</th><th class="num">Пени</th></tr></thead>
        <tbody>${debtRows || '<tr><td colspan="4" class="empty">Задолженности нет</td></tr>'}</tbody>
      </table>
    </div>
    <p class="note-law">Срок оплаты — до 10-го числа следующего месяца. Пени: с 31-го дня просрочки — 1/300 ключевой ставки ЦБ за каждый день, с 91-го — 1/130 (ч. 14 ст. 155 ЖК РФ). Рассчитаны на сегодня по ставке ${App.settings.keyRate}% годовых.</p>

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
      <section>
        <h2 class="eyebrow">Начисления</h2>
        <div class="card table-scroll" style="max-height:420px; overflow-y:auto">
          <table>
            <thead><tr><th>Услуга</th><th>Способ</th><th class="num">Объём</th><th class="num">Тариф</th><th class="num">Сумма</th></tr></thead>
            <tbody>${histHtml || '<tr><td colspan="5" class="empty">Начислений пока нет</td></tr>'}</tbody>
          </table>
        </div>
      </section>
      <section>
        <h2 class="eyebrow">Платежи</h2>
        <div class="card table-scroll" style="max-height:420px; overflow-y:auto">
          <table>
            <thead><tr><th>Дата</th><th class="num">Сумма</th></tr></thead>
            <tbody>${payments.map(p => `<tr><td class="num">${p.date}</td><td class="num money-pos">${fmtMoney(p.sum)} ₽</td></tr>`).join('') || '<tr><td colspan="2" class="empty">Платежей пока нет</td></tr>'}</tbody>
          </table>
        </div>
      </section>
    </div>`;

  const updSubsidyPreview = () => {
    const income = Number($('#subsidyForm [name=familyIncome]').value) || 0;
    const on = $('#subsidyForm [name=subsidyOn]').value === '1';
    const trial = Billing.calcSubsidy({ ...ab, familyIncome: income, subsidyOn: on }, previewSum, App.settings);
    const s = App.settings.subsidy;
    $('#subsidyPreview').textContent = on
      ? `Расчёт: ССЖКУр ${fmtMoney(s.costStandardPerPerson)} ₽ × ${ab.residents} чел. − МДД ${s.maxShare}% × доход. Субсидия за месяц: ${fmtMoney(trial)} ₽.`
      : 'Субсидия не назначена. Назначьте, если расходы семьи на ЖКУ превышают максимально допустимую долю дохода.';
  };
  updSubsidyPreview();
  $('#subsidyForm').addEventListener('input', updSubsidyPreview);

  $('#readingsForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const rec = { aid: id, ym: period };
    for (const key of Object.keys(Billing.METERED)) {
      if (!ab.meters[key].has) continue;
      const curr = Number(f.get('r_' + key));
      if (!curr) continue;
      rec[key] = { prev: prevOf(key), curr };
    }
    await DB.put('readings', rec);
    toast('Показания сохранены');
    renderAbonent(id);
  };

  $('#payForm').onsubmit = async e => {
    e.preventDefault();
    const sum = Billing.round2(Number(new FormData(e.target).get('sum')));
    if (!(sum > 0)) return;
    await takePayment(ab, sum);
    toast(`Платёж ${fmtMoney(sum)} ₽ принят`);
    renderAbonent(id);
  };

  $('#subsidyForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    ab.familyIncome = Number(f.get('familyIncome')) || 0;
    ab.subsidyOn = f.get('subsidyOn') === '1';
    ab.planId = f.get('planId') || null;
    await DB.put('abonents', ab);
    toast('Параметры абонента сохранены');
    renderAbonent(id);
  };

  const instForm = $('#instForm');
  if (instForm) instForm.onsubmit = async e => {
    e.preventDefault();
    const months = Number(new FormData(instForm).get('months'));
    if (!confirm(`Оформить рассрочку долга ${fmtMoney(ab.balance)} ₽ на ${months} мес.?`)) return;
    ab.installment = {
      total: ab.balance,
      createdAt: todayISO(),
      schedule: Billing.buildInstallment(ab.balance, months, currentPeriod()),
    };
    await DB.put('abonents', ab);
    toast('Рассрочка оформлена');
    renderAbonent(id);
  };
  const cancelInst = $('#cancelInst');
  if (cancelInst) cancelInst.onclick = async () => {
    if (!confirm('Расторгнуть соглашение о рассрочке? Пени снова будут начисляться.')) return;
    delete ab.installment;
    await DB.put('abonents', ab);
    toast('Рассрочка расторгнута');
    renderAbonent(id);
  };

  $('#delAb').onclick = async () => {
    if (!confirm(`Удалить абонента ${ab.account} (${ab.fio}) вместе с историей начислений и платежей?`)) return;
    for (const c of charges) await DB.del('charges', c.id);
    for (const p of payments) await DB.del('payments', p.id);
    for (const ym of [...App.closedMonths, period]) await DB.del('readings', [id, ym]).catch(() => {});
    await DB.del('abonents', id);
    App.abonents = App.abonents.filter(a => a.id !== id);
    App.byId.delete(id);
    toast('Абонент удалён');
    location.hash = '#/abonents';
  };

  $('#receiptBtn').onclick = () => printReceipt(ab, historyByYm, histMonths);
}

async function takePayment(ab, sum) {
  await DB.put('payments', { aid: ab.id, date: todayISO(), sum });
  const alloc = Billing.allocatePayment(ab.debtByMonth, sum);
  ab.debtByMonth = alloc.debtByMonth;
  ab.balance = Billing.round2(ab.balance - sum);
  if (ab.installment && ab.balance <= 0.005) delete ab.installment; // долг погашен — рассрочка исполнена
  await DB.put('abonents', ab);
  const ym = todayISO().slice(0, 7);
  if (!App.stats.byYm[ym]) App.stats.byYm[ym] = { accrued: {}, volume: {}, accruedTotal: 0, subsidyTotal: 0, paid: 0, count: 0 };
  App.stats.byYm[ym].paid = Billing.round2((App.stats.byYm[ym].paid || 0) + sum);
  await DB.kvSet('stats', App.stats);
}

function printReceipt(ab, historyByYm, histMonths) {
  const ym = histMonths[0];
  if (!ym) { toast('Нет закрытых начислений для квитанции'); return; }
  const rows = historyByYm[ym];
  const sum = rows.reduce((s, r) => s + r.sum, 0);
  const pen = ab.installment ? 0 : Billing.calcPenalty(ab.debtByMonth[ym] || 0, ym, new Date(), App.settings.keyRate);
  $('#printArea').innerHTML = `
    <h2>Квитанция на оплату ЖКУ — ${ymName(ym)}</h2>
    <p>РКЦ «Кедровый» · Лицевой счёт: <b>${esc(ab.account)}</b><br>
       ${esc(ab.fio)} · ${esc(ab.address)} · площадь ${fmtVol(ab.area)} м², проживает ${ab.residents} чел.</p>
    <table>
      <thead><tr><th>Услуга</th><th>Расчёт</th><th class="num">Объём</th><th class="num">Тариф, ₽</th><th class="num">Сумма, ₽</th></tr></thead>
      <tbody>
        ${rows.map(r => `<tr>
          <td>${r.service === 'subsidy' ? 'Субсидия (ст. 159 ЖК РФ)' : esc(svcByKey(r.service).name)}</td>
          <td>${esc(r.method)}</td>
          <td class="num">${r.service === 'subsidy' ? '—' : fmtVol(r.volume) + ' ' + r.unit}</td>
          <td class="num">${r.service === 'subsidy' ? '—' : fmtMoney(r.tariff)}</td>
          <td class="num">${fmtMoney(r.sum)}</td></tr>`).join('')}
        <tr><td colspan="4"><b>Итого за ${ymName(ym)}</b></td><td class="num"><b>${fmtMoney(sum)}</b></td></tr>
        ${pen > 0 ? `<tr><td colspan="4">Пени на дату печати (ст. 155 ЖК РФ)</td><td class="num">${fmtMoney(pen)}</td></tr>` : ''}
        ${ab.balance > 0.005 ? `<tr><td colspan="4"><b>Всего к оплате с учётом долга</b></td><td class="num"><b>${fmtMoney(ab.balance + pen)}</b></td></tr>` : ''}
      </tbody>
    </table>
    <p>Оплатить до 10-го числа следующего месяца (ч. 1 ст. 155 ЖК РФ). Дата печати: ${todayISO()}.</p>`;
  window.print();
}

/* ---------- страница услуги ---------- */
const SvcPage = { page: 0, per: 50, ym: null };

async function renderService(key) {
  const svc = svcByKey(key);
  if (!svc) { location.hash = '#/'; return; }
  const months = [...App.closedMonths].reverse();
  SvcPage.ym = SvcPage.ym && months.includes(SvcPage.ym) ? SvcPage.ym : months[0] || null;
  const st = SvcPage.ym ? App.stats.byYm[SvcPage.ym] : null;

  const normField = {
    cold: ['coldPerPerson', 'Норматив, м³/чел·мес'],
    hot: ['hotPerPerson', 'Норматив, м³/чел·мес'],
    gas: ['gasPerPerson', 'Норматив, м³/чел·мес'],
    elec: ['elecPerPerson', 'Норматив, кВт·ч/чел·мес'],
    heat: ['heatPerM2', 'Норматив, Гкал/м²·мес'],
    sewer: [null, null],
    tko: [null, null],
  }[key];

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1><span class="dot" style="background:${SVC_COLORS[key]}; display:inline-block; width:14px; height:14px; border-radius:4px; margin-right:6px"></span>${svc.name}</h1>
        <div class="sub">${esc(svc.provider)} · тариф ${fmtMoney(App.settings.tariffs[key])} ₽/${svc.unit}</div>
      </div>
      <a class="btn secondary" href="#/">← На главную</a>
    </div>

    <div class="kpi-row">
      <div class="card kpi"><div class="label">Начислено за ${SvcPage.ym ? ymShort(SvcPage.ym) : '—'}</div><div class="value">${st ? fmtCompact(st.accrued[key]) : '—'}</div></div>
      <div class="card kpi"><div class="label">Объём за ${SvcPage.ym ? ymShort(SvcPage.ym) : '—'}</div><div class="value">${st ? fmtVol(st.volume[key]) : '—'} <small>${svc.unit}</small></div></div>
      <div class="card kpi"><div class="label">Лицевых счетов</div><div class="value">${st ? st.count.toLocaleString('ru-RU') : '—'}</div></div>
    </div>

    <h2 class="eyebrow">Тариф и норматив</h2>
    <form class="card pad fld-row" id="svcForm">
      <label class="fld">Тариф, ₽/${svc.unit}<input type="number" step="0.01" min="0" name="tariff" value="${App.settings.tariffs[key]}"></label>
      ${normField[0] ? `<label class="fld">${normField[1]}<input type="number" step="0.001" min="0" name="norm" value="${App.settings.norms[normField[0]]}"></label>` : ''}
      <button class="btn">Сохранить</button>
      <p class="note-law" style="grid-column:1/-1; margin:0">${key === 'sewer' ? 'Объём водоотведения равен сумме объёмов холодной и горячей воды (п. 42 ПП №354), отдельный норматив не применяется.' : key === 'tko' ? 'Вывоз ТКО начисляется по количеству проживающих: тариф × человек.' : 'Новый тариф применяется к следующим начислениям; закрытые периоды не пересчитываются.'}</p>
    </form>

    <h2 class="eyebrow">Начисления за период</h2>
    <div class="card pad">
      <div class="toolbar">
        <select id="svcYm">${months.map(m => `<option value="${m}"${m === SvcPage.ym ? ' selected' : ''}>${ymName(m)}</option>`).join('')}</select>
        <span class="muted small" id="svcCount"></span>
      </div>
      <div class="table-scroll" style="margin-top:12px">
        <table>
          <thead><tr><th>Лицевой счёт</th><th>Абонент</th><th>Способ</th><th class="num">Объём, ${svc.unit}</th><th class="num">Сумма, ₽</th></tr></thead>
          <tbody id="svcRows"></tbody>
        </table>
      </div>
      <div class="pager" id="svcPager"></div>
    </div>`;

  $('#svcForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    App.settings.tariffs[key] = Number(f.get('tariff')) || App.settings.tariffs[key];
    if (normField[0]) App.settings.norms[normField[0]] = Number(f.get('norm')) || App.settings.norms[normField[0]];
    await DB.kvSet('settings', App.settings);
    toast('Тариф сохранён');
    renderService(key);
  };
  $('#svcYm').onchange = () => { SvcPage.ym = $('#svcYm').value; SvcPage.page = 0; renderService(key); };

  const loadPage = async () => {
    if (!SvcPage.ym) { $('#svcRows').innerHTML = '<tr><td colspan="5" class="empty">Нет закрытых периодов</td></tr>'; return; }
    const range = IDBKeyRange.only([SvcPage.ym, key]);
    const [rows, count] = await Promise.all([
      DB.pageByIndex('charges', 'ym_service', range, SvcPage.page * SvcPage.per, SvcPage.per),
      DB.countByIndex('charges', 'ym_service', range),
    ]);
    $('#svcCount').textContent = count.toLocaleString('ru-RU') + ' начислений';
    $('#svcRows').innerHTML = rows.map(r => {
      const ab = App.byId.get(r.aid);
      return `<tr class="click" data-id="${r.aid}">
        <td><a href="#/abonent/${r.aid}" class="num">${ab ? esc(ab.account) : r.aid}</a></td>
        <td>${ab ? esc(ab.fio) : '—'}</td>
        <td class="muted">${esc(r.method)}</td>
        <td class="num">${fmtVol(r.volume)}</td>
        <td class="num">${fmtMoney(r.sum)}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">Нет данных</td></tr>';
    const pages = Math.max(1, Math.ceil(count / SvcPage.per));
    $('#svcPager').innerHTML = `
      <button class="btn secondary sm" id="svcPrev" ${SvcPage.page === 0 ? 'disabled' : ''}>←</button>
      <span class="num">${SvcPage.page + 1} / ${pages}</span>
      <button class="btn secondary sm" id="svcNext" ${SvcPage.page >= pages - 1 ? 'disabled' : ''}>→</button>`;
    $('#svcPrev').onclick = () => { SvcPage.page--; loadPage(); };
    $('#svcNext').onclick = () => { SvcPage.page++; loadPage(); };
    document.querySelectorAll('#svcRows tr.click').forEach(tr =>
      tr.addEventListener('click', e => { if (e.target.tagName !== 'A') location.hash = '#/abonent/' + tr.dataset.id; }));
  };
  loadPage();
}

/* ---------- начисления (закрытие периода) ---------- */
function renderBilling() {
  const period = currentPeriod();
  const closed = [...App.closedMonths].reverse();
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Начисления</h1>
      <div class="sub">Формирование ежемесячных начислений по всем лицевым счетам</div></div></div>

    <div class="card pad">
      <h2 class="eyebrow">Текущий расчётный период — ${ymName(period)}</h2>
      <p class="muted small" style="max-width:70ch">По каждому абоненту: 5 услуг по переданным показаниям ИПУ или по нормативу
        (с повышающим коэффициентом ${App.settings.raisingCoef} при наличии техвозможности установки ИПУ), водоотведение — по сумме
        объёмов воды, отопление — по площади. Субсидии (ст. 159 ЖК РФ) учитываются отдельной строкой со знаком минус.</p>
      <div class="toolbar" style="margin-top:12px">
        <button class="btn" id="closeBtn">Сформировать начисления за ${ymName(period)}</button>
        <span class="muted small">${App.abonents.length.toLocaleString('ru-RU')} лицевых счетов</span>
      </div>
      <div id="closeProgress" style="margin-top:16px" hidden>
        <div class="progress"><div id="closeBar" style="width:0%"></div></div>
        <p class="muted small" id="closeMsg" style="margin-top:8px"></p>
      </div>
    </div>

    <h2 class="eyebrow">Выгрузка квитанций</h2>
    <div class="card pad toolbar">
      <select id="exportYm" ${closed.length ? '' : 'disabled'}>
        ${closed.map(ym => `<option value="${ym}">${ymName(ym)}</option>`).join('') || '<option>нет закрытых периодов</option>'}
      </select>
      <button class="btn secondary" id="exportXlsx" ${closed.length ? '' : 'disabled'}>⬇ Квитанции в Excel по всем абонентам</button>
      <span class="muted small" id="exportMsg"></span>
    </div>

    <h2 class="eyebrow">Закрытые периоды</h2>
    <div class="card table-scroll">
      <table>
        <thead><tr><th>Период</th><th class="num">Начислено, ₽</th><th class="num">Субсидии, ₽</th><th class="num">Оплачено в месяце, ₽</th><th class="num">Счетов</th></tr></thead>
        <tbody>
          ${closed.map(ym => {
            const st = App.stats.byYm[ym] || {};
            return `<tr><td>${ymName(ym)}</td>
              <td class="num">${fmtMoney(st.accruedTotal || 0)}</td>
              <td class="num">−${fmtMoney(st.subsidyTotal || 0)}</td>
              <td class="num">${fmtMoney((App.stats.byYm[nextYm(ym)] || {}).paid || 0)}</td>
              <td class="num">${(st.count || 0).toLocaleString('ru-RU')}</td></tr>`;
          }).join('') || '<tr><td colspan="5" class="empty">Периоды ещё не закрывались</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="note-law">Пени не фиксируются в начислениях: они рассчитываются динамически на дату просмотра/оплаты
      по ч. 14 ст. 155 ЖК РФ и показываются в карточке абонента и квитанции.</p>`;

  $('#closeBtn').onclick = () => closePeriod(period);
  if (closed.length) $('#exportXlsx').onclick = () => exportReceipts($('#exportYm').value);
}

/* Выгрузка реестра квитанций за месяц в Excel: строка на каждого абонента. */
async function exportReceipts(ym) {
  const msg = $('#exportMsg');
  msg.textContent = 'Формируем файл…';
  const charges = await DB.byIndex('charges', 'ym', ym);
  const byAid = new Map();
  for (const c of charges) {
    let agg = byAid.get(c.aid);
    if (!agg) byAid.set(c.aid, agg = { total: 0 });
    agg[c.service] = Billing.round2((agg[c.service] || 0) + c.sum);
    agg.total = Billing.round2(agg.total + c.sum);
  }

  const now = new Date();
  const svcCols = Billing.SERVICES.map(s => s.key);
  const header = ['Лицевой счёт', 'ФИО', 'Адрес', 'Площадь, м²', 'Проживает',
    ...Billing.SERVICES.map(s => s.name + ', ₽'), 'Субсидия, ₽', `Итого за ${ymName(ym)}, ₽`,
    'Долг всего, ₽', 'Пени (ст. 155 ЖК РФ), ₽', 'Всего к оплате, ₽'];
  const rows = [header];

  for (const ab of App.abonents) {
    const agg = byAid.get(ab.id);
    if (!agg) continue;
    const debt = Math.max(0, ab.balance);
    const pen = penaltyOf(ab, now);
    rows.push([
      ab.account, ab.fio, ab.address, ab.area, ab.residents,
      ...svcCols.map(k => agg[k] || 0),
      -(agg.subsidy || 0), agg.total, debt, pen, Billing.round2(debt + pen),
    ]);
  }

  const nCols = header.length;
  const moneyCols = new Set(Array.from({ length: nCols - 5 }, (_, i) => i + 5));
  const widths = [13, 34, 34, 11, 10, ...Array(nCols - 5).fill(14)];
  const size = XLSXMini.download(`kvitancii-${ym}.xlsx`, 'Квитанции ' + ym, rows, { headerRows: 1, widths, moneyCols });
  msg.textContent = `Готово: ${(rows.length - 1).toLocaleString('ru-RU')} квитанций, ${(size / 1048576).toFixed(1)} МБ`;
  toast('Файл квитанций сформирован');
}

async function closePeriod(ym) {
  if (!App.abonents.length) { toast('В базе нет абонентов'); return; }
  if (!confirm(`Сформировать начисления за ${ymName(ym)} по ${App.abonents.length.toLocaleString('ru-RU')} лицевым счетам?`)) return;
  $('#closeBtn').disabled = true;
  $('#closeProgress').hidden = false;
  // прогресс обновляем только пока элементы на экране — уход со страницы не прерывает закрытие
  const setBar = w => { const el = $('#closeBar'); if (el) el.style.width = w; };
  const setMsg = t => { const el = $('#closeMsg'); if (el) el.textContent = t; };

  // показания за период — одним чтением
  const allReadings = await DB.getAll('readings');
  const readingsByAid = new Map();
  for (const r of allReadings) if (r.ym === ym) readingsByAid.set(r.aid, r);

  const st = { accrued: {}, volume: {}, accruedTotal: 0, subsidyTotal: 0, paid: (App.stats.byYm[ym] || {}).paid || 0, count: 0 };
  for (const s of Billing.SERVICES) { st.accrued[s.key] = 0; st.volume[s.key] = 0; }

  const chargeRows = [];
  for (const ab of App.abonents) {
    const rows = Billing.calcCharges(ab, readingsByAid.get(ab.id) || null, effSettings(ab));
    let monthSum = 0;
    for (const r of rows) {
      chargeRows.push({ aid: ab.id, ym, ...r });
      st.accrued[r.service] = Billing.round2(st.accrued[r.service] + r.sum);
      st.volume[r.service] = Billing.round3(st.volume[r.service] + r.volume);
      monthSum += r.sum;
    }
    const subsidy = Billing.calcSubsidy(ab, monthSum, App.settings);
    if (subsidy > 0) {
      chargeRows.push({ aid: ab.id, ym, service: 'subsidy', method: 'ст. 159 ЖК РФ', volume: 1, unit: 'мес', tariff: -subsidy, sum: -subsidy });
      st.subsidyTotal = Billing.round2(st.subsidyTotal + subsidy);
    }
    const net = Billing.round2(monthSum - subsidy);
    st.accruedTotal = Billing.round2(st.accruedTotal + net);
    st.count++;
    // аванс закрывает начисление сразу
    if (ab.balance < 0) {
      const advance = Math.min(-ab.balance, net);
      const rest = Billing.round2(net - advance);
      if (rest > 0) ab.debtByMonth[ym] = rest;
      ab.balance = Billing.round2(ab.balance + net);
    } else {
      ab.debtByMonth[ym] = net;
      ab.balance = Billing.round2(ab.balance + net);
    }
  }

  setMsg('Записываем начисления…');
  await DB.bulkPut('charges', chargeRows, 4000, (done, total) => {
    setBar(Math.round(done / total * 70) + '%');
    setMsg(`Начисления: ${done.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')}`);
  });
  setMsg('Обновляем лицевые счета…');
  await DB.bulkPut('abonents', App.abonents, 4000, (done, total) => {
    setBar(70 + Math.round(done / total * 30) + '%');
  });

  App.stats.byYm[ym] = st;
  App.closedMonths.push(ym);
  await DB.kvSet('stats', App.stats);
  await DB.kvSet('closedMonths', App.closedMonths);
  toast(`Период ${ymName(ym)} закрыт: начислено ${fmtCompact(st.accruedTotal)}`);
  if ((location.hash || '#/').startsWith('#/billing')) renderBilling();
}

/* ---------- платежи ---------- */
async function renderPayments() {
  const recent = await DB.pageByIndex('payments', 'date', null, 0, 1e9).then(rows => rows.slice(-80).reverse());
  const todayYm = todayISO().slice(0, 7);
  const paidThisMonth = (App.stats.byYm[todayYm] || {}).paid || 0;

  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Платежи</h1>
      <div class="sub">Оплачено в ${ymName(todayYm)}: <b class="num">${fmtMoney(paidThisMonth)} ₽</b></div></div></div>

    <div class="card pad">
      <h2 class="eyebrow">Быстрый приём платежа</h2>
      <form id="quickPay" class="toolbar">
        <input type="search" id="qpQuery" placeholder="Лицевой счёт, ФИО или адрес…" style="flex:2">
        <input type="number" id="qpSum" step="0.01" min="0.01" placeholder="Сумма, ₽" style="width:140px" required>
        <button class="btn">Принять</button>
      </form>
      <div id="qpMatches" class="small" style="margin-top:8px"></div>
    </div>

    <h2 class="eyebrow">Последние платежи</h2>
    <div class="card table-scroll">
      <table>
        <thead><tr><th>Дата</th><th>Лицевой счёт</th><th>Абонент</th><th class="num">Сумма, ₽</th></tr></thead>
        <tbody>
          ${recent.map(p => {
            const ab = App.byId.get(p.aid);
            return `<tr><td class="num">${p.date}</td>
              <td>${ab ? `<a href="#/abonent/${ab.id}" class="num">${esc(ab.account)}</a>` : p.aid}</td>
              <td>${ab ? esc(ab.fio) : '—'}</td>
              <td class="num money-pos">${fmtMoney(p.sum)}</td></tr>`;
          }).join('') || '<tr><td colspan="4" class="empty">Платежей пока нет</td></tr>'}
        </tbody>
      </table>
    </div>`;

  let selected = null;
  const matches = $('#qpMatches');
  $('#qpQuery').addEventListener('input', () => {
    const q = $('#qpQuery').value.trim().toLowerCase();
    selected = null;
    if (q.length < 2) { matches.innerHTML = ''; return; }
    const found = App.abonents.filter(a => a.search.includes(q)).slice(0, 6);
    matches.innerHTML = found.map(a =>
      `<button type="button" class="btn secondary sm" data-id="${a.id}" style="margin:3px 4px 0 0">${esc(a.account)} · ${esc(a.fio)}${a.balance > 0 ? ' · долг ' + fmtMoney(a.balance) + ' ₽' : ''}</button>`).join('') || '<span class="muted">Не найдено</span>';
    matches.querySelectorAll('button').forEach(b => b.onclick = () => {
      selected = App.byId.get(Number(b.dataset.id));
      $('#qpQuery').value = selected.account + ' · ' + selected.fio;
      if (selected.balance > 0) $('#qpSum').value = selected.balance.toFixed(2);
      matches.innerHTML = `<span class="badge sub">Выбран: ${esc(selected.account)}</span>`;
    });
  });
  $('#quickPay').onsubmit = async e => {
    e.preventDefault();
    if (!selected) { toast('Сначала выберите абонента из списка'); return; }
    const sum = Billing.round2(Number($('#qpSum').value));
    if (!(sum > 0)) return;
    await takePayment(selected, sum);
    toast(`Платёж ${fmtMoney(sum)} ₽ принят: ${selected.account}`);
    renderPayments();
  };
}

/* ---------- отчёты: улицы и дома ---------- */
async function renderReports() {
  const ym = lastClosed();
  const now = new Date();
  const charges = ym ? await DB.byIndex('charges', 'ym', ym) : [];
  const accruedByAid = new Map();
  for (const c of charges) accruedByAid.set(c.aid, Billing.round2((accruedByAid.get(c.aid) || 0) + c.sum));

  const mk = () => ({ accounts: 0, accrued: 0, debt: 0, penalty: 0, debtors: 0 });
  const add = (agg, ab) => {
    agg.accounts++;
    agg.accrued = Billing.round2(agg.accrued + (accruedByAid.get(ab.id) || 0));
    if (ab.balance > 0.005) { agg.debt = Billing.round2(agg.debt + ab.balance); agg.debtors++; }
    agg.penalty = Billing.round2(agg.penalty + penaltyOf(ab, now));
  };

  const streets = new Map();
  for (const ab of App.abonents) {
    let st = streets.get(ab.street);
    if (!st) streets.set(ab.street, st = { ...mk(), houses: new Map() });
    add(st, ab);
    let h = st.houses.get(ab.house);
    if (!h) st.houses.set(ab.house, h = mk());
    add(h, ab);
  }
  const sorted = [...streets.entries()].sort((a, b) => b[1].debt - a[1].debt);

  const cells = a => `
    <td class="num">${a.accounts.toLocaleString('ru-RU')}</td>
    <td class="num">${fmtMoney(a.accrued)}</td>
    <td class="num ${a.debt > 0 ? 'money-neg' : ''}">${fmtMoney(a.debt)}</td>
    <td class="num">${a.debtors.toLocaleString('ru-RU')}</td>
    <td class="num ${a.penalty > 0 ? 'money-neg' : ''}">${fmtMoney(a.penalty)}</td>`;

  $('#view').innerHTML = `
    <div class="page-head">
      <div><h1>Отчёт по улицам и домам</h1>
        <div class="sub">Начислено за ${ym ? ymName(ym) : '—'} · долги и пени на сегодня · улицы отсортированы по долгу</div></div>
      <button class="btn secondary" id="reportXlsx">⬇ Выгрузить в Excel</button>
    </div>
    <div class="card table-scroll">
      <table>
        <thead><tr><th>Улица / дом</th><th class="num">Счетов</th><th class="num">Начислено, ₽</th>
          <th class="num">Долг, ₽</th><th class="num">Должников</th><th class="num">Пени, ₽</th></tr></thead>
        <tbody>
          ${sorted.map(([street, st], si) => `
            <tr class="click street-row" data-si="${si}">
              <td><b>${esc(street)}</b> <span class="muted small">· ${st.houses.size} дом.</span></td>${cells(st)}
            </tr>
            ${[...st.houses.entries()].sort((a, b) => a[0] - b[0]).map(([house, h]) => `
              <tr class="house-row" data-si="${si}" hidden>
                <td style="padding-left:28px" class="muted">д. ${house}</td>${cells(h)}
              </tr>`).join('')}`).join('') || '<tr><td colspan="6" class="empty">Нет данных</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="note-law">Нажмите на улицу, чтобы раскрыть дома. Пени рассчитаны на сегодня по ставке ${App.settings.keyRate}% (абоненты с рассрочкой — без пеней).</p>`;

  document.querySelectorAll('.street-row').forEach(tr => tr.addEventListener('click', () => {
    document.querySelectorAll(`.house-row[data-si="${tr.dataset.si}"]`).forEach(r => r.hidden = !r.hidden);
  }));

  $('#reportXlsx').onclick = () => {
    const rows = [['Улица', 'Дом', 'Лицевых счетов', `Начислено за ${ym ? ymName(ym) : '—'}, ₽`, 'Долг, ₽', 'Должников', 'Пени, ₽']];
    for (const [street, st] of sorted) {
      rows.push([street, 'вся улица', st.accounts, st.accrued, st.debt, st.debtors, st.penalty]);
      for (const [house, h] of [...st.houses.entries()].sort((a, b) => a[0] - b[0]))
        rows.push([street, 'д. ' + house, h.accounts, h.accrued, h.debt, h.debtors, h.penalty]);
    }
    XLSXMini.download(`otchet-ulicy-${ym || 'tekushchij'}.xlsx`, 'По улицам и домам', rows,
      { headerRows: 1, widths: [26, 12, 14, 16, 14, 12, 14], moneyCols: new Set([3, 4, 6]) });
    toast('Отчёт выгружен в Excel');
  };
}

/* ---------- администрирование ---------- */
function renderAdmin() {
  const en = App.settings.enabledServices;
  const planUsers = id => App.abonents.filter(a => a.planId === id).length;
  const baseUsers = App.abonents.filter(a => !a.planId || !planById(a.planId)).length;

  const planCard = (p, isBase) => `
    <form class="card pad plan-form" data-plan="${isBase ? '' : esc(p.id)}">
      <div class="toolbar" style="margin-bottom:10px">
        ${isBase
          ? `<b>Базовый план</b><span class="badge plain">по умолчанию</span>`
          : `<input type="text" name="name" value="${esc(p.name)}" required style="font-weight:700; max-width:240px">`}
        <span class="badge sub num">${isBase ? baseUsers.toLocaleString('ru-RU') : planUsers(p.id).toLocaleString('ru-RU')} абонентов</span>
        <span class="spacer"></span>
        <button class="btn sm">Сохранить</button>
        ${!isBase ? `<button type="button" class="btn danger sm" data-del="${esc(p.id)}" ${planUsers(p.id) ? 'disabled title="План назначен абонентам"' : ''}>Удалить</button>` : ''}
      </div>
      <div class="fld-row">
        ${Billing.SERVICES.map(s => `<label class="fld">${s.name}, ₽/${s.unit}
          <input type="number" step="0.01" min="0" name="t_${s.key}" value="${(isBase ? App.settings.tariffs : p.tariffs)[s.key] ?? App.settings.tariffs[s.key]}"></label>`).join('')}
      </div>
    </form>`;

  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Администрирование</h1>
      <div class="sub">Действующие услуги и тарифные планы посёлка</div></div></div>

    <h2 class="eyebrow">Действующие услуги</h2>
    <form class="card pad" id="svcToggles">
      <div class="fld-row" style="grid-template-columns:repeat(auto-fit,minmax(190px,1fr))">
        ${Billing.SERVICES.map(s => `
          <label style="display:flex; align-items:center; gap:9px; cursor:pointer">
            <input type="checkbox" name="en_${s.key}" ${!en || en[s.key] !== false ? 'checked' : ''}>
            <span class="dot" style="background:${SVC_COLORS[s.key]}"></span>${s.name}
          </label>`).join('')}
      </div>
      <div class="toolbar" style="margin-top:14px"><button class="btn">Сохранить услуги</button></div>
      <p class="note-law">Отключённая услуга не попадает в новые начисления и скрывается с главной страницы.
        Уже закрытые периоды не пересчитываются.</p>
    </form>

    <h2 class="eyebrow">Тарифные планы</h2>
    <p class="muted small" style="max-width:74ch; margin-top:-4px">Базовый план действует для всех абонентов по умолчанию.
      Дополнительные планы (например, льготный или коммерческий) подключаются конкретному абоненту в его карточке —
      начисления считаются по тарифам его плана.</p>
    <div class="grid">
      ${planCard(null, true)}
      ${App.plans.map(p => planCard(p, false)).join('')}
    </div>
    <div class="toolbar" style="margin-top:14px">
      <button class="btn secondary" id="addPlan">+ Новый тарифный план</button>
    </div>`;

  $('#svcToggles').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    App.settings.enabledServices = Object.fromEntries(Billing.SERVICES.map(s => [s.key, f.get('en_' + s.key) === 'on']));
    if (!Object.values(App.settings.enabledServices).some(Boolean)) { toast('Нельзя отключить все услуги сразу'); return; }
    await DB.kvSet('settings', App.settings);
    toast('Список действующих услуг сохранён');
    renderAdmin();
  };

  document.querySelectorAll('.plan-form').forEach(form => {
    form.onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(form);
      const tariffs = Object.fromEntries(Billing.SERVICES.map(s => [s.key, Number(f.get('t_' + s.key)) || 0]));
      const pid = form.dataset.plan;
      if (!pid) {
        App.settings.tariffs = tariffs;
        await DB.kvSet('settings', App.settings);
        toast('Базовые тарифы сохранены');
      } else {
        const p = planById(pid);
        p.name = String(f.get('name') || p.name).trim() || p.name;
        p.tariffs = tariffs;
        await DB.kvSet('tariffPlans', App.plans);
        toast(`План «${p.name}» сохранён`);
      }
      renderAdmin();
    };
  });

  document.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    const p = planById(btn.dataset.del);
    if (!p || !confirm(`Удалить тарифный план «${p.name}»?`)) return;
    App.plans = App.plans.filter(x => x.id !== p.id);
    await DB.kvSet('tariffPlans', App.plans);
    toast('План удалён');
    renderAdmin();
  });

  $('#addPlan').onclick = async () => {
    const name = prompt('Название тарифного плана (например, «Льготный −30%»):', 'Новый план');
    if (!name) return;
    const id = 'plan-' + ((App.plans.reduce((m, p) => Math.max(m, Number(p.id.split('-')[1]) || 0), 0) || 0) + 1);
    App.plans.push({ id, name: name.trim(), tariffs: { ...App.settings.tariffs } });
    await DB.kvSet('tariffPlans', App.plans);
    toast(`План «${name.trim()}» создан — задайте тарифы и сохраните`);
    renderAdmin();
  };
}

/* ---------- настройки ---------- */
function renderSettings() {
  const s = App.settings;
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Настройки</h1>
      <div class="sub">Тарифы, нормативы, ставки и региональные стандарты</div></div></div>

    <form id="setForm">
      <p class="muted small">Тарифы, тарифные планы и состав действующих услуг настраиваются в разделе <a href="#/admin">Админ</a>.</p>
      <h2 class="eyebrow">Нормативы потребления (без ИПУ)</h2>
      <div class="card pad fld-row">
        <label class="fld">Холодная вода, м³/чел·мес<input type="number" step="0.001" min="0" name="n_cold" value="${s.norms.coldPerPerson}"></label>
        <label class="fld">Горячая вода, м³/чел·мес<input type="number" step="0.001" min="0" name="n_hot" value="${s.norms.hotPerPerson}"></label>
        <label class="fld">Газ, м³/чел·мес<input type="number" step="0.001" min="0" name="n_gas" value="${s.norms.gasPerPerson}"></label>
        <label class="fld">Электроэнергия, кВт·ч/чел·мес<input type="number" step="1" min="0" name="n_elec" value="${s.norms.elecPerPerson}"></label>
        <label class="fld">Отопление, Гкал/м²·мес<input type="number" step="0.0001" min="0" name="n_heat" value="${s.norms.heatPerM2}"></label>
        <label class="fld">Повышающий коэффициент<input type="number" step="0.1" min="1" name="raising" value="${s.raisingCoef}"></label>
      </div>

      <h2 class="eyebrow">Пени и субсидии</h2>
      <div class="card pad fld-row">
        <label class="fld">Ключевая ставка ЦБ, % годовых<input type="number" step="0.25" min="0" name="keyRate" value="${s.keyRate}"></label>
        <label class="fld">МДД — макс. доля расходов, %<input type="number" step="1" min="0" max="100" name="maxShare" value="${s.subsidy.maxShare}"></label>
        <label class="fld">Стандарт стоимости ЖКУ, ₽/чел·мес<input type="number" step="10" min="0" name="costStd" value="${s.subsidy.costStandardPerPerson}"></label>
        <label class="fld">Прожиточный минимум, ₽/мес<input type="number" step="100" min="0" name="livingMin" value="${s.subsidy.livingMin}"></label>
      </div>
      <p class="note-law">Пени: ч. 14 ст. 155 ЖК РФ — с 31-го дня просрочки 1/300 ключевой ставки за день, с 91-го — 1/130.
        Субсидия: ст. 159 ЖК РФ и ПП №761 — ССЖКУр × n − МДД × Д, с поправочным коэффициентом при доходе ниже прожиточного минимума.</p>

      <div class="toolbar" style="margin-top:14px"><button class="btn">Сохранить настройки</button></div>
    </form>

    <h2 class="eyebrow">Безопасность</h2>
    <form class="card pad" id="secForm">
      <div class="fld-row">
        ${App.security && App.security.hash ? '<label class="fld">Текущий пароль<input type="password" name="oldPw" autocomplete="current-password"></label>' : ''}
        <label class="fld">${App.security && App.security.hash ? 'Новый пароль (пусто — оставить прежний)' : 'Пароль на вход'}<input type="password" name="newPw" autocomplete="new-password"></label>
        <label class="fld">Повторите пароль<input type="password" name="newPw2" autocomplete="new-password"></label>
      </div>
      <label style="display:flex; align-items:center; gap:8px; margin-top:12px; cursor:pointer">
        <input type="checkbox" name="adminLock" ${App.security && App.security.adminLock ? 'checked' : ''}>
        Дополнительно запрашивать пароль при входе в раздел «Админ»
      </label>
      <div class="toolbar" style="margin-top:12px"><button class="btn secondary">Сохранить</button>
        ${App.security && App.security.hash ? '<button type="button" class="btn danger sm" id="dropPw">Убрать пароль</button>' : ''}
        <span class="muted small" id="secMsg">${App.security && App.security.hash ? 'Пароль установлен.' : 'Пароль не установлен — вход свободный.'}</span></div>
      <p class="note-law">Пароль защищает интерфейс на этом устройстве (хранится в виде хэша).
        Это не шифрование данных: для строгой защиты используйте отдельный профиль браузера или устройство.</p>
    </form>

    <h2 class="eyebrow">Данные</h2>
    <div class="card pad toolbar">
      <button class="btn secondary" id="exportBtn">Экспорт базы (JSON)</button>
      <label class="btn secondary" style="cursor:pointer">Импорт базы<input type="file" id="importFile" accept=".json" hidden></label>
      <span class="spacer"></span>
      <button class="btn danger" id="resetBtn">Очистить базу…</button>
    </div>
    <p class="note-law">База данных хранится локально в браузере (IndexedDB) и никуда не передаётся.
      Экспортируйте резервную копию перед сменой устройства или очисткой данных браузера.</p>`;

  $('#setForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    s.norms.coldPerPerson = Number(f.get('n_cold')) || 0;
    s.norms.hotPerPerson = Number(f.get('n_hot')) || 0;
    s.norms.gasPerPerson = Number(f.get('n_gas')) || 0;
    s.norms.elecPerPerson = Number(f.get('n_elec')) || 0;
    s.norms.heatPerM2 = Number(f.get('n_heat')) || 0;
    s.raisingCoef = Number(f.get('raising')) || 1;
    s.keyRate = Number(f.get('keyRate')) || 0;
    s.subsidy.maxShare = Number(f.get('maxShare')) || 0;
    s.subsidy.costStandardPerPerson = Number(f.get('costStd')) || 0;
    s.subsidy.livingMin = Number(f.get('livingMin')) || 0;
    await DB.kvSet('settings', s);
    toast('Настройки сохранены');
  };

  $('#secForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const cur = App.security && App.security.hash;
    if (cur && await sha256(String(f.get('oldPw') || '')) !== cur) {
      $('#secMsg').textContent = 'Текущий пароль неверный.';
      return;
    }
    const p1 = String(f.get('newPw') || ''), p2 = String(f.get('newPw2') || '');
    const adminLock = f.get('adminLock') === 'on';
    if (!p1 && cur) { // пароль не меняется — обновляем только настройку админ-замка
      App.security.adminLock = adminLock;
      await DB.kvSet('security', App.security);
      if (!adminLock) sessionStorage.setItem('rkc-admin', cur);
      toast('Настройки безопасности сохранены');
      renderSettings();
      return;
    }
    if (!p1) {
      $('#secMsg').textContent = 'Введите пароль, чтобы включить защиту.';
      return;
    }
    if (p1.length < 4) { $('#secMsg').textContent = 'Пароль слишком короткий (минимум 4 символа).'; return; }
    if (p1 !== p2) { $('#secMsg').textContent = 'Пароли не совпадают.'; return; }
    const hash = await sha256(p1);
    App.security = { hash, adminLock };
    await DB.kvSet('security', App.security);
    sessionStorage.setItem('rkc-auth', hash);
    sessionStorage.setItem('rkc-admin', hash);
    toast('Пароль установлен');
    renderSettings();
  };

  const dropPw = $('#dropPw');
  if (dropPw) dropPw.onclick = async () => {
    const oldPw = prompt('Для удаления пароля введите текущий пароль:');
    if (oldPw === null) return;
    if (await sha256(oldPw) !== App.security.hash) { toast('Пароль неверный'); return; }
    App.security = null;
    await DB.kvSet('security', null);
    sessionStorage.removeItem('rkc-auth'); sessionStorage.removeItem('rkc-admin');
    toast('Пароль удалён');
    renderSettings();
  };

  $('#exportBtn').onclick = async () => {
    toast('Готовим экспорт…');
    const dump = {
      version: 2, exportedAt: new Date().toISOString(),
      settings: App.settings, closedMonths: App.closedMonths, stats: App.stats, tariffPlans: App.plans, security: App.security,
      abonents: await DB.getAll('abonents'),
      readings: await DB.getAll('readings'),
      charges: await DB.getAll('charges'),
      payments: await DB.getAll('payments'),
    };
    const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rkc-kedrovy-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $('#importFile').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Импорт заменит текущую базу данных. Продолжить?')) return;
    try {
      const dump = JSON.parse(await file.text());
      if (!dump.settings || !Array.isArray(dump.abonents)) throw new Error('bad format');
      await DB.wipe();
      await DB.bulkPut('abonents', dump.abonents);
      await DB.bulkPut('readings', dump.readings || []);
      await DB.bulkPut('charges', dump.charges || []);
      await DB.bulkPut('payments', dump.payments || []);
      await DB.kvSet('settings', dump.settings);
      await DB.kvSet('closedMonths', dump.closedMonths || []);
      await DB.kvSet('stats', dump.stats || { byYm: {} });
      await DB.kvSet('tariffPlans', dump.tariffPlans || []);
      await DB.kvSet('security', dump.security || null);
      toast('База импортирована');
      location.reload();
    } catch (err) {
      toast('Не удалось импортировать: проверьте файл');
    }
  };

  $('#resetBtn').onclick = async () => {
    if (!confirm('Полностью удалить базу данных (абоненты, начисления, платежи)? Действие необратимо.')) return;
    await DB.wipe();
    location.reload();
  };
}

/* ---------- запуск ---------- */
window.addEventListener('hashchange', render);
init().catch(err => {
  $('#view').innerHTML = `<div class="card empty">Не удалось открыть базу данных: ${esc(err && err.message)}</div>`;
});
