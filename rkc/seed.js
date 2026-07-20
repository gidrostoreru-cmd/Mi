/* Генератор демонстрационной базы посёлка: абоненты, счётчики, показания,
   закрытые расчётные периоды и платёжная история. Детерминированный PRNG,
   чтобы демо-база воспроизводилась одинаково. */
'use strict';

const Seed = (() => {
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SURNAMES = ['Иванов', 'Петров', 'Смирнов', 'Кузнецов', 'Попов', 'Васильев', 'Соколов', 'Михайлов', 'Фёдоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев', 'Семёнов', 'Егоров', 'Павлов', 'Козлов', 'Степанов', 'Николаев', 'Орлов', 'Андреев', 'Макаров', 'Никитин', 'Захаров', 'Зайцев', 'Соловьёв', 'Борисов', 'Яковлев', 'Григорьев', 'Романов', 'Воробьёв', 'Сергеев', 'Фролов', 'Александров', 'Дмитриев', 'Королёв', 'Гусев', 'Киселёв', 'Ильин', 'Максимов'];
  const NAMES_M = ['Александр', 'Сергей', 'Владимир', 'Андрей', 'Алексей', 'Дмитрий', 'Николай', 'Евгений', 'Михаил', 'Иван', 'Виктор', 'Юрий', 'Олег', 'Павел', 'Константин'];
  const NAMES_F = ['Елена', 'Ольга', 'Наталья', 'Татьяна', 'Ирина', 'Светлана', 'Людмила', 'Марина', 'Галина', 'Анна', 'Мария', 'Надежда', 'Валентина', 'Екатерина', 'Юлия'];
  const PATR_M = ['Александрович', 'Сергеевич', 'Владимирович', 'Андреевич', 'Алексеевич', 'Дмитриевич', 'Николаевич', 'Иванович', 'Михайлович', 'Викторович', 'Петрович', 'Юрьевич'];
  const PATR_F = ['Александровна', 'Сергеевна', 'Владимировна', 'Андреевна', 'Алексеевна', 'Дмитриевна', 'Николаевна', 'Ивановна', 'Михайловна', 'Викторовна', 'Петровна', 'Юрьевна'];
  const STREETS = ['ул. Центральная', 'ул. Лесная', 'ул. Кедровая', 'ул. Советская', 'ул. Молодёжная', 'ул. Школьная', 'ул. Заречная', 'ул. Полевая', 'ул. Сосновая', 'ул. Гагарина', 'ул. Мира', 'пер. Строителей', 'ул. Набережная', 'ул. Северная'];

  function makeAbonent(i, rnd) {
    const female = rnd() < 0.54;
    const surname = SURNAMES[(rnd() * SURNAMES.length) | 0] + (female ? 'а' : '');
    const name = (female ? NAMES_F : NAMES_M)[(rnd() * 15) | 0];
    const patr = (female ? PATR_F : PATR_M)[(rnd() * 12) | 0];
    const street = STREETS[(rnd() * STREETS.length) | 0];
    const house = 1 + ((rnd() * 42) | 0);
    const isFlat = rnd() < 0.72;
    const apt = isFlat ? 1 + ((rnd() * 60) | 0) : 0;
    const residents = 1 + ((rnd() * rnd() * 5) | 0);
    const area = Math.round((28 + rnd() * 62 + residents * 6) * 10) / 10;
    const meter = p => {
      const has = rnd() < p;
      return { has, can: has ? true : rnd() < 0.9 };
    };
    const familyIncome = Math.round((16000 + rnd() * rnd() * 150000) / 100) * 100;
    // субсидию оформляют семьи с низким доходом на человека
    const subsidyOn = familyIncome / residents < 17000 && rnd() < 0.75;
    // платёжное поведение закреплено за абонентом: исправный / частичный / неплательщик
    const pr = rnd();
    const payerType = pr < 0.87 ? 'full' : pr < 0.94 ? 'half' : 'none';
    return {
      id: i,
      account: 'ЛС-' + String(100000 + i),
      fio: `${surname} ${name} ${patr}`,
      street, house, apt,
      address: `${street}, д. ${house}${apt ? ', кв. ' + apt : ''}`,
      area, residents, familyIncome, subsidyOn, payerType,
      meters: { cold: meter(0.72), hot: meter(0.66), gas: meter(0.55), elec: meter(0.85) },
      balance: 0,          // текущий долг (+) / аванс (−)
      debtByMonth: {},     // остатки долга по месяцам для расчёта пеней
      search: '',          // строка для поиска, заполняется ниже
    };
  }

  /* Генерация показаний за месяц: правдоподобный расход вокруг норматива. */
  function makeReadings(ab, prevReadings, rnd, settings) {
    const n = settings.norms;
    const out = { aid: ab.id, ym: '', cold: null, hot: null, gas: null, elec: null };
    for (const key of Object.keys(Billing.METERED)) {
      if (!ab.meters[key] || !ab.meters[key].has) continue;
      const perPerson = n[Billing.METERED[key]];
      const prev = prevReadings && prevReadings[key] ? prevReadings[key].curr : Math.round(rnd() * 400);
      const use = Math.max(0.2, perPerson * ab.residents * (0.55 + rnd() * 0.9));
      out[key] = { prev, curr: Math.round((prev + use) * 1000) / 1000 };
    }
    return out;
  }

  /* Полная генерация демо-базы.
     opts: {count, months: ['2026-04', ...], settings, onProgress(step, done, total)} */
  async function generate(opts) {
    const { count, months, settings, onProgress } = opts;
    const rnd = mulberry32(20260401);
    const abonents = [];
    for (let i = 1; i <= count; i++) {
      const ab = makeAbonent(i, rnd);
      ab.search = (ab.account + ' ' + ab.fio + ' ' + ab.address).toLowerCase();
      abonents.push(ab);
    }

    const stats = { byYm: {} };
    const prevByAb = new Map();
    let chargeRows = [], readingRows = [], paymentRows = [];

    for (const ym of months) {
      const st = { accrued: {}, volume: {}, accruedTotal: 0, subsidyTotal: 0, paid: 0, count: 0 };
      for (const s of Billing.SERVICES) { st.accrued[s.key] = 0; st.volume[s.key] = 0; }

      for (const ab of abonents) {
        const readings = makeReadings(ab, prevByAb.get(ab.id), rnd, settings);
        readings.ym = ym;
        prevByAb.set(ab.id, readings);
        readingRows.push(readings);

        const rows = Billing.calcCharges(ab, readings, settings);
        let monthSum = 0;
        for (const r of rows) {
          chargeRows.push({ aid: ab.id, ym, ...r });
          st.accrued[r.service] = Billing.round2(st.accrued[r.service] + r.sum);
          st.volume[r.service] = Billing.round3(st.volume[r.service] + r.volume);
          monthSum += r.sum;
        }
        const subsidy = Billing.calcSubsidy(ab, monthSum, settings);
        if (subsidy > 0) {
          chargeRows.push({ aid: ab.id, ym, service: 'subsidy', method: 'ст. 159 ЖК РФ', volume: 1, unit: 'мес', tariff: -subsidy, sum: -subsidy });
          st.subsidyTotal = Billing.round2(st.subsidyTotal + subsidy);
        }
        const net = Billing.round2(monthSum - subsidy);
        st.accruedTotal = Billing.round2(st.accruedTotal + net);
        st.count++;
        ab.debtByMonth[ym] = net;
        ab.balance = Billing.round2(ab.balance + net);

        // платёжное поведение: исправные гасят весь долг, частичные платят половину
        let paySum = 0;
        if (ab.payerType === 'full') paySum = ab.balance > 0 ? ab.balance : 0;
        else if (ab.payerType === 'half') paySum = Billing.round2(net * 0.5);
        if (paySum > 0) {
          const [y, m] = ym.split('-').map(Number);
          const day = 1 + ((rnd() * 9) | 0);
          const date = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          paymentRows.push({ aid: ab.id, date, sum: paySum });
          const alloc = Billing.allocatePayment(ab.debtByMonth, paySum);
          ab.debtByMonth = alloc.debtByMonth;
          ab.balance = Billing.round2(ab.balance - paySum);
          const payYm = date.slice(0, 7);
          stats.byYm[payYm] = stats.byYm[payYm] || null; // месяц платежа может не быть расчётным
          st.paidRegistered = true;
        }
      }
      stats.byYm[ym] = Object.assign(stats.byYm[ym] || {}, st);
    }

    // суммы платежей раскладываем по месяцу даты платежа
    for (const p of paymentRows) {
      const ym = p.date.slice(0, 7);
      if (!stats.byYm[ym]) stats.byYm[ym] = { accrued: {}, volume: {}, accruedTotal: 0, subsidyTotal: 0, paid: 0, count: 0 };
      stats.byYm[ym].paid = Billing.round2((stats.byYm[ym].paid || 0) + p.sum);
    }

    // запись в БД порциями с прогрессом
    const total = abonents.length + readingRows.length + chargeRows.length + paymentRows.length;
    let written = 0;
    const track = label => (done, all) => onProgress && onProgress(label, written + done, total);
    await DB.bulkPut('abonents', abonents, 4000, track('абоненты'));
    written += abonents.length;
    await DB.bulkPut('readings', readingRows, 4000, track('показания'));
    written += readingRows.length;
    await DB.bulkPut('charges', chargeRows, 4000, track('начисления'));
    written += chargeRows.length;
    await DB.bulkPut('payments', paymentRows, 4000, track('платежи'));
    written += paymentRows.length;

    await DB.kvSet('settings', settings);
    await DB.kvSet('closedMonths', months.slice());
    await DB.kvSet('stats', stats);
    await DB.kvSet('seeded', { count, at: new Date().toISOString() });
    return { abonents: abonents.length, charges: chargeRows.length, payments: paymentRows.length };
  }

  return { generate };
})();

if (typeof window !== 'undefined') window.Seed = Seed;
