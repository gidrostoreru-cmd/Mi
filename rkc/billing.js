/* Расчётный движок РКЦ.
   Чистые функции без побочных эффектов — используются приложением и тестами.

   Нормативная база (упрощённая модель):
   - Постановление Правительства РФ № 354: плата по ИПУ либо по нормативу,
     повышающий коэффициент 1,5 при наличии техвозможности установки ИПУ (п. 42);
     водоотведение = объём ХВС + объём ГВС (п. 42, без повышающего коэффициента).
   - ст. 155 ЖК РФ ч. 14: пени с 31-го дня просрочки 1/300 ключевой ставки ЦБ
     за день, с 91-го дня — 1/130. Срок оплаты — до 10-го числа следующего месяца.
   - ст. 159 ЖК РФ, ПП РФ № 761: субсидия = ССЖКУр × n − МДД × Д,
     при среднедушевом доходе ниже прожиточного минимума МДД корректируется
     коэффициентом К = доход на человека / прожиточный минимум. */
'use strict';

const SERVICES = [
  { key: 'cold',  name: 'Холодная вода', unit: 'м³',   provider: 'Водоканал' },
  { key: 'hot',   name: 'Горячая вода',  unit: 'м³',   provider: 'Теплосети' },
  { key: 'sewer', name: 'Водоотведение', unit: 'м³',   provider: 'Водоканал' },
  { key: 'heat',  name: 'Отопление',     unit: 'Гкал', provider: 'Теплосети' },
  { key: 'gas',   name: 'Газоснабжение', unit: 'м³',   provider: 'Газовая служба' },
];

const DEFAULT_SETTINGS = {
  tariffs: { cold: 45.60, hot: 215.40, sewer: 32.80, heat: 2450.00, gas: 7.60 },
  norms: {
    coldPerPerson: 4.85,   // м³ на человека в месяц
    hotPerPerson: 3.11,    // м³ на человека в месяц
    gasPerPerson: 10.40,   // м³ на человека в месяц (плита + подогрев)
    heatPerM2: 0.019,      // Гкал на м² в месяц (1/12 годового объёма)
  },
  raisingCoef: 1.5,        // повышающий коэффициент при отсутствии ИПУ (п. 42 ПП №354)
  keyRate: 16.0,           // ключевая ставка ЦБ РФ, % годовых (настраивается)
  subsidy: {
    maxShare: 22,          // МДД: максимально допустимая доля расходов на ЖКУ, %
    costStandardPerPerson: 3850, // ССЖКУр: региональный стандарт стоимости ЖКУ, ₽/чел·мес
    livingMin: 14500,      // прожиточный минимум на человека, ₽/мес
  },
};

const round2 = x => Math.round(x * 100) / 100;
const round3 = x => Math.round(x * 1000) / 1000;

/* Объём услуги по счётчику: neотрицательная разница показаний. */
function meterVolume(prev, curr) {
  const p = Number(prev) || 0, c = Number(curr) || 0;
  return c > p ? round3(c - p) : 0;
}

/* Начисления абоненту за месяц по всем услугам.
   abonent: {area, residents, meters: {cold:{has,can}, hot:{...}, gas:{...}}}
   readings: {cold:{prev,curr}, hot:{...}, gas:{...}} | null
   Возвращает массив строк начислений {service, method, volume, unit, tariff, sum}. */
function calcCharges(abonent, readings, settings) {
  const t = settings.tariffs, n = settings.norms, k = settings.raisingCoef;
  const rows = [];
  const vols = {}; // базовые объёмы для водоотведения

  for (const key of ['cold', 'hot', 'gas']) {
    const meter = (abonent.meters && abonent.meters[key]) || { has: false, can: true };
    const perPerson = key === 'cold' ? n.coldPerPerson : key === 'hot' ? n.hotPerPerson : n.gasPerPerson;
    const r = readings && readings[key];
    let volume, method, coef = 1;
    if (meter.has && r && (Number(r.curr) || 0) > 0) {
      volume = meterVolume(r.prev, r.curr);
      method = 'ИПУ';
    } else if (meter.has) {
      // счётчик есть, показания не переданы — среднее заменяем нормативом без коэффициента
      volume = round3(perPerson * abonent.residents);
      method = 'Норматив (нет показаний)';
    } else {
      volume = round3(perPerson * abonent.residents);
      coef = meter.can ? k : 1;
      method = coef > 1 ? `Норматив ×${k}` : 'Норматив';
    }
    vols[key] = volume;
    rows.push({ service: key, method, volume, unit: 'м³', tariff: t[key], sum: round2(volume * t[key] * coef) });
  }

  // Водоотведение: сумма объёмов ХВС и ГВС, повышающий коэффициент не применяется
  const sewerVol = round3(vols.cold + vols.hot);
  rows.splice(2, 0, { service: 'sewer', method: 'ХВС + ГВС', volume: sewerVol, unit: 'м³', tariff: t.sewer, sum: round2(sewerVol * t.sewer) });

  // Отопление: по площади, равномерно в течение года (1/12)
  const heatVol = round3(n.heatPerM2 * abonent.area);
  rows.splice(3, 0, { service: 'heat', method: 'По площади (1/12)', volume: heatVol, unit: 'Гкал', tariff: t.heat, sum: round2(heatVol * t.heat) });

  return rows;
}

/* Субсидия на оплату ЖКУ (ст. 159 ЖК РФ, ПП №761).
   С = ССЖКУр × n − (МДД × К / 100) × Д, где К = min(1, доход на чел. / ПМ).
   Не может превышать фактическое начисление за месяц и не бывает отрицательной. */
function calcSubsidy(abonent, monthAccrued, settings) {
  if (!abonent.subsidyOn) return 0;
  const s = settings.subsidy;
  const income = Number(abonent.familyIncome) || 0;
  const nPeople = Math.max(1, abonent.residents);
  const perCapita = income / nPeople;
  const K = perCapita < s.livingMin && s.livingMin > 0 ? perCapita / s.livingMin : 1;
  const value = s.costStandardPerPerson * nPeople - (s.maxShare * K / 100) * income;
  return round2(Math.max(0, Math.min(value, monthAccrued)));
}

/* Срок оплаты за месяц ym ("2026-06") — 10-е число следующего месяца (ст. 155 ЖК РФ). */
function dueDate(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 10); // m — уже индекс следующего месяца (январь = 0)
}

/* Пени по ст. 155 ЖК РФ ч. 14 на сумму долга amount за месяц ym на дату onDate.
   Дни 1–30 просрочки — пени не начисляются, 31–90 — 1/300 ставки в день, с 91-го — 1/130. */
function calcPenalty(amount, ym, onDate, keyRate) {
  if (amount <= 0) return 0;
  const overdueDays = Math.floor((onDate - dueDate(ym)) / 86400000);
  if (overdueDays < 31) return 0;
  const d300 = Math.min(overdueDays, 90) - 30;
  const d130 = Math.max(0, overdueDays - 90);
  return round2(amount * (keyRate / 100) * (d300 / 300 + d130 / 130));
}

/* Пени по всем месяцам долга: debtByMonth = {"2026-04": 1234.56, ...} */
function calcPenaltyTotal(debtByMonth, onDate, keyRate) {
  let total = 0;
  for (const ym of Object.keys(debtByMonth)) {
    total += calcPenalty(debtByMonth[ym], ym, onDate, keyRate);
  }
  return round2(total);
}

/* Разнесение платежа по долгам FIFO (сначала самые старые месяцы).
   Возвращает {debtByMonth, leftover} — новый объект долгов и неразнесённый остаток (аванс). */
function allocatePayment(debtByMonth, sum) {
  const result = {};
  let rest = sum;
  for (const ym of Object.keys(debtByMonth).sort()) {
    const debt = debtByMonth[ym];
    if (rest >= debt) { rest = round2(rest - debt); }
    else { result[ym] = round2(debt - rest); rest = 0; }
  }
  return { debtByMonth: result, leftover: round2(rest) };
}

const Billing = {
  SERVICES, DEFAULT_SETTINGS, round2, round3,
  meterVolume, calcCharges, calcSubsidy, dueDate, calcPenalty, calcPenaltyTotal, allocatePayment,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Billing;
if (typeof window !== 'undefined') window.Billing = Billing;
