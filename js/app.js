/*
 * Незалежний демонстраційний концепт форуму вигаданого міста Veltmoor (не пов’язаний з жодним чинним RP-проєктом).
 * Працює лише з локальними демоданими (js/data.js): без мережевих запитів,
 * API, бази даних чи облікових записів. Усе, що створює користувач,
 * живе в пам'яті вкладки й зникає після оновлення сторінки.
 */
(() => {
  'use strict';

  const D = window.DEMO_DATA;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  /* ---------- Стан ---------- */
  // Розділи редагуються на екрані керування, тому це живий список, а не копія структури
  const ROWS = D.STRUCTURE.flatMap(g => g.rows.map(r => ({ visibility: 'public', topicsBy: 'players', visHistory: [], ...r, group: g })));
  const topics = structuredClone(D.TOPICS);
  let replySeq = 0;
  const isAppeal = t => !!D.KINDS[t.kind]?.appeal;
  topics.forEach(t => {
    // Тип теми (хто може відповідати) — окреме налаштування, незалежне від закриття
    t.access ||= D.KINDS[t.kind]?.info ? 'info' : 'discussion';
    if (isAppeal(t)) t.status ||= 'open'; else delete t.status;
    t.replies.forEach(r => { r.id = `${t.id}-r${++replySeq}`; });
  });
  /* ---------- Утиліти ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const word = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };
  const plural = (n, one, few, many) => `${n.toLocaleString('uk-UA')} ${word(n, one, few, many)}`;
  const dateFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
  const dateTimeFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDate = iso => dateFmt.format(new Date(iso));
  const fmtDateTime = iso => dateTimeFmt.format(new Date(iso));
  const localIso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const hhmm = d => d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

  const state = {
    userId: D.DEMO_LOGIN.player, clockOffset: 0, draftSeq: 0, sectionSeq: 0, history: {}, selReply: {}, replyTo: null, shownTopic: null,
    drafts: {}, replyFiles: {}, editing: null, editDraft: '' // чернетки не губляться при перемальовуванні
  };

  /*
   * ДЕМО-ВХІД, А НЕ ЗАХИСТ. Облікові записи, ролі, покарання й журнал живуть лише в пам'яті вкладки.
   * Права нижче рахуються від ролі облікового запису, під яким виконано демо-вхід (а не від назви вкладки),
   * але це перевірки в браузері: у справжньому форумі їх має виконувати сервер.
   */
  const USERS = Object.values(structuredClone(D.PEOPLE));
  const userBy = id => USERS.find(u => u.id === id);
  const me = () => userBy(state.userId);
  const ROLES = [['player', 'Гравець', 'Гравець'], ['helper', 'Хелпер', 'Хелпер'], ['mod', 'Модератор', 'Модер.'], ['dev', 'Розробник', 'Розроб.']];
  const RANK = { player: 0, helper: 1, mod: 2, dev: 3 };
  const ROLE_NAME = Object.fromEntries(ROLES.map(([k, full]) => [k, full]));
  // Демо: стартовий вхід можна задати в адресі (?role=mod або ?as=juno)
  {
    const q = new URLSearchParams(location.search);
    const r = q.get('role') === 'admin' ? 'dev' : q.get('role');
    if (D.DEMO_LOGIN[r]) state.userId = D.DEMO_LOGIN[r];
    if (userBy(q.get('as'))) state.userId = q.get('as');
  }
  const VIS = { public: 'Публічний', team: 'Команда', dev: 'Розробники' };

  // Демо-годинник: «перемотка» часу, щоб перевірити закінчення мутів і банів без очікування
  const now = () => Date.now() + state.clockOffset;
  const nowDate = () => new Date(now());

  /* ---------- Покарання на форумі ---------- */
  const MUTE_DUR = [10, 60, 720, 1440];
  const BAN_DUR = [60, 1440, 4320, 10080];
  const durLabel = m => m == null ? 'Постійно' : m < 60 ? `${m} хв` : m <= 1440 ? plural(m / 60, 'година', 'години', 'годин') : plural(m / 1440, 'день', 'дні', 'днів');
  const PTYPE = { mute: 'Мут', ban: 'Бан' };
  const punishments = D.PUNISHMENTS.map(p => {
    const at = Date.now() - p.agoMin * 60000;
    return {
      id: p.id, userId: p.userId, type: p.type, durMin: p.durMin, by: p.by, byRole: userBy(p.by).role, at, reason: p.reason,
      until: p.durMin == null ? null : at + p.durMin * 60000,
      removed: p.removed ? { by: p.removed.by, at: Date.now() - p.removed.agoMin * 60000, reason: p.removed.reason } : null
    };
  });
  let punSeq = Math.max(0, ...punishments.map(p => p.id));
  // Стан рахується з часу: закінчення терміну саме відновлює доступ
  const punStatus = p => p.removed ? 'removed' : p.until != null && now() >= p.until ? 'expired' : 'active';
  const PSTATUS = { active: 'Активно', expired: 'Минуло', removed: 'Знято достроково' };
  const activeOf = (uid, type) => punishments.find(p => p.userId === uid && p.type === type && punStatus(p) === 'active');
  const isBanned = (uid = state.userId) => !!activeOf(uid, 'ban');
  const isMuted = (uid = state.userId) => !!activeOf(uid, 'mute');

  /* ---------- Ролі та доступ: одна перевірка для списків, пошуку, шляху й прямих посилань ---------- */
  const myRole = () => me().role;
  const atLeast = role => RANK[myRole()] >= RANK[role];
  const isTeam = () => atLeast('helper');       // хелпер, модератор, розробник
  const canModerate = () => atLeast('mod');     // керування темами й розділами
  const isDev = () => myRole() === 'dev';
  const canSee = r => !!r && (r.visibility === 'public' || (r.visibility === 'team' && isTeam()) || (r.visibility === 'dev' && isDev()));
  // Мут забороняє створювати теми й писати; читати можна
  const canCreateIn = r => canSee(r) && !r.external && !isMuted() && (r.topicsBy === 'players' || canModerate());
  // Модератор керує публічними й командними розділами; розділи розробників — лише розробник
  const canManage = r => canModerate() && canSee(r) && !r.external && (r.visibility !== 'dev' || isDev());
  const seeTopic = t => canSee(rowBy(t.section)) && (!t.hiddenTopic || canModerate());

  // Хто кого може карати: хелпер — лише мут гравцям; модератор — мут і тимчасовий бан гравцям і хелперам;
  // розробник — усе, включно з постійним баном, для будь-якої ролі. Себе не карає ніхто.
  function punishOptions(target) {
    const r = myRole();
    if (!target || target.id === state.userId || !isTeam()) return null;
    if (r === 'helper') return target.role === 'player' ? { mute: MUTE_DUR } : null;
    if (r === 'mod') return RANK[target.role] <= RANK.helper ? { mute: MUTE_DUR, ban: BAN_DUR } : null;
    return { mute: MUTE_DUR, ban: BAN_DUR, perm: true };
  }
  // Зняти можна: хелпер — лише свій мут; модератор — видані хелперами та свої; розробник — будь-які
  function canLift(p) {
    if (punStatus(p) !== 'active') return false;
    const r = myRole();
    if (r === 'dev') return true;
    if (r === 'mod') return p.by === state.userId || p.byRole === 'helper';
    if (r === 'helper') return p.type === 'mute' && p.by === state.userId;
    return false;
  }

  /* ---------- Журнал дій: записи лише додаються ---------- */
  const LOG = [];
  let logSeq = 0;
  function logAdd(e) {
    const actor = e.by ? userBy(e.by) : me();
    const entry = Object.freeze({ id: ++logSeq, at: e.at ?? now(), by: actor.id, byRole: e.byRole || actor.role, type: e.type, target: Object.freeze({ ...e.target }),
      section: e.section || null, reason: e.reason || '', term: e.term || '', before: e.before ?? '', after: e.after ?? '', undoOf: e.undoOf || null, note: e.note || '' });
    LOG.push(entry);
    return entry.id;
  }
  // Стартовий журнал: демозаписи й покарання в порядку часу
  [
    ...D.LOG.map(e => ({ ...e, at: new Date(e.at).getTime() })),
    ...punishments.flatMap(p => [
      { at: p.at, by: p.by, type: p.type === 'ban' ? (p.until == null ? 'punish.perm' : 'punish.ban') : 'punish.mute', target: { kind: 'user', id: p.userId }, reason: p.reason, term: durLabel(p.durMin), before: 'Без обмежень', after: `${PTYPE[p.type]} №${p.id}` },
      ...(p.removed ? [{ at: p.removed.at, by: p.removed.by, type: 'punish.lift', target: { kind: 'user', id: p.userId }, reason: p.removed.reason, before: `${PTYPE[p.type]} №${p.id} активний`, after: 'Знято достроково' }] : [])
    ])
  ].sort((a, b) => a.at - b.at).forEach(e => logAdd({ ...e, byRole: userBy(e.by).role }));
  // Зрозумілий час: «25 вересня 2026 р. о 18:52» і відносна підказка
  const fmtTs = ts => dateTimeFmt.format(new Date(ts));
  function spanText(ms) {
    const m = Math.max(1, Math.round(Math.abs(ms) / 60000));
    if (m < 60) return `${m} хв`;
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return `${h} год${mm ? ` ${mm} хв` : ''}`;
    const d = Math.floor(h / 24), hh = h % 24;
    // Давні дати — у місяцях і роках, без зайвої точності
    if (d >= 365) { const y = Math.floor(d / 365), mo = Math.floor((d % 365) / 30); return `${plural(y, 'рік', 'роки', 'років')}${mo ? ` ${plural(mo, 'місяць', 'місяці', 'місяців')}` : ''}`; }
    if (d >= 30) return plural(Math.floor(d / 30), 'місяць', 'місяці', 'місяців');
    return `${plural(d, 'день', 'дні', 'днів')}${hh && d < 7 ? ` ${hh} год` : ''}`;
  }
  const relTs = ts => Math.abs(ts - now()) < 60000 ? 'щойно' : ts > now() ? `через ${spanText(ts - now())}` : `${spanText(now() - ts)} тому`;
  const untilText = p => p.until == null ? 'безстроково' : `до ${fmtTs(p.until)} (ще ${spanText(p.until - now())})`;
  const muteLine = p => `Мут ${untilText(p)}. Причина: ${esc(p.reason)}.`;

  // Модератор бачить дії хелперів і модераторів у доступних йому розділах; розробник — усе
  const canSeeLog = e => isDev() || (canModerate() && RANK[e.byRole] <= RANK.mod && (!e.section || canSee(rowBy(e.section))));

  /* ---------- Профілі: активність і внесок учасника ---------- */
  // Дії в цій вкладці (відповідь, тема, редагування, профіль). vis — хто може бачити цю дію.
  const sessionActs = [];
  function touch(label, href = '', vis = () => true) {
    sessionActs.push({ userId: state.userId, at: now(), label, href, vis });
  }
  const toMs = x => typeof x === 'number' ? x : new Date(x).getTime();
  // Повідомлення, які бачить поточний глядач: лише з доступних тем, приховані — тільки модерації
  const seeReply = (t, r) => seeTopic(t) && (!r.hidden || canModerate());
  const topicsOf = u => topics.filter(t => t.author.id === u.id && seeTopic(t)).sort((a, b) => toMs(b.at) - toMs(a.at));
  const repliesOf = u => topics.flatMap(t => t.replies.filter(r => r.author?.id === u.id && seeReply(t, r)).map(r => ({ t, r })))
    .sort((a, b) => toMs(b.r.at) - toMs(a.r.at));
  // Остання активність — найсвіжіша дія, яку глядачу дозволено бачити. Немає таких дій — чесно «немає даних».
  function activityOf(u) {
    const items = [
      ...topicsOf(u).map(t => ({ at: toMs(t.at), label: `Нова тема «${excerpt(t.title, 60)}»`, href: `#/topic/${t.id}` })),
      ...repliesOf(u).map(({ t, r }) => ({ at: toMs(r.at), label: `Відповідь у темі «${excerpt(t.title, 60)}»`, href: `#/topic/${t.id}?m=${r.id}` })),
      ...LOG.filter(e => e.by === u.id && canSeeLog(e)).map(e => ({ at: e.at, label: 'Дія в журналі команди', href: '#/team/log' })),
      ...sessionActs.filter(a => a.userId === u.id && a.vis()).map(a => ({ at: a.at, label: a.label, href: a.href }))
    ];
    return items.sort((a, b) => b.at - a.at)[0] || null;
  }

  const rowBy = slug => ROWS.find(r => r.slug === slug);
  const topicBy = id => topics.find(t => t.id === id);
  const postsOf = t => t.replies.filter(x => x.type === 'post');
  const lastAt = t => [t.at, ...t.replies.map(x => x.at)].sort().at(-1);
  const lastAuthor = t => { const p = postsOf(t); return (p.length ? p.at(-1).author : t.author).name; };
  const shownTopics = () => topics.filter(seeTopic);
  const sectionTopics = slug => shownTopics().filter(t => t.section === slug)
    .sort((a, b) => (!!b.pinned - !!a.pinned) || lastAt(b).localeCompare(lastAt(a)));
  const isInfo = t => t.access === 'info';
  // Статус розгляду — лише для звернень в режимі обговорення, не для інформаційних тем
  const statusOf = t => isAppeal(t) && !isInfo(t) ? D.STATUSES.find(s => s.key === t.status) || D.STATUSES[0] : null;

  // Перемикач ролі живе в командному рядку під шапкою, тож на всіх екранах стоїть в одній позиції.
  // roleBar(left) лишився для сумісності й повертає лише ліві інструменти сторінки.
  function roleBar(left = '') {
    return left ? `<div class="pagetools">${left}</div>` : '';
  }
  // Вкладка = демо-вхід під типовим обліковим записом цієї ролі. Натиснута вкладка — роль того, хто зараз увійшов.
  function renderRoleSwitch() {
    const u = me();
    $('#roleswitch').innerHTML = `<span class="demo-login-lbl" id="demo-login-lbl">Демо-вхід<small>без пароля</small></span>
      <div class="viewswitch" role="group" aria-labelledby="demo-login-lbl">
      ${ROLES.map(([k, full, short]) => `<button type="button" data-role="${k}" aria-label="Увійти як ${full}" aria-pressed="${u.role === k}"><span class="full" aria-hidden="true">${full}</span><span class="short" aria-hidden="true">${short}</span></button>`).join('')}
    </div>`;
    $('#nav-team').hidden = !isTeam();
    $('#login .lbl').textContent = u.name;
    $('#login').setAttribute('aria-label', `Обліковий запис: ${u.name}, ${ROLE_NAME[u.role]}. Змінити демо-вхід`);
  }
  // Увійти як: вкладка ролі відкриває типовий запис, якщо він досі має цю роль, інакше перший запис із цією роллю
  function loginAs(role) {
    const pref = userBy(D.DEMO_LOGIN[role]);
    const u = pref && pref.role === role ? pref : USERS.find(x => x.role === role);
    if (!u) { toast(`Немає облікового запису з роллю «${ROLE_NAME[role]}».`); return false; }
    state.userId = u.id;
    return true;
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
  }

  /* ---------- Шлях (командний рядок) ---------- */
  function setCrumbs(items) {
    $('#crumbs').innerHTML = items.map((it, i) => {
      const last = i === items.length - 1;
      const cls = [it.shrink ? 'shrink' : '', it.topic ? 'topic' : ''].join(' ').trim();
      const inner = last
        ? `<span aria-current="page" title="${esc(it.label)}">${esc(it.label)}</span>`
        : `<a href="${esc(it.href)}">${esc(it.label)}</a>`;
      return `<li${cls ? ` class="${cls}"` : ''}>${inner}</li>`;
    }).join('');
  }
  const baseCrumbs = [{ label: 'Головна', href: '#/' }, { label: 'Форум', href: '#/' }];

  /* ---------- Спільні елементи «Міського терміналу» ---------- */
  const visBadge = r => r.visibility !== 'public' ? `<span class="visbadge vis-${r.visibility}">🔒 ${VIS[r.visibility]}</span>` : '';
  const genreOf = r => r.external ? 'external' : r.genre || (r.topicsBy === 'team' ? 'official' : 'discussion');
  const GENRE = { official: 'Офіційні матеріали', discussion: 'Обговорення', appeals: 'Звернення', external: 'Зовнішня спільнота' };
  const lastPoster = t => { const p = postsOf(t).filter(x => !x.hidden); return p.length ? p.at(-1).author : t.author; };
  // Роль автора — поточна роль облікового запису (розробник міг її змінити)
  const personOf = a => (a && userBy(a.id)) || a;
  const roleKey = a => personOf(a).role || 'player';
  const teamRoleOf = a => { const r = roleKey(a); return r === 'player' ? '' : r; };
  const ROLE_LABEL = { dev: 'Розробник', mod: 'Модератор', helper: 'Хелпер' };
  // Аватар береться з поточного профілю: фото (лише в цій вкладці), колір або ініціали
  const avatar = (a, cls = '') => {
    const p = personOf(a);
    const tone = p.tone != null ? ` tone-${p.tone}` : '';
    return `<span class="avatar av-${roleKey(a)}${tone}${p.photo ? ' has-photo' : ''} ${cls}" aria-hidden="true">${p.photo ? `<img src="${p.photo}" alt="">` : esc(p.initials)}</span>`;
  };
  const roleBadge = a => teamRoleOf(a) ? `<span class="rolebadge rb-${roleKey(a)}">${ROLE_LABEL[roleKey(a)]}</span>` : '';
  // Ім'я веде в профіль (там і панель покарань для команди)
  const userLink = (a, cls = '') => a?.id ? `<a class="userlink nm-${roleKey(a)} ${cls}" href="#/user/${a.id}">${esc(a.name)}</a>` : `<span class="nm-${roleKey(a)} ${cls}">${esc(a.name)}</span>`;
  const pad2 = n => String(n).padStart(2, '0');

  // Відносний час для стрічок: «2 години тому», далі — дата
  function ago(iso) {
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 1) return 'щойно';
    if (mins < 60) return `${mins} хв тому`;
    const h = Math.round(mins / 60);
    if (h < 24) return `${plural(h, 'година', 'години', 'годин')} тому`;
    const d = Math.round(h / 24);
    if (d < 7) return `${plural(d, 'день', 'дні', 'днів')} тому`;
    return fmtDate(iso);
  }

  // Прості лінійні піктограми розділів
  const ICONS = {
    doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',
    scales: '<path d="M12 3v18M6 21h12M4 7h16"/><path d="M7 7l-3 7h6zM17 7l-3 7h6z"/>',
    gear: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-4 3-6 6.5-6s6.5 2 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c3.2 0 5.5 1.8 5.5 5"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h8"/>',
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4z"/><path d="M20 4h-6a3 3 0 0 0-1 .2M20 4v13.5h-6.5"/>',
    buoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M5.6 5.6l3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/>'
  };
  const SLUG_ICON = { news: 'doc', tech: 'gear', chat: 'chat', staff: 'shield', devroom: 'key', rules: 'scales', rp: 'book', org: 'people', helpers: 'buoy' };
  const GENRE_ICON = { official: 'doc', discussion: 'chat', appeals: 'headset', external: 'chat' };
  const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.doc}</svg>`;

  // Схема міста — справжній SVG-елемент, а не картинка
  function cityMap(cls = '') {
    return `<svg class="citymap ${cls}" viewBox="0 0 420 280" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Схема вигаданого міста Велтмур: Старий док і центр">
      <g class="cm-minor">
        <path d="M0 22H420M0 64H420M0 98H420M0 150H420M0 176H420M0 238H420M24 0V280M112 0V280M204 0V280M296 0V280M388 0V280"/>
      </g>
      <g class="cm-roads">
        <path d="M0 40L140 60L260 30L420 70"/><path d="M0 120L90 110L200 140L300 120L420 150"/><path d="M0 210L120 190L230 220L420 200"/>
        <path d="M40 0L70 120L60 280"/><path d="M150 0L170 90L150 180L180 280"/><path d="M262 0L240 100L270 190L250 280"/><path d="M350 0L372 110L340 200L360 280"/>
        <path d="M90 110L150 180L230 220"/><path d="M200 140L240 100L300 120"/><path d="M0 262L180 244L420 254"/>
      </g>
      <path class="cm-route" d="M18 256C120 206 176 166 240 100S360 58 412 38"/>
      <circle class="cm-district" cx="252" cy="94" r="50"/>
      <text class="cm-lbl" x="214" y="74">OLD DOCKS</text>
      <text class="cm-lbl" x="276" y="196">VELTMOOR</text>
      <g class="cm-pin" transform="translate(96 48)"><path d="M0-15C-8-15-10-7-6-1L0 7L6-1C10-7 8-15 0-15Z"/><circle cy="-8" r="3"/></g>
      <g class="cm-pin" transform="translate(318 84)"><path d="M0-15C-8-15-10-7-6-1L0 7L6-1C10-7 8-15 0-15Z"/><circle cy="-8" r="3"/></g>
      <g class="cm-pin" transform="translate(362 214)"><path d="M0-15C-8-15-10-7-6-1L0 7L6-1C10-7 8-15 0-15Z"/><circle cy="-8" r="3"/></g>
      <circle class="cm-dot" cx="252" cy="94" r="3"/>
    </svg>`;
  }

  // Смуга нічного міста для внутрішніх сторінок
  const banner = () => `<div class="banner" role="img" aria-label="Нічний Велтмур — власна ілюстрація">
      <span class="bn-tag">Every light<br>tells<br>a story</span>
      <span class="bn-call">Veltmoor<br>City operations<br><b>Концепт · демо</b></span>
    </div>`;

  // Рядок теми: однакова структура для розділу й пошуку; жанр змінює праву колонку
  function topicRow(t, withSection = false) {
    const g = genreOf(rowBy(t.section));
    const n = postsOf(t).length;
    const st = statusOf(t);
    const who = lastPoster(t);
    const where = withSection ? rowBy(t.section).name + (t.sub ? ' › ' + t.sub : '') : t.sub;
    const marks = [t.draft && 'чернетка', withSection && t.pinned && 'закріплено', t.hiddenTopic && 'сховано', t.locked && 'закрито'].filter(Boolean);
    return `<li class="topicrow tl-row tl-${g}">
      ${avatar(t.author)}
      <div class="topictext">
        <a href="#/topic/${t.id}">${esc(t.title)}${t.locked ? '<span class="tl-lock" aria-hidden="true"> 🔒</span>' : ''}</a>
        <small>${userLink(t.author)} · ${ago(lastAt(t))}${where ? ' · ' + esc(where) : ''}${marks.length ? ` · <span class="tl-marks">${marks.join(' · ')}</span>` : ''}</small>
      </div>
      ${st ? `<span class="tl-status st-${t.status}">${esc(st.label)}</span>` : '<span class="tl-status-empty"></span>'}
      ${g === 'official' && !withSection
        ? `<span class="tl-num"><b>${fmtDate(lastAt(t)).replace(/ \d{4} р\.$/, '')}</b>оновлено</span>`
        : `<span class="tl-num"><b>${n}</b>${word(n, 'відповідь', 'відповіді', 'відповідей')}</span>`}
      <span class="tl-num"><b>${(t.views || 0).toLocaleString('uk-UA')}</b>${word(t.views || 0, 'перегляд', 'перегляди', 'переглядів')}</span>
      <span class="sr">Останнім писав ${esc(who.name)}</span>
    </li>`;
  }

  /* ---------- Головна: місто, покажчик розділів, останні обговорення ---------- */
  let ixCounter = 0;
  function rowHtml(r) {
    const list = sectionTopics(r.slug);
    const posts = list.reduce((s, t) => s + 1 + postsOf(t).length, 0);
    const g = genreOf(r);
    const sub = r.external ? 'Новини, спілкування та канали звернень. Перехід вимкнено в демо.' : r.desc || r.children.join(' · ');
    const open = list.filter(t => statusOf(t) && (t.status === 'open' || t.status === 'info')).length;
    const stats = r.external
      ? `<span class="ix-stat"><b>—</b>зовнішній чат</span><span class="ix-stat"></span>`
      : g === 'appeals'
        ? `<span class="ix-stat accent"><b>${open}</b>на розгляді</span><span class="ix-stat"><b>${list.length}</b>${word(list.length, 'тема', 'теми', 'тем')}</span>`
        : `<span class="ix-stat"><b>${list.length}</b>${word(list.length, 'тема', 'теми', 'тем')}</span><span class="ix-stat"><b>${posts}</b>${word(posts, 'повідомлення', 'повідомлення', 'повідомлень')}</span>`;
    return `<li class="ix-row ix-${g}">
      <span class="ix-num" aria-hidden="true">${pad2(++ixCounter)}</span>
      <span class="ix-ico">${icon(SLUG_ICON[r.slug] || GENRE_ICON[g])}</span>
      <div class="ix-main">
        <h3 class="ix-title"><a class="rowtitle" href="#/section/${r.slug}">${esc(r.name)}</a>${r.visibility !== 'public' ? ` <span class="ix-lock">🔒 ${VIS[r.visibility]}</span>` : ''}</h3>
        <p class="ix-desc"><span class="ix-kicker">${GENRE[g]}</span>${sub ? ' · ' + esc(sub) : ''}</p>
      </div>
      ${stats}
      <span class="ix-go" aria-hidden="true">›</span>
    </li>`;
  }

  function renderGroups(q = '') {
    const box = $('#groups');
    if (!box) return;
    const needle = q.trim().toLowerCase();
    let matches = 0;
    ixCounter = 0;
    const html = D.STRUCTURE.map(g => {
      const rows = ROWS.filter(r => r.group === g && canSee(r) && (!needle || [g.title, r.name, r.desc || '', ...r.children].join(' ').toLowerCase().includes(needle)));
      matches += rows.length;
      if (!rows.length) return '';
      return `<section class="ix-group" aria-labelledby="grp-${g.key}">
        <h3 class="ix-grouphead" id="grp-${g.key}">${esc(g.title)}<span>${plural(rows.length, 'розділ', 'розділи', 'розділів')}</span></h3>
        <ol class="ix-list">${rows.map(rowHtml).join('')}</ol>
      </section>`;
    }).join('');
    box.innerHTML = matches ? html
      : `<div class="empty">Серед розділів нічого не знайдено. <a href="#/search/${encodeURIComponent(q.trim())}">Шукати «${esc(q.trim())}» у темах →</a></div>`;
  }

  function recentRow(t) {
    const who = lastPoster(t);
    const n = postsOf(t).length;
    return `<li class="rc-row">
      ${avatar(who)}
      <div class="rc-main"><a href="#/topic/${t.id}">${esc(t.title)}</a>
        <small>${userLink(who)} · ${ago(lastAt(t))} · <span class="rc-sec g-${genreOf(rowBy(t.section))}">${esc(rowBy(t.section).name)}</span></small></div>
      <span class="tl-num"><b>${n}</b>${word(n, 'відповідь', 'відповіді', 'відповідей')}</span>
      <span class="tl-num"><b>${(t.views || 0).toLocaleString('uk-UA')}</b>${word(t.views || 0, 'перегляд', 'перегляди', 'переглядів')}</span>
    </li>`;
  }

  function renderHome() {
    const recent = shownTopics().sort((a, b) => lastAt(b).localeCompare(lastAt(a))).slice(0, 5);
    const all = shownTopics();
    const posts = all.reduce((s, t) => s + 1 + postsOf(t).length, 0);
    const now = nowDate();
    const canCreate = ROWS.some(canCreateIn);
    $('#view-home').innerHTML = `
      <div class="home">
        <section class="hm-photo" aria-label="Нічний Велтмур — власна ілюстрація">
          <span class="bn-tag">Every light<br>tells<br>a story</span>
          <span class="bn-call">Veltmoor<br>City operations<br><b>Концепт · демо</b></span>
          <div class="hm-foot">
            <div class="hm-clock"><b>${hhmm(now)}</b><small>${now.toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' })}</small></div>
            <div class="hm-server"><i class="dot" aria-hidden="true"></i><span><b>Демо-статус: онлайн</b><small>${esc(D.SERVER.name)} · вигаданий сервер</small></span></div>
          </div>
          <span class="hm-sa" aria-hidden="true">Veltmoor</span>
        </section>

        <div class="hm-main">
          <header class="hm-top">
            ${cityMap('hm-map')}
            <div class="hm-meta">
              <span class="hm-live"><i class="dot" aria-hidden="true"></i><b>${all.length} ${word(all.length, 'тема', 'теми', 'тем')}</b><small>${posts} ${word(posts, 'повідомлення', 'повідомлення', 'повідомлень')} · демодані</small></span>
              <span class="hm-motto"><b>Veltmoor</b><small>Вигадане місто</small></span>
            </div>
            <h1 id="hero-title" tabindex="-1">Veltmoor —<br>місто історій</h1>
            <p class="hm-sub">Демо-форум вигаданого портового міста</p>
            <p class="hm-lede">Приклад того, як може виглядати форум рольового міста: новини, правила, історії персонажів і звернення в одному місці. Усі учасники й події вигадані.</p>
            <div class="hm-actions">
              <button class="btn btn-primary" type="button" data-open-navigator>Подати звернення</button>
              <a class="btn" href="#/section/rules">Правила міста</a>
              <a class="btn hm-members" href="#/members">◉ Учасники</a>${isTeam() ? '<a class="btn" href="#/team">⚑ Панель команди</a>' : ''}
            </div>
          </header>

          <div id="groups" class="ix" aria-label="Розділи форуму"></div>

          <section class="recent" aria-labelledby="recent-title">
            <header class="rc-head"><h2 id="recent-title">Останні обговорення</h2>${canCreate ? '<button class="btn btn-primary" type="button" data-compose>✎ Створити тему →</button>' : ''}</header>
            <ol class="rc-list">${recent.map(recentRow).join('')}</ol>
          </section>
        </div>
      </div>`;
    renderGroups($('#search').value);
  }

  /* ---------- Розділ ---------- */
  let subFilter = null;
  function renderSection(r) {
    const g = genreOf(r);
    const list = r.external ? [] : sectionTopics(r.slug);
    const posts = list.reduce((s, t) => s + 1 + postsOf(t).length, 0);
    const shown = list.filter(t => !subFilter || (t.sub || '').startsWith(subFilter));
    const pinned = shown.filter(t => t.pinned), rest = shown.filter(t => !t.pinned);
    let body = '';
    if (r.external) {
      body = `<div class="empty">У повній версії тут був би перехід до зовнішнього чату спільноти. У демонстрації зовнішні посилання вимкнено.</div>`;
    } else {
      if (pinned.length) body += `<p class="tl-sub">Закріплено</p><ol class="tl-list">${pinned.map(t => topicRow(t)).join('')}</ol>`;
      if (rest.length) body += `${pinned.length ? '<p class="tl-sub">Усі теми</p>' : ''}<ol class="tl-list">${rest.map(t => topicRow(t)).join('')}</ol>`;
      if (!shown.length) body += `<div class="empty">Тут поки немає тем.${canCreateIn(r) ? ` <button class="smalllink" type="button" data-compose="${r.slug}">Створити першу →</button>` : ''}</div>`;
    }
    $('#view-section').innerHTML = `
      ${banner()}
      <div class="pg">
        <div class="pg-main">
          <header class="pg-head g-${g}">
            <span class="kicker">${GENRE[g]}</span>
            <h1 id="section-title" tabindex="-1">${esc(r.name)}</h1>
            ${r.desc ? `<p class="pg-desc">${esc(r.desc)}</p>` : ''}
            ${r.visibility !== 'public' || r.topicsBy === 'team' ? `<p class="secflags">${visBadge(r)}${r.topicsBy === 'team' ? '<span class="visbadge">Теми створює команда</span>' : ''}</p>` : ''}
            ${r.children.length ? `<div class="subforums" role="group" aria-label="Фільтр за підрозділом">${['Усі', ...r.children].map((c, i) => {
              const val = i ? c : '';
              return `<button type="button" class="chip" data-sub="${esc(val)}" aria-pressed="${(subFilter || '') === val}">${esc(c)}</button>`;
            }).join('')}</div>` : ''}
            <div class="pg-actions" id="section-actions">${canManage(r) ? `<a class="btn" href="#/manage/${r.slug}">⚙ Налаштування</a>` : ''}${canCreateIn(r) ? `<button class="btn btn-primary" type="button" data-compose="${r.slug}">✎ Створити тему</button>` : ''}</div>
          </header>
          <section class="tl" aria-labelledby="tl-title">
            <h2 class="tl-title" id="tl-title">Теми розділу</h2>
            ${body}
          </section>
        </div>
        <aside class="pg-aside" aria-label="Про розділ">
          ${cityMap('mini')}
          <dl class="facts">
            <div><dt>Тем</dt><dd>${list.length}</dd></div>
            <div><dt>Повідомлень</dt><dd>${posts}</dd></div>
            <div><dt>Теми створюють</dt><dd>${r.topicsBy === 'team' ? 'Лише команда' : 'Гравці й команда'}</dd></div>
            <div><dt>Доступ</dt><dd>${VIS[r.visibility]}</dd></div>
          </dl>
          <div class="aside-note"><h3>Правильний розділ?</h3><p>Скарги на гравців і модераторів — у чаті спільноти, ігрові звернення — до прокуратури, технічні питання — у технічний розділ.</p><button class="smalllink" type="button" data-open-navigator>Перевірити маршрут →</button></div>
        </aside>
      </div>`;
  }

  /* ---------- Пошук ---------- */
  function topicText(t) {
    const flat = b => Array.isArray(b) ? b.map(flat).join(' ') : String(b);
    // Приховані відповіді не беруть участі в пошуку для тих, хто їх не бачить
    return [t.title, t.sub || '', t.author.name, t.text || '', flat(t.body || []), ...t.replies.filter(x => !x.hidden || canModerate()).map(x => x.text || '')].join(' ').toLowerCase();
  }
  function renderSearch(q) {
    const needle = q.trim().toLowerCase();
    const found = needle ? shownTopics().filter(t => topicText(t).includes(needle)) : [];
    const secs = needle ? ROWS.filter(r => canSee(r) && [r.name, r.desc || '', ...r.children].join(' ').toLowerCase().includes(needle)) : [];
    // Учасники шукаються лише за ніком
    const people = needle ? USERS.filter(u => u.name.toLowerCase().includes(needle)) : [];
    $('#view-search').innerHTML = `
      <div class="pg pg-single">
        <div class="pg-main">
          <header class="pg-head">
            <span class="kicker">Пошук</span>
            <h1 id="search-title" tabindex="-1">${needle ? `Результати за «${esc(q.trim())}»` : 'Пошук'}</h1>
            <p class="pg-desc">${needle ? `${plural(found.length, 'тема', 'теми', 'тем')}${secs.length ? ', ' + plural(secs.length, 'розділ', 'розділи', 'розділів') : ''}${people.length ? ', ' + plural(people.length, 'учасник', 'учасники', 'учасників') : ''} · пошук по демоданих` : 'Введіть запит у полі пошуку.'}</p>
          </header>
          ${people.length ? `<section class="tl"><h2 class="tl-title">Учасники</h2><ol class="tl-list">${people.map(u => `<li class="topicrow tl-row tl-people">${avatar(u)}<div class="topictext"><a href="#/user/${u.id}">${esc(u.name)}</a><small>${ROLE_NAME[u.role]} · на форумі з ${fmtDate(u.joined)}</small></div></li>`).join('')}</ol></section>` : ''}
          ${secs.length ? `<section class="tl"><h2 class="tl-title">Розділи</h2><ol class="tl-list">${secs.map(r => `<li class="topicrow tl-row tl-${genreOf(r)}"><span class="avatar av-section" aria-hidden="true">${icon(SLUG_ICON[r.slug] || GENRE_ICON[genreOf(r)])}</span><div class="topictext"><a href="#/section/${r.slug}">${esc(r.name)}</a><small>${esc(r.group.title)} · ${GENRE[genreOf(r)]}</small></div></li>`).join('')}</ol></section>` : ''}
          <section class="tl"><h2 class="tl-title">Теми</h2>
            ${found.length ? `<ol class="tl-list">${found.map(t => topicRow(t, true)).join('')}</ol>` : `<div class="empty">Тем не знайдено. Спробуйте інше слово, наприклад «скарга» або «виліт».</div>`}
          </section>
        </div>
      </div>`;
  }

  /* ---------- Тема ---------- */
  function attachHtml(a) {
    const thumb = a.src ? `<img class="thumb" src="${a.src}" alt="${esc(a.name)}">`
      : `<div class="thumb ${a.kind === 'video' ? 'video' : a.tone}" aria-hidden="true"></div>`;
    return `<figure class="attach">${thumb}<span title="${esc(a.name)}">${esc(a.name)}</span><small>${esc(a.meta)}</small></figure>`;
  }

  // Структуровані повідомлення з демоданих
  function blockHtml([k, v], num) {
    if (k === 'p') return `<p>${esc(v)}</p>`;
    if (k === 'h') return `<h3 class="msgtitle">${esc(v)}</h3>`;
    if (k === 'lead') return `<p class="lead">${esc(v)}</p>`;
    if (k === 'note') return `<p class="notebox"><span>${esc(v[0])}</span> ${esc(v[1])}</p>`;
    if (k === 'steps') return `<ol class="faqsteps">${v.map(([title, desc], i) => `<li><span class="n" aria-hidden="true">${pad2(i + 1)}</span><div><b>${esc(title)}</b><p>${esc(desc)}</p></div></li>`).join('')}</ol>`;
    // У розділі правил пункти нумеруються «1.1, 1.2…»
    if (k === 'ol' && num) return `<ol class="ritems">${v.map(li => `<li><span class="rn">${num.sec}.${++num.item}</span><span>${esc(li)}</span></li>`).join('')}</ol>`;
    if (k === 'ul' || k === 'ol') return `<${k}>${v.map(li => `<li>${esc(li)}</li>`).join('')}</${k}>`;
    return `<dl>${v.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${esc(dd)}</dd>`).join('')}</dl>`;
  }
  const cleanHeading = s => s.replace(/^\s*\d+[.)]\s*/, '');
  // Розділи довгого документа: заголовок + блоки до наступного заголовка
  function sectionsOf(t, blocks) {
    const out = { intro: [], secs: [] };
    blocks.forEach((b, i) => {
      if (b[0] === 'h' && !(i === 0 && cleanHeading(b[1]).toLowerCase() === t.title.toLowerCase())) out.secs.push({ title: cleanHeading(b[1]), blocks: [] });
      else if (b[0] === 'h') return; // заголовок, що дублює назву теми
      else (out.secs.length ? out.secs.at(-1).blocks : out.intro).push(b);
    });
    return out;
  }
  function bodyHtml(blocks, t = null) {
    if (!t) return blocks.map(b => blockHtml(b)).join('');
    const { intro, secs } = sectionsOf(t, blocks);
    return intro.map(b => blockHtml(b)).join('') + secs.map((s, i) => {
      const num = { sec: i + 1, item: 0 };
      return `<section class="rsec" id="sec-${t.id}-${i + 1}" tabindex="-1" aria-labelledby="sech-${t.id}-${i + 1}">
        <span class="rsec-num" aria-hidden="true">${pad2(i + 1)}</span>
        <div class="rsec-body"><h3 class="rsec-title" id="sech-${t.id}-${i + 1}">${esc(s.title)}</h3>${s.blocks.map(b => blockHtml(b, num)).join('')}</div>
      </section>`;
    }).join('');
  }
  // Зміст «У цій темі» — лише для документів із розділами
  function tocOf(t) {
    if (t.text || !t.body) return [];
    return sectionsOf(t, t.body).secs.map((s, i) => ({ id: `sec-${t.id}-${i + 1}`, title: s.title }));
  }
  // Ті самі блоки як текст із розміткою — щоб модератор міг відредагувати повідомлення
  function toMarkup(blocks) {
    return blocks.map(([k, v]) => {
      if (k === 'h') return `**${v}**`;
      if (k === 'note') return `> ${v[0]} ${v[1]}`;
      if (k === 'steps') return v.map(([title, desc], i) => `${i + 1}. **${title}** — ${desc}`).join('\n');
      if (k === 'ul') return v.map(li => `- ${li}`).join('\n');
      if (k === 'ol') return v.map((li, i) => `${i + 1}. ${li}`).join('\n');
      if (k === 'dl') return v.map(([dt, dd]) => `**${dt}:** ${dd}`).join('\n');
      return v;
    }).join('\n\n');
  }

  /*
   * Безпечна міні-розмітка повідомлень: спершу екранування, потім лише дозволені теги.
   * **жирний**, *курсив*, __підкреслений__, [текст](https://…), рядки «- » і «1. » — списки, «> » — цитата.
   */
  function inlineFmt(s) {
    return esc(s)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener nofollow ugc">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<u>$1</u>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  }
  function formatText(src) {
    const out = [];
    let para = [], list = null, quote = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inlineFmt).join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map(li => `<li>${inlineFmt(li)}</li>`).join('')}</${list.tag}>`); list = null; };
    const flushQuote = () => { if (quote.length) out.push(`<blockquote class="mdquote">${quote.map(inlineFmt).join('<br>')}</blockquote>`); quote = []; };
    const flush = () => { flushPara(); flushList(); flushQuote(); };
    for (const line of src.replace(/\r/g, '').split('\n')) {
      let m;
      if (!line.trim()) { flush(); continue; }
      if ((m = line.match(/^\s*[-•]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
        flushPara(); flushQuote();
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(m[1]);
      } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
        flushPara(); flushList(); quote.push(m[1]);
      } else {
        flushList(); flushQuote(); para.push(line);
      }
    }
    flush();
    return out.join('');
  }

  /* ---------- Тема: стрічка діалогу ---------- */
  const shortDate = iso => {
    const d = new Date(iso);
    const opts = { day: 'numeric', month: 'long' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return `${d.toLocaleDateString('uk-UA', opts)}, ${hhmm(d)}`;
  };
  const excerpt = (s, n = 90) => { const x = s.replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1).trimEnd() + '…' : x; };
  const stripMarks = s => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/(\*\*|__|\*)/g, '').replace(/^\s*(?:[-•>]|\d+[.)])\s*/gm, '');
  const plainOf = m => m.text ? stripMarks(m.text)
    : m.body.map(([k, v]) => k === 'steps' ? v.map(s => s.join(' — ')).join('; ') : k === 'dl' ? v.map(p => p.join(': ')).join('; ') : Array.isArray(v) ? v.join(' ') : v).join(' ');
  const sourceOf = m => m.text ?? toMarkup(m.body || []);
  // Перше повідомлення теми + відповіді в порядку часу
  const messagesOf = t => [{ id: `${t.id}-1`, first: true, author: t.author, at: t.at, text: t.text, body: t.body, attachments: t.attachments, edited: t.edited }, ...t.replies];
  const numOf = (t, id) => messagesOf(t).findIndex(m => m.id === id) + 1;

  // Хто що може: закрита тема не приймає публікацій ні від кого, незалежно від типу.
  // В інформаційній темі публікують лише модератор і розробник; хелпери й гравці читають. Мут забороняє писати.
  const canPublishInfo = () => canModerate();
  const canPost = t => !t.locked && !isMuted() && (isInfo(t) ? canPublishInfo() : true);
  // Для того, хто не публікує, інформаційна тема — матеріал для читання: без відповіді, цитат і редактора
  const readOnlyInfo = t => isInfo(t) && !canPublishInfo();
  const isMine = m => m.author?.id === state.userId;
  // Модератор і розробник редагують будь-які повідомлення (зокрема правила й новини);
  // решта — лише власні, у відкритому обговоренні й без активного муту
  const canEdit = (t, m) => canModerate() || (isMine(m) && !t.locked && !isInfo(t) && !isMuted());

  function toolbarHtml(target, withAttach) {
    const b = (fmt, label, html) => `<button class="fmt" type="button" data-fmt="${fmt}" data-target="${target}" aria-label="${label}" title="${label}">${html}</button>`;
    return `<div class="fmtbar" role="toolbar" aria-label="Форматування тексту" aria-controls="${target}">
      ${b('bold', 'Жирний (Ctrl+B)', '<b>B</b>')}${b('italic', 'Курсив (Ctrl+I)', '<i>I</i>')}${b('underline', 'Підкреслений (Ctrl+U)', '<u>U</u>')}
      ${b('list', 'Список', '≡')}${b('quote', 'Цитата', '❝')}${b('link', 'Посилання', '🔗')}
      ${withAttach ? `<button class="fmt fmt-file" type="button" data-attach aria-label="Додати фото або файл">◈ Додати файл</button>` : ''}
    </div>`;
  }

  // Вкладення — окремим рядком «Додано», у тому ж стилі, що й дані повідомлення
  function attachRow(list) {
    return `<div class="factrow"><span class="fk">Додано</span><span class="fv attlist">${list.map(a =>
      `<span class="att">${a.src ? `<img src="${a.src}" alt="">` : '<span aria-hidden="true">↳</span>'} <b>${esc(a.name)}</b><span class="attmeta"> · ${esc(a.meta)}</span></span>`).join('')}</span></div>`;
  }

  function messageHtml(t, m, n, isMod) {
    if (m.hidden && !isMod) {
      return `<article class="msg reply msg-hidden" id="msg-${m.id}"><p>Відповідь #${pad2(n)} приховано модератором.</p></article>`;
    }
    const role = !m.first && m.author.name === t.author.name ? 'Автор теми' : m.author.group;
    const quoteBtn = canPost(t);
    const editBtn = canEdit(t, m);
    const hideBtn = isMod && !m.first;
    const editing = state.editing === m.id && editBtn;
    // Команда може покарати автора, якщо роль це дозволяє (панель покарань — у профілі)
    const punishBtn = !m.author?.id || isMine(m) ? false : !!punishOptions(personOf(m.author));
    const official = !quoteBtn && !editBtn && !hideBtn && !punishBtn && m.first && isInfo(t);
    const tr = teamRoleOf(m.author);
    return `<article class="msg${m.first ? ' lead' + (isInfo(t) ? ' article' : '') : ' reply'}${tr ? ' team-' + tr : ''}${m.hidden ? ' is-hidden' : ''}" id="msg-${m.id}" aria-labelledby="who-${m.id}">
      <header class="msghead">
        ${avatar(m.author)}
        <div class="who"><span class="whoname"><b id="who-${m.id}">${userLink(m.author)}</b>${roleBadge(m.author)}</span><small>${tr ? '' : `<span class="role is-player">${esc(role)}</span> · `}<time datetime="${m.at}">${shortDate(m.at)}</time>${m.edited ? ` · змінено ${shortDate(m.edited)}` : ''}${m.local ? ' · лише в цій вкладці' : ''}</small></div>
        <span class="num">#${pad2(n)}</span>
      </header>
      ${m.hidden ? '<p class="hiddenflag">Приховано від гравців</p>' : ''}
      ${m.quote ? `<blockquote class="quote"><b>${esc(m.quote.author)}:</b> «${esc(m.quote.text)}»</blockquote>` : ''}
      ${editing ? `
      <form class="editform" id="editform" data-id="${m.id}" novalidate>
        <label class="sr" for="edit-text">Редагування повідомлення #${pad2(n)}</label>
        <div class="editbox">
          ${toolbarHtml('edit-text', false)}
          <textarea id="edit-text" class="fmt-target" rows="6" aria-describedby="edit-err">${esc(state.editDraft)}</textarea>
        </div>
        <span class="err" id="edit-err"></span>
        <div class="editoractions"><button class="btn" type="button" data-edit-cancel>Скасувати</button><button class="btn btn-primary" type="submit">Зберегти зміни</button></div>
      </form>` : `
      <div class="msgbody">${m.text ? formatText(m.text) : bodyHtml(m.body || [], m.first && isInfo(t) ? t : null)}</div>
      ${m.attachments?.length ? attachRow(m.attachments) : ''}`}
      ${!editing && (quoteBtn || editBtn || hideBtn || punishBtn) ? `<footer class="msgactions">
        ${punishBtn ? `<a class="linkbtn muted" href="#/user/${m.author.id}">Покарати<span class="sr"> ${esc(m.author.name)}</span></a>` : ''}
        ${hideBtn ? `<button class="linkbtn muted" type="button" data-act="${m.hidden ? 'show' : 'hide'}" data-id="${m.id}">${m.hidden ? 'Відновити' : 'Приховати'}<span class="sr"> відповідь #${pad2(n)}</span></button>` : ''}
        ${editBtn ? `<button class="linkbtn muted" type="button" data-edit="${m.id}">Редагувати<span class="sr"> повідомлення #${pad2(n)}</span></button>` : ''}
        ${quoteBtn ? `<button class="linkbtn" type="button" data-quote="${m.id}"><span aria-hidden="true">❝ </span>Цитувати<span class="sr"> ${esc(m.author.name)}, повідомлення #${pad2(n)}</span></button>` : ''}
      </footer>` : ''}
      ${official ? '<footer class="msgactions"><span class="officialmark">Офіційна інформація</span></footer>' : ''}
    </article>`;
  }

  // Замість редактора — короткий рядок-пояснення в тій самій стрічці
  const feedNote = (title, text) => `<div class="lockednote" role="note"><div><b>${title}</b><small>${text}</small></div></div>`;

  function editorHtml(t, isMod) {
    if (readOnlyInfo(t)) return '';
    if (t.locked) return feedNote('Тему закрито', `Нові відповіді вимкнено${isMod ? '. Відкрийте тему в панелі модератора, щоб дозволити відповіді' : ''}.`);
    const mute = activeOf(state.userId, 'mute');
    if (mute) return feedNote('У вас активний мут на форумі', `${muteLine(mute)} Читати теми можна; писати відповіді й створювати теми — після закінчення терміну.`);
    if (!canPost(t)) return feedNote('Відповіді доступні лише команді', 'Ви можете читати тему та доповнення команди.');
    const q = state.replyTo;
    const files = state.replyFiles[t.id] || [];
    const official = isInfo(t) && isMod;
    // Хелпер у зверненні відповідає як представник команди
    const asTeam = !official && isTeam() && isAppeal(t);
    return `<section class="editor" id="editor" aria-labelledby="editor-title">
      <h2 id="editor-title">${official ? 'Нове доповнення' : asTeam ? `Відповідь команди · ${ROLE_NAME[myRole()]}` : 'Ваша відповідь'}</h2>
      <form id="replyform" novalidate>
        ${q ? `<div class="replyquote"><div><b>Цитата: ${esc(q.author)}</b><span>«${esc(q.text)}»</span></div><button class="x" type="button" data-clear-quote aria-label="Прибрати цитату ${esc(q.author)}">×</button></div>` : ''}
        <label class="sr" for="reply-text">Текст відповіді</label>
        <textarea id="reply-text" class="fmt-target" rows="2" placeholder="${official ? 'Текст доповнення: зміни, уточнення, нові пункти…' : 'Напишіть відповідь або натисніть «Цитувати» вище…'}" aria-describedby="reply-note reply-err">${esc(state.drafts[t.id] || '')}</textarea>
        ${files.length ? `<ul class="filechips" aria-label="Вкладення до відповіді">${files.map((f, i) => `<li><img src="${f.url}" alt=""><span>${esc(f.name)}</span><button type="button" class="x" data-rmfile="${i}" aria-label="Прибрати ${esc(f.name)}">×</button></li>`).join('')}</ul>` : ''}
        <input type="file" id="reply-files" accept="image/*" multiple hidden>
        <span class="err" id="reply-err"></span>
        <div class="ed-bar">
          ${toolbarHtml('reply-text', true)}
          <button class="btn btn-primary" type="submit">${official ? 'Опублікувати доповнення →' : 'Опублікувати →'}</button>
        </div>
        <span class="sr" id="reply-note">Демо: відповідь з’явиться лише в цій вкладці й нікуди не надсилається.</span>
      </form>
    </section>`;
  }

  // Рядок стану в панелі: що зараз і яка протилежна дія доступна
  const stateRow = (label, now, on, act, action) => `<div class="mp-state${on ? ' is-on' : ''}">
      <div><b>${label}</b><small>${now}</small></div>
      <button class="btn" type="button" data-act="${act}">${action}</button>
    </div>`;

  function panelHtml(t) {
    const stack = state.history[t.id] || [];
    const replies = t.replies;
    const sel = replies.find(r => r.id === state.selReply[t.id]) || replies.at(-1);
    const sections = ROWS.filter(canManage);
    const top = stack.at(-1);
    const undoOk = top && canUndo(top);
    return `<aside class="modpanel" aria-labelledby="mp-title">
      <header class="mp-head">
        <div class="eyebrow">Панель ${isDev() ? 'розробника' : 'модератора'} · ${esc(me().name)}</div>
        <h2 id="mp-title" tabindex="-1">Керування темою</h2>
        <p class="mp-note">Демо: зміни діють лише в цій вкладці й записуються в «Журнал дій».</p>
      </header>

      <section class="mp-sec" aria-labelledby="mp-access">
        <h3 id="mp-access">Тип теми</h3>
        <div class="statuspick typepick" role="group" aria-labelledby="mp-access">
          <button type="button" data-act="access" data-access="discussion" aria-pressed="${!isInfo(t)}">Обговорення<small>Відповідають гравці й команда</small></button>
          <button type="button" data-act="access" data-access="info" aria-pressed="${isInfo(t)}">Інформаційна тема<small>Гравці читають, пише команда</small></button>
        </div>
      </section>

      ${statusOf(t) ? `
      <section class="mp-sec" aria-labelledby="mp-status">
        <h3 id="mp-status">Статус звернення</h3>
        <div class="statuspick" role="group" aria-labelledby="mp-status">
          ${D.STATUSES.map(s => `<button type="button" data-act="status" data-status="${s.key}" aria-pressed="${s.key === t.status}">${esc(s.label)}</button>`).join('')}
        </div>
      </section>` : ''}

      <section class="mp-sec" aria-labelledby="mp-topic">
        <h3 id="mp-topic">Доступ і стан</h3>
        <div class="modactions">
          ${stateRow('Публікації', t.locked ? 'Закрито: нові публікації вимкнено для всіх' : isInfo(t) ? 'Доповнення публікує команда' : 'Відкрита для відповідей', t.locked, 'lock', t.locked ? 'Відкрити тему' : 'Закрити тему')}
          ${stateRow('Видимість', t.hiddenTopic ? 'Схована від гравців' : 'Видима всім, хто бачить розділ', t.hiddenTopic, 'hideTopic', t.hiddenTopic ? 'Відновити тему' : 'Сховати тему')}
          ${stateRow('Закріплення', t.pinned ? 'Вгорі списку розділу' : 'Звичайний порядок', t.pinned, 'pin', t.pinned ? 'Відкріпити' : 'Закріпити')}
        </div>
      </section>

      <section class="mp-sec" aria-labelledby="mp-place">
        <h3 id="mp-place">Назва і розділ</h3>
        <form class="mp-form" id="mp-rename" novalidate>
          <label class="mp-label" for="mp-title-input">Назва теми</label>
          <div class="mp-stack">
            <textarea id="mp-title-input" rows="2" maxlength="140" aria-describedby="mp-title-err">${esc(t.title)}</textarea>
            <button class="btn" type="submit">Зберегти назву</button>
          </div>
          <span class="err" id="mp-title-err"></span>
        </form>
        <form class="mp-form" id="mp-move" novalidate>
          <label class="mp-label" for="mp-section">Перенести до розділу</label>
          <div class="mp-hide">
            <select id="mp-section" aria-describedby="mp-move-err">${sections.map(s => `<option value="${s.slug}"${s.slug === t.section ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
            <button class="btn" type="submit">Перенести</button>
          </div>
          <span class="err" id="mp-move-err"></span>
        </form>
      </section>

      ${replies.length ? `
      <section class="mp-sec" aria-labelledby="mp-msgs">
        <h3 id="mp-msgs">Повідомлення</h3>
        <label class="mp-label" for="mp-reply">Вибрана відповідь</label>
        <div class="mp-hide">
          <select id="mp-reply">${replies.map(r => `<option value="${r.id}"${r === sel ? ' selected' : ''}>#${numOf(t, r.id)} · ${esc(r.author.name)}${r.hidden ? ' (приховано)' : ''}</option>`).join('')}</select>
          <button class="btn" type="button" data-act="${sel.hidden ? 'show' : 'hide'}" data-id="${sel.id}">${sel.hidden ? 'Відновити' : 'Приховати'}</button>
        </div>
      </section>` : ''}

      <section class="mp-sec mp-foot" aria-labelledby="mp-hist">
        <button class="btn btn-undo" type="button" data-undo ${undoOk ? '' : 'disabled'}>↶ Скасувати останню дію</button>
        <p class="mp-hint" id="undo-hint">${!top ? 'Скасовувати поки нічого.' : undoOk ? `Скасує: «${esc(top.label)}». У журналі з’явиться новий запис про скасування.` : 'Останню дію виконав розробник — скасувати її може лише розробник.'}</p>
        <h3 id="mp-hist">Історія дій</h3>
        ${stack.length
          ? `<ol class="history" reversed>${[...stack].reverse().map(h => `<li><time>${h.time}</time><span>${esc(h.label)} · ${esc(userBy(h.by).name)}</span></li>`).join('')}</ol>`
          : '<p class="mp-hint">Дій ще не було.</p>'}
        ${canModerate() ? `<a class="smalllink" href="#/team/log?q=${encodeURIComponent(t.title)}">Усі дії з темою в журналі →</a>` : ''}
      </section>
    </aside>`;
  }

  // Шлях у шапці й заголовок вкладки залежать від назви та розділу теми
  function topicChrome(t) {
    const r = rowBy(t.section);
    const label = t.title;
    setCrumbs([...baseCrumbs, { label: r.name, href: `#/section/${r.slug}`, shrink: true }, { label, shrink: true, topic: true }]);
    document.title = `${label} · Форум Veltmoor RP`;
  }

  function renderTopic(t) {
    const r = rowBy(t.section);
    // Панель керування — модератору й розробнику в розділах, якими вони керують
    const isMod = canModerate() && canManage(r);
    const st = statusOf(t);
    const mute = activeOf(state.userId, 'mute');
    if (state.shownTopic !== t.id) { state.editing = null; }
    state.shownTopic = t.id;
    const msgs = messagesOf(t);
    const [first, ...replies] = msgs;
    topicChrome(t);
    const g = genreOf(r);
    const threadTitle = isInfo(t) ? 'Доповнення команди' : 'Відповіді';
    const readOnly = readOnlyInfo(t);
    const kind = isInfo(t) ? { label: 'Інформаційна тема', line: 'Офіційний матеріал · Лише читання для гравців' }
      : isAppeal(t) ? { label: 'Обговорення', line: 'Проблема · Рішення · Діалог' }
      : { label: 'Обговорення', line: 'Питання · Відповіді · Діалог' };
    const stateLabel = t.locked ? 'Тему закрито' : isInfo(t) ? 'Інформаційна тема' : 'Відкрита тема';
    const toc = tocOf(t);
    const lastMsg = [...msgs].reverse().find(m => !m.hidden) || first;
    const participants = [...new Map(msgs.map(m => [m.author.name, m.author])).values()];

    $('#view-topic').innerHTML = `
      ${banner()}
      <div class="topicpage${isMod ? ' with-panel' : ''}${isInfo(t) ? ' is-info' : ''}">
        <div class="tp-main">
          ${t.draft ? `<div class="demo-banner" role="note"><span aria-hidden="true">ⓘ</span><div><b>Чернетка демонстрації.</b> Ця тема існує лише в поточній вкладці й зникне після оновлення сторінки.</div></div>` : ''}
          <header class="tp-head g-${g}">
            <div class="tp-headline">
              <p class="kicker"><a href="#/section/${r.slug}">${esc(r.name)}</a>${t.sub ? ' / ' + esc(t.sub.replace(/ › /g, ' / ')) : ''}</p>
              <h1 id="topic-title" tabindex="-1">${esc(t.title)}</h1>
              <p class="tp-by">${avatar(t.author, 'sm')}<b>${userLink(t.author)}</b>${roleBadge(t.author)}<span>${fmtDateTime(t.at)}</span>${t.edited ? `<span>Оновлено: ${fmtDateTime(t.edited)}</span>` : ''}<span>${plural(msgs.length, 'повідомлення', 'повідомлення', 'повідомлень')}</span></p>
              <div class="topicinfo"><b class="tp-kind">${kind.label}</b><span class="th-line">${kind.line}</span>${st ? `<span class="status status-${t.status}">${esc(st.label)}</span>` : ''}${t.hiddenTopic ? '<span class="status status-closed">Сховано від гравців</span>' : ''}</div>
            </div>
            <div class="tp-actions">
              <span class="tp-pin">${t.pinned ? '📌 Закріплено' : ''}</span>
              <div class="th-slot">${readOnly ? `<p class="th-read">${t.locked ? '🔒 Тему закрито · ' : ''}Матеріал для читання</p>` : canPost(t)
                ? `<button class="btn btn-primary replytop" type="button" data-reply-top>${isInfo(t) ? 'Додати доповнення' : 'Відповісти в тему'} <span aria-hidden="true">↓</span></button>`
                : mute && !t.locked ? `<p class="th-closed">🔇 Мут до ${hhmm(new Date(mute.until))}</p>`
                : `<p class="th-closed">${t.locked ? '🔒 Нові відповіді вимкнено' : 'Відповіді публікує команда'}</p>`}</div>
              <small class="th-hint">${readOnly ? 'Публікують модератори й розробники' : canPost(t) ? 'Або цитуйте конкретне повідомлення' : mute && !t.locked ? 'Під час муту тему можна читати' : t.locked ? 'Тему можна лише читати' : 'Тему можна читати без відповіді'}</small>
            </div>
          </header>
          <div class="feed">
            ${messageHtml(t, first, 1, isMod)}
            ${readOnly && !replies.length ? '' : `<section class="thread" aria-labelledby="thread-title">
              <h2 class="thread-title" id="thread-title">${threadTitle}<span>${replies.length}</span></h2>
              <div class="thread-body">
                ${replies.map((m, i) => messageHtml(t, m, i + 2, isMod)).join('')}
                ${editorHtml(t, isMod)}
              </div>
            </section>`}
          </div>
        </div>
        <aside class="tp-aside" aria-label="Про тему">
          ${isMod ? panelHtml(t) : cityMap('mini')}
          ${toc.length ? `<nav class="toc" aria-labelledby="toc-title"><h3 id="toc-title">У цій темі</h3><ol>${toc.map((s, i) => `<li><button type="button" data-toc="${s.id}"${i === 0 ? ' aria-current="true"' : ''}>${esc(s.title)}</button></li>`).join('')}</ol></nav>` : ''}
          ${!toc.length && participants.length > 1 ? `<section class="people" aria-labelledby="ppl-title"><h3 id="ppl-title">Учасники розмови</h3><ul>${participants.map(a => `<li>${avatar(a, 'xs')}${userLink(a)}${teamRoleOf(a) ? `<small>${ROLE_LABEL[roleKey(a)]}</small>` : ''}</li>`).join('')}</ul></section>` : ''}
          <dl class="facts">
            <div><dt>Стан</dt><dd>${stateLabel}</dd></div>
            <div><dt>Переглядів</dt><dd>${(t.views || 0).toLocaleString('uk-UA')}</dd></div>
            <div><dt>${isInfo(t) ? 'Доповнень' : 'Відповідей'}</dt><dd>${replies.length}</dd></div>
            <div><dt>Остання активність</dt><dd>${fmtDateTime(lastMsg.edited || lastMsg.at)}<small>${esc(lastMsg.author.name)}</small></dd></div>
          </dl>
        </aside>
      </div>`;
  }

  function currentTopic() {
    const m = location.hash.match(/^#\/topic\/([\w-]+)/);
    return m ? topicBy(m[1]) : null;
  }

  /* ---------- Дії модератора зі скасуванням ---------- */
  const snapshot = t => ({
    status: t.status, access: t.access, pinned: !!t.pinned, locked: !!t.locked, hiddenTopic: !!t.hiddenTopic,
    title: t.title, section: t.section, sub: t.sub,
    hidden: t.replies.filter(r => r.hidden).map(r => r.id),
    content: messagesOf(t).map(m => ({ id: m.id, text: m.text, body: m.body, edited: m.edited }))
  });
  // Вміст повідомлення: перше зберігається в самій темі, решта — у відповідях
  function setContent(t, id, c) {
    const target = id === `${t.id}-1` ? t : t.replies.find(r => r.id === id);
    if (!target) return;
    target.text = c.text; target.body = c.body; target.edited = c.edited;
  }
  function restore(t, s) {
    Object.assign(t, { status: s.status, access: s.access, pinned: s.pinned, locked: s.locked, hiddenTopic: s.hiddenTopic, title: s.title, section: s.section, sub: s.sub });
    t.replies.forEach(r => { r.hidden = s.hidden.includes(r.id); });
    s.content.forEach(c => setContent(t, c.id, c));
  }
  // Кожна дія спершу зберігає попередній стан і пише запис у журнал; скасування — окремий новий запис
  const ACCESS_NAME = { info: 'Інформаційна тема', discussion: 'Обговорення' };
  function act(t, kind, arg) {
    if (!canModerate() || !canManage(rowBy(t.section))) return null; // перевірка прав на рівні дії, не лише кнопки
    const before = snapshot(t);
    let label, from, to, section = t.section;
    if (kind === 'status') {
      if (!statusOf(t) || arg === t.status) return null;
      from = statusOf(t).label; to = D.STATUSES.find(s => s.key === arg).label;
      label = `Статус: ${from} → ${to}`;
      t.status = arg;
    } else if (kind === 'access') {
      if (arg === t.access) return null;
      from = ACCESS_NAME[t.access]; to = ACCESS_NAME[arg];
      t.access = arg;
      label = `Тип: ${to}`;
    } else if (kind === 'pin') {
      t.pinned = !t.pinned;
      from = t.pinned ? 'Звичайний порядок' : 'Закріплено'; to = t.pinned ? 'Закріплено' : 'Звичайний порядок';
      label = t.pinned ? 'Тему закріплено' : 'Тему відкріплено';
    } else if (kind === 'lock') {
      t.locked = !t.locked;
      from = t.locked ? 'Відкрита' : 'Закрита'; to = t.locked ? 'Закрита' : 'Відкрита';
      label = t.locked ? 'Тему закрито' : 'Тему відкрито';
    } else if (kind === 'hideTopic') {
      t.hiddenTopic = !t.hiddenTopic;
      from = t.hiddenTopic ? 'Видима' : 'Схована'; to = t.hiddenTopic ? 'Схована' : 'Видима';
      label = t.hiddenTopic ? 'Тему сховано' : 'Тему відновлено';
    } else if (kind === 'rename') {
      if (arg === t.title) return null;
      from = t.title; to = arg;
      label = `Назву змінено: «${excerpt(t.title, 40)}» → «${excerpt(arg, 40)}»`;
      t.title = arg;
    } else if (kind === 'move') {
      if (arg === t.section || !canManage(rowBy(arg))) return null;
      from = rowBy(t.section).name; to = rowBy(arg).name;
      label = `Перенесено: ${from} → ${to}`;
      t.section = arg;
      t.sub = undefined; // підрозділ належав попередньому розділу
    } else if (kind === 'hide' || kind === 'show') {
      const r = t.replies.find(x => x.id === arg);
      if (!r || !!r.hidden === (kind === 'hide')) return null;
      r.hidden = kind === 'hide';
      state.selReply[t.id] = r.id;
      from = `Відповідь #${numOf(t, r.id)} ${r.hidden ? 'видима' : 'прихована'}`; to = r.hidden ? 'Прихована' : 'Видима';
      label = `Відповідь #${numOf(t, r.id)} ${r.hidden ? 'приховано' : 'відновлено'}`;
    } else if (kind === 'edit') {
      const m = messagesOf(t).find(x => x.id === arg.id);
      from = excerpt(plainOf(m), 80); to = excerpt(stripMarks(arg.text), 80);
      setContent(t, arg.id, { text: arg.text, body: undefined, edited: localIso(nowDate()) });
      label = `Повідомлення #${numOf(t, arg.id)} відредаговано`;
    } else return null;
    const logId = logAdd({ type: `topic.${kind}`, target: { kind: 'topic', id: t.id, label: t.title }, section, before: from, after: to });
    (state.history[t.id] ||= []).push({ label, time: hhmm(nowDate()), before, by: state.userId, byRole: myRole(), logId, from, to, kind });
    return label;
  }
  // Модератор не скасовує дії розробника
  const canUndo = h => isDev() || h.byRole !== 'dev';
  function undo(t) {
    const stack = state.history[t.id] || [];
    const h = stack.at(-1);
    if (!h || !canUndo(h) || !canManage(rowBy(t.section))) return null;
    stack.pop();
    restore(t, h.before);
    logAdd({ type: 'undo', target: { kind: 'topic', id: t.id, label: t.title }, section: t.section, before: h.to, after: h.from, undoOf: h.logId, note: h.label });
    return h.label;
  }

  function scrollToEditor() {
    const ed = $('#editor');
    if (!ed) return;
    ed.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    $('#reply-text').focus({ preventScroll: true });
  }

  /* ---------- Керування розділами (команда) ---------- */
  function sectionForm(r) {
    const vis = r ? r.visibility : 'team';
    const by = r ? r.topicsBy : 'team';
    const prev = r?.visHistory.at(-1);
    const canRestore = prev && (prev !== 'dev' || isDev());
    const radio = (name, value, label, hint, checked, disabled) => `<label class="choice${disabled ? ' is-disabled' : ''}">
        <input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span><b>${label}</b><small>${hint}</small></span></label>`;
    return `<form id="secform" class="card secform" data-slug="${r ? r.slug : ''}" novalidate>
      <h2>${r ? `Налаштування: ${esc(r.name)}` : 'Новий розділ'}</h2>
      <div class="field"><label for="s-name">Назва</label><input id="s-name" type="text" maxlength="60" value="${esc(r?.name || '')}" aria-describedby="s-name-err" autocomplete="off"><span class="err" id="s-name-err"></span></div>
      <div class="field"><label for="s-desc">Опис <span class="opt">(необов’язково)</span></label><textarea id="s-desc" rows="2" maxlength="160">${esc(r?.desc || '')}</textarea></div>
      <div class="field"><label for="s-group">Група на головній</label><select id="s-group">${D.STRUCTURE.map(g => `<option value="${g.key}"${(r ? r.group.key : 'main') === g.key ? ' selected' : ''}>${esc(g.title)}</option>`).join('')}</select></div>
      <fieldset class="field"><legend>Хто бачить розділ</legend>
        ${radio('s-vis', 'public', 'Публічний', 'Бачать усі, зокрема гравці', vis === 'public')}
        ${radio('s-vis', 'team', 'Розділ команди', 'Хелпери, модератори й розробники', vis === 'team')}
        ${radio('s-vis', 'dev', 'Розділ розробників', isDev() ? 'Лише розробники' : 'Лише розробники — призначає тільки розробник', vis === 'dev', !isDev())}
        ${prev ? `<div class="restorevis"><button class="btn" type="button" data-restore-vis ${canRestore ? '' : 'disabled'}>↶ Відновити попередню видимість: ${VIS[prev]}</button>${canRestore ? '' : '<small>Лише розробник може повернути доступ «Розробники».</small>'}</div>` : ''}
      </fieldset>
      <fieldset class="field"><legend>Хто створює теми</legend>
        ${radio('s-by', 'players', 'Гравці й команда', 'Гравці бачать кнопку «Створити тему»', by === 'players')}
        ${radio('s-by', 'team', 'Лише модератори й розробники', 'Гравці й хелпери можуть лише читати й відповідати', by === 'team')}
      </fieldset>
      <div class="route-actions"><button class="btn btn-primary" type="submit">${r ? 'Зберегти зміни' : 'Створити розділ'}</button><a class="btn" href="#/manage">Скасувати</a></div>
    </form>`;
  }

  function renderManage(slug) {
    const r = slug ? rowBy(slug) : null;
    const list = ROWS.filter(x => canSee(x) && !x.external);
    $('#view-manage').innerHTML = `
      ${teamHead('manage', 'Керування розділами', 'Модератор керує публічними розділами й розділом команди. Розділ розробників бачить і змінює лише розробник. Кожна зміна потрапляє в журнал.', 'manage-title')}
      <div class="managegrid">
        <section class="card" aria-labelledby="sec-list-title">
          <h2 class="topic-list-title" id="sec-list-title">Розділи</h2>
          ${list.map(x => `<div class="topicrow${x === r ? ' is-current' : ''}">
            <div class="avatar" aria-hidden="true">${x.icon}</div>
            <div class="topictext"><a href="#/section/${x.slug}">${esc(x.name)}</a>
              <small>${esc(x.group.title)} · ${VIS[x.visibility]} · теми створюють: ${x.topicsBy === 'players' ? 'гравці й команда' : 'лише команда'}</small></div>
            <div class="topicmeta">${canManage(x) ? `<a class="linkbtn" href="#/manage/${x.slug}">Змінити<span class="sr"> ${esc(x.name)}</span></a>` : ''}</div>
          </div>`).join('')}
        </section>
        ${r ? sectionForm(r) : sectionForm(null)}
      </div>`;
  }

  function saveSection(form) {
    const name = $('#s-name').value.replace(/\s+/g, ' ').trim();
    if (name.length < 3) { $('#s-name-err').textContent = 'Назва має містити щонайменше 3 символи.'; $('#s-name').setAttribute('aria-invalid', 'true'); $('#s-name').focus(); return; }
    const vis = form.querySelector('[name="s-vis"]:checked').value;
    if (!canModerate() || (vis === 'dev' && !isDev())) return; // захист на випадок підміни форми
    const data = {
      name, desc: $('#s-desc').value.trim(), visibility: vis,
      topicsBy: form.querySelector('[name="s-by"]:checked').value,
      group: D.STRUCTURE.find(g => g.key === $('#s-group').value)
    };
    const BY = { players: 'Гравці й команда', team: 'Лише модератори й розробники' };
    const r = form.dataset.slug && rowBy(form.dataset.slug);
    if (r) {
      if (!canManage(r)) return;
      const changes = [
        r.name !== name && ['section.name', r.name, name],
        r.visibility !== vis && ['section.visibility', VIS[r.visibility], VIS[vis]],
        r.topicsBy !== data.topicsBy && ['section.topicsBy', BY[r.topicsBy], BY[data.topicsBy]],
        (r.desc || '') !== data.desc && ['section.desc', excerpt(r.desc || '—', 60), excerpt(data.desc || '—', 60)],
        r.group !== data.group && ['section.group', r.group.title, data.group.title]
      ].filter(Boolean);
      if (r.visibility !== vis) r.visHistory.push(r.visibility); // щоб можна було повернути попередню видимість
      Object.assign(r, data);
      changes.forEach(([type, before, after]) => logAdd({ type, target: { kind: 'section', id: r.slug, label: r.name }, section: r.slug, before, after }));
      toast(changes.length ? `Розділ «${name}» оновлено. Записів у журналі: ${changes.length}.` : 'Змін немає.');
    } else {
      const slug = `sec${++state.sectionSeq}`;
      ROWS.push({ slug, icon: vis === 'public' ? '◆' : '▣', children: [], visHistory: [], ...data });
      logAdd({ type: 'section.create', target: { kind: 'section', id: slug, label: name }, section: slug, before: '—', after: `${VIS[vis]} · ${BY[data.topicsBy]}` });
      toast(`Розділ «${name}» створено. Демо: лише в цій вкладці.`);
    }
    // Та сама адреса не викликає hashchange — тоді перемальовуємо вручну
    if (location.hash === '#/manage') route(); else location.hash = '#/manage';
  }

  /* ---------- Команда: учасники, покарання, журнал ---------- */
  const DEMO_NOTE = 'Демо: вхід без пароля, ролі перемикаються вкладками. Перевірки працюють лише в цьому браузері й не є захистом — у справжньому форумі права й покарання має перевіряти сервер. Дані живуть до оновлення сторінки.';
  const authorOf = u => ({ id: u.id, name: u.name, initials: u.initials, group: u.group });

  // Шапка сторінок команди з вкладками за доступом ролі
  function teamHead(active, title, desc, id) {
    const tabs = [
      ['people', '#/team/people', 'Учасники й покарання', isTeam()],
      ['log', '#/team/log', 'Журнал дій', canModerate()],
      ['manage', '#/manage', 'Розділи', canModerate()]
    ].filter(x => x[3]);
    return `<header class="team-head">
      <span class="kicker">Панель команди · ${ROLE_NAME[myRole()]}</span>
      <h1 id="${id}" tabindex="-1">${title}</h1>
      <p class="pg-desc">${desc}</p>
      <nav class="team-tabs" aria-label="Розділи панелі команди">${tabs.map(([k, href, label]) => `<a href="${href}"${k === active ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <p class="demo-note" role="note"><b>Лише демонстрація.</b> ${DEMO_NOTE}</p>
    </header>`;
  }

  // Демо-годинник: перемотати час, щоб побачити закінчення терміну
  function clockCard() {
    return `<section class="clockcard" aria-labelledby="clock-title">
      <h3 id="clock-title">Демо-час</h3>
      <p class="clock-now"><b>${fmtTs(now())}</b><small>${state.clockOffset ? `перемотано на ${spanText(state.clockOffset)} вперед` : 'реальний час'}</small></p>
      <div class="clock-btns" role="group" aria-label="Перемотати демо-час">
        <button class="btn" type="button" data-clock="10">+10 хв</button><button class="btn" type="button" data-clock="60">+1 год</button><button class="btn" type="button" data-clock="1440">+1 день</button><button class="btn" type="button" data-clock="10080">+7 днів</button>
        ${state.clockOffset ? '<button class="btn" type="button" data-clock="reset">Скинути</button>' : ''}
      </div>
      <p class="mp-hint">Лише для перевірки демо: час змінюється тільки в цій вкладці. Коли термін минає, доступ відновлюється автоматично.</p>
    </section>`;
  }

  const activeLine = u => {
    const b = activeOf(u.id, 'ban'), m = activeOf(u.id, 'mute');
    return [b && `<span class="pstat ps-ban">Бан ${b.until == null ? 'постійний' : `до ${fmtTs(b.until)}`}</span>`,
      m && `<span class="pstat ps-mute">Мут до ${fmtTs(m.until)}</span>`].filter(Boolean).join('') || '<span class="pstat ps-none">Без обмежень</span>';
  };

  function renderPeople() {
    const q = (state.peopleQ || '').trim().toLowerCase();
    const f = state.peopleF || '';
    const list = USERS.filter(u => (!q || u.name.toLowerCase().includes(q))
      && (!f || (f === 'restricted' ? isBanned(u.id) || isMuted(u.id) : f === 'team' ? u.role !== 'player' : true)))
      .sort((a, b) => RANK[b.role] - RANK[a.role] || a.name.localeCompare(b.name));
    const r = myRole();
    const rights = {
      helper: ['Мут гравцям: 10 хв, 1 год, 12 год або 24 год.', 'Знімає лише власний активний мут.', 'Не видає бан і не карає команду.'],
      mod: ['Мут гравцям і хелперам; тимчасовий бан форуму: 1 год, 24 год, 3 дні або 7 днів.', 'Знімає покарання хелперів і власні.', 'Не карає модераторів і розробників, не видає постійний бан, не змінює ролі.'],
      dev: ['Будь-які покарання для будь-якої ролі, включно з постійним баном форуму.', 'Призначає ролі команди в картці учасника.', 'Бачить повний журнал, зокрема власні дії.']
    }[r];
    $('#view-team').innerHTML = `
      ${teamHead('people', 'Учасники й покарання', 'Оберіть учасника, щоб відкрити його картку з історією та панеллю покарань. Бан діє лише на форумі: ігровий сервер і обліковий запис поза форумом не зачіпає.', 'team-title')}
      <div class="team-grid">
        <section class="card people-card" aria-labelledby="people-title">
          <div class="people-tools">
            <h2 id="people-title">Учасники <span class="count">${list.length}</span></h2>
            <label class="sr" for="people-q">Пошук учасника</label>
            <input id="people-q" type="search" placeholder="Пошук за нікнеймом…" value="${esc(state.peopleQ || '')}" autocomplete="off">
            <label class="sr" for="people-f">Фільтр</label>
            <select id="people-f"><option value="">Усі</option><option value="restricted"${f === 'restricted' ? ' selected' : ''}>З активним покаранням</option><option value="team"${f === 'team' ? ' selected' : ''}>Команда</option></select>
          </div>
          <ol class="people-list">${list.length ? list.map(u => `<li class="pl-row">
            ${avatar(u)}
            <div class="pl-main">${userLink(u, 'pl-name')}${roleBadge(u)}<small>${esc(u.group)}${u.id === state.userId ? ' · це ви' : ''}</small></div>
            <div class="pl-stat">${activeLine(u)}</div>
            <a class="linkbtn" href="#/user/${u.id}">Картка →<span class="sr"> ${esc(u.name)}</span></a>
          </li>`).join('') : '<li class="empty">Нікого не знайдено.</li>'}</ol>
        </section>
        <aside class="team-aside">
          <section class="rightscard" aria-labelledby="rights-title"><h3 id="rights-title">Ваші повноваження · ${ROLE_NAME[r]}</h3><ul>${rights.map(x => `<li>${x}</li>`).join('')}</ul></section>
          ${clockCard()}
        </aside>
      </div>`;
  }

  /* Картка учасника з панеллю покарань */
  function punishFormHtml(u, opts) {
    const d = state.punDraft && state.punDraft.userId === u.id ? state.punDraft : (state.punDraft = { userId: u.id, type: 'mute', dur: MUTE_DUR[0], reason: '' });
    if (d.type === 'ban' && !opts.ban) d.type = 'mute';
    if (d.type === 'perm' && !opts.perm) d.type = 'mute';
    const durs = d.type === 'mute' ? opts.mute : d.type === 'ban' ? opts.ban : [];
    if (d.type !== 'perm' && !durs.includes(+d.dur)) d.dur = durs[0];
    const kind = d.type === 'mute' ? 'mute' : 'ban';
    const existing = activeOf(u.id, kind);
    const blocked = existing && !canLift(existing);
    const until = d.type === 'perm' ? null : now() + d.dur * 60000;
    const typeRadio = (v, label, hint) => `<label class="choice"><input type="radio" name="pf-type" value="${v}"${d.type === v ? ' checked' : ''}><span><b>${label}</b><small>${hint}</small></span></label>`;
    return `<form id="punform" class="punform" data-user="${u.id}" novalidate>
      <p class="pf-user"><span>Користувач</span><b>${esc(u.name)}</b>${roleBadge(u) || '<span class="pf-role">Гравець</span>'}</p>
      <fieldset class="field"><legend>Покарання</legend>
        ${typeRadio('mute', 'Мут на форумі', 'Не може створювати теми й писати відповіді; читати може')}
        ${opts.ban ? typeRadio('ban', 'Тимчасовий бан форуму', 'Немає доступу до форуму на вказаний строк') : ''}
        ${opts.perm ? typeRadio('perm', 'Постійний бан форуму', 'Лише розробник; діє до зняття') : ''}
      </fieldset>
      ${d.type === 'perm' ? '' : `<div class="field"><label for="pf-dur">Строк</label>
        <select id="pf-dur">${durs.map(m => `<option value="${m}"${m === +d.dur ? ' selected' : ''}>${durLabel(m)}</option>`).join('')}</select></div>`}
      <div class="field"><label for="pf-reason">Причина <span class="opt">(обов’язково)</span></label>
        <textarea id="pf-reason" rows="2" maxlength="200" aria-describedby="pf-err" placeholder="Яке правило порушено, де саме">${esc(d.reason)}</textarea>
        <span class="err" id="pf-err"></span></div>
      <p class="pf-preview">${until == null ? 'Діє <b>безстроково</b> — до зняття розробником.' : `Почне діяти одразу й закінчиться <b>${fmtTs(until)}</b>.`} Обмеження стосується лише форуму.</p>
      ${existing ? `<p class="pf-warn${blocked ? ' is-blocked' : ''}" role="note">${blocked
        ? `Уже діє ${PTYPE[kind].toLowerCase()} №${existing.id} (${untilText(existing)}), виданий роллю «${ROLE_NAME[existing.byRole]}». Замінити його може той, хто має право його зняти.`
        : `Уже діє ${PTYPE[kind].toLowerCase()} №${existing.id} (${untilText(existing)}). Його буде знято з позначкою «замінено», а новий стане єдиним активним.`}</p>` : ''}
      <div class="route-actions"><button class="btn btn-primary" type="submit"${blocked ? ' disabled' : ''}>${d.type === 'perm' ? 'Видати постійний бан' : `Видати ${d.type === 'mute' ? 'мут' : 'бан'} на ${durLabel(+d.dur)}`}</button></div>
    </form>`;
  }

  function historyHtml(u) {
    const list = punishments.filter(p => p.userId === u.id).sort((a, b) => b.at - a.at);
    if (!list.length) return '<p class="mp-hint">Покарань не було.</p>';
    return `<ol class="punlist">${list.map(p => {
      const st = punStatus(p);
      const lift = canLift(p);
      const by = userBy(p.by);
      return `<li class="pun pun-${st}">
        <div class="pun-top"><b>${p.type === 'ban' && p.until == null ? 'Постійний бан' : PTYPE[p.type]} №${p.id}</b><span class="pstat ps-${st}">${PSTATUS[st]}</span></div>
        <dl class="pun-facts">
          <div><dt>Причина</dt><dd>${esc(p.reason)}</dd></div>
          <div><dt>Строк</dt><dd>${durLabel(p.durMin)}</dd></div>
          <div><dt>Видано</dt><dd>${fmtTs(p.at)} · ${esc(by.name)} (${ROLE_NAME[p.byRole]})</dd></div>
          <div><dt>Закінчення</dt><dd>${p.until == null ? 'Безстроково' : fmtTs(p.until)}${st === 'active' && p.until != null ? ` · ще ${spanText(p.until - now())}` : ''}</dd></div>
          ${p.removed ? `<div><dt>Знято</dt><dd>${fmtTs(p.removed.at)} · ${esc(userBy(p.removed.by).name)} · ${esc(p.removed.reason)}</dd></div>` : ''}
        </dl>
        ${lift ? `<form class="liftform" data-pun="${p.id}" novalidate>
          <label class="sr" for="lift-${p.id}">Причина зняття №${p.id}</label>
          <input id="lift-${p.id}" type="text" maxlength="160" placeholder="Причина дострокового зняття" aria-describedby="lift-err-${p.id}">
          <button class="btn" type="submit">Зняти достроково</button>
          <span class="err" id="lift-err-${p.id}"></span>
        </form>` : st === 'active' && isTeam() ? `<p class="mp-hint">Зняти може ${p.byRole === 'helper' ? 'хелпер, який видав, модератор або розробник' : p.byRole === 'mod' ? 'модератор, який видав, або розробник' : 'лише розробник'}.</p>` : ''}
      </li>`;
    }).join('')}</ol>`;
  }

  /* Список учасників: пошук за ніком і фільтр за роллю. Без покарань — вони лише в панелі команди. */
  function membersListHtml() {
    const q = (state.memQ || '').trim().toLowerCase();
    const f = state.memRole || '';
    const list = USERS.filter(u => (!q || u.name.toLowerCase().includes(q)) && (!f || u.role === f))
      .sort((a, b) => RANK[b.role] - RANK[a.role] || a.name.localeCompare(b.name));
    $('#mem-count').textContent = `${plural(list.length, 'учасник', 'учасники', 'учасників')}${q || f ? ` із ${USERS.length}` : ''}`;
    return list.length ? list.map(u => {
      const last = activityOf(u);
      const n = topicsOf(u).length, m = n + repliesOf(u).length;
      return `<li class="mb-row">
        ${avatar(u)}
        <div class="mb-main">${userLink(u, 'mb-name')}${roleBadge(u) || '<span class="pf-role">Гравець</span>'}
          <small>${u.id === state.userId ? 'Це ви · ' : ''}на форумі з ${fmtDate(u.joined)}</small></div>
        <span class="mb-num mb-t"><b>${n}</b>${word(n, 'тема', 'теми', 'тем')}</span>
        <span class="mb-num mb-m"><b>${m}</b>${word(m, 'повідомлення', 'повідомлення', 'повідомлень')}</span>
        <span class="mb-last">${last ? `<b>${relTs(last.at)}</b><small>${fmtTs(last.at)}</small>` : '<b>Немає даних</b><small>активності ще не було</small>'}</span>
      </li>`;
    }).join('') : `<li class="empty">Нікого не знайдено${q ? ` за ніком «${esc(state.memQ.trim())}»` : ''}.</li>`;
  }
  function renderMembers() {
    const f = state.memRole || '';
    const counts = Object.fromEntries(ROLES.map(([k]) => [k, USERS.filter(u => u.role === k).length]));
    $('#view-members').innerHTML = `
      ${banner()}
      <div class="pg pg-single members">
        <div class="pg-main">
          <header class="pg-head">
            <span class="kicker">Спільнота</span>
            <h1 id="members-title" tabindex="-1">Учасники</h1>
            <p class="pg-desc">Профілі гравців і команди форуму. Кількість тем і повідомлень — лише з розділів, доступних вам.</p>
          </header>
          <form class="mem-tools" id="memform" role="search" aria-label="Пошук учасників" novalidate>
            <div class="field mem-q"><label for="mem-q">Пошук за ніком</label><input id="mem-q" type="search" value="${esc(state.memQ || '')}" placeholder="Напр. Arlo або Helper" autocomplete="off"></div>
            <div class="mem-roles" role="group" aria-label="Фільтр за роллю">
              ${[['', 'Усі', USERS.length], ...ROLES.map(([k, full]) => [k, full, counts[k]])].map(([k, l, n]) => `<button type="button" class="chip" data-mem-role="${k}" aria-pressed="${f === k}">${l}<span>${n}</span></button>`).join('')}
            </div>
          </form>
          <p class="log-meta"><span id="mem-count" aria-live="polite"></span><span>Остання активність — з дій у демоданих і в цій вкладці.</span></p>
          <ol class="mem-list" id="mem-list"></ol>
        </div>
      </div>`;
    $('#mem-list').innerHTML = membersListHtml();
  }

  // Власний профіль: аватар і короткий опис. Роль тут не змінюється.
  const TONES = [0, 1, 2, 3, 4, 5];
  function profileFormHtml(u) {
    const d = state.profDraft && state.profDraft.userId === u.id ? state.profDraft
      : (state.profDraft = { userId: u.id, tone: u.tone ?? null, photo: u.photo || null, bio: u.bio || '' });
    const preview = { ...u, tone: d.tone, photo: d.photo };
    return `<section class="card pf-edit" aria-labelledby="pe-title">
      <h2 id="pe-title">Редагувати профіль</h2>
      <form id="profileform" novalidate>
        <div class="pe-avatar">
          <span id="pe-preview">${avatar(preview, 'xl')}</span>
          <fieldset class="pe-tones"><legend>Колір аватара</legend>
            ${TONES.map(n => `<label class="swatch tone-${n}"><input type="radio" name="pe-tone" value="${n}"${d.tone === n ? ' checked' : ''}><span class="sr">Колір ${n + 1}</span></label>`).join('')}
            <label class="swatch tone-none"><input type="radio" name="pe-tone" value=""${d.tone == null ? ' checked' : ''}><span class="sr">Без кольору</span></label>
          </fieldset>
          <div class="pe-photo">
            <label class="btn" for="pe-file">Завантажити фото</label>
            <input id="pe-file" class="sr" type="file" accept="image/*">
            ${d.photo ? '<button class="btn" type="button" data-photo-clear>Прибрати фото</button>' : ''}
          </div>
        </div>
        <div class="field"><label for="pe-bio">Коротко про себе <span class="opt">(до 200 символів)</span></label>
          <textarea id="pe-bio" rows="3" maxlength="200" aria-describedby="pe-count">${esc(d.bio)}</textarea>
          <small class="pe-count" id="pe-count">${d.bio.length} / 200</small></div>
        <p class="mp-hint">Фото показується лише в цій вкладці й нікуди не завантажується. Роль самостійно змінити не можна — її призначає розробник.</p>
        <div class="route-actions"><button class="btn btn-primary" type="submit">Зберегти профіль</button></div>
      </form>
    </section>`;
  }

  // Останні теми й повідомлення — лише ті, що доступні глядачу (без прихованих тем і закритих розділів)
  function contribHtml(u) {
    const ts = topicsOf(u), rs = repliesOf(u);
    const secName = t => rowBy(t.section).name + (rowBy(t.section).visibility !== 'public' ? ' · 🔒 ' + VIS[rowBy(t.section).visibility] : '');
    return `<div class="pf-lists">
      <section class="card pf-list" aria-labelledby="pt-title">
        <h2 id="pt-title">Останні теми <span>${ts.length}</span></h2>
        ${ts.length ? `<ol class="pf-items">${ts.slice(0, 5).map(t => `<li>
          <a href="#/topic/${t.id}">${esc(t.title)}</a>
          <small>${esc(secName(t))} · ${fmtTs(toMs(t.at))} · ${plural(postsOf(t).filter(r => !r.hidden || canModerate()).length, 'відповідь', 'відповіді', 'відповідей')}</small>
        </li>`).join('')}</ol>` : '<p class="empty">Тем ще немає.</p>'}
      </section>
      <section class="card pf-list" aria-labelledby="pm-title">
        <h2 id="pm-title">Останні повідомлення <span>${rs.length}</span></h2>
        ${rs.length ? `<ol class="pf-items">${rs.slice(0, 5).map(({ t, r }) => `<li>
          <a href="#/topic/${t.id}?m=${r.id}">${esc(excerpt(plainOf(r), 110))}</a>
          <small>у темі «${esc(excerpt(t.title, 60))}» · ${fmtTs(toMs(r.at))}${r.hidden ? ' · <span class="pstat ps-mute">приховано</span>' : ''}</small>
        </li>`).join('')}</ol>` : '<p class="empty">Повідомлень ще немає.</p>'}
      </section>
    </div>`;
  }

  function renderUser(u) {
    const self = u.id === state.userId;
    const opts = punishOptions(u);
    // Причини покарань і службова історія — лише команді; гравець у своєму профілі бачить тільки поточне обмеження
    const showHist = isTeam();
    const ts = topicsOf(u), rs = repliesOf(u);
    const last = activityOf(u);
    const restricted = isBanned(u.id) || isMuted(u.id);
    const why = isTeam() && !self && !opts
      ? (myRole() === 'helper' ? 'Хелпер може видавати мут лише гравцям.' : myRole() === 'mod' ? 'Модератор не карає інших модераторів і розробників.' : '') : '';
    $('#view-user').innerHTML = `
      <div class="pg">
        <div class="pg-main">
          <header class="pg-head profile-head pf-${u.role}">
            <span class="kicker">${self ? 'Ваш профіль' : ROLE_NAME[u.role]}</span>
            <div class="ph-row">${avatar(u, 'xl')}<div class="ph-id"><h1 id="user-title" tabindex="-1">${esc(u.name)}</h1>
              <p class="ph-meta">${roleBadge(u) || '<span class="pf-role">Гравець</span>'}${u.group !== ROLE_NAME[u.role] ? `<span>${esc(u.group)}</span>` : ''}</p>
              <p class="ph-bio">${u.bio ? esc(u.bio) : '<span class="muted">Опис не додано.</span>'}</p></div></div>
            <dl class="pf-stats">
              <div><dt>Зареєстровано</dt><dd>${fmtDate(u.joined)}<small>${relTs(toMs(u.joined))}</small></dd></div>
              <div><dt>Остання активність</dt><dd>${last ? `${fmtTs(last.at)}<small>${relTs(last.at)} · ${last.href ? `<a href="${last.href}">${esc(last.label)}</a>` : esc(last.label)}</small>` : 'Немає даних<small>Дій, які вам доступні, ще не було</small>'}</dd></div>
              <div><dt>Тем</dt><dd>${ts.length}</dd></div>
              <div><dt>Повідомлень</dt><dd>${ts.length + rs.length}<small>разом із першими в темах</small></dd></div>
            </dl>
            ${!isTeam() && !self ? '' : `<p class="ph-note">${isTeam() ? 'Лічильники й списки враховують лише теми, доступні вашій ролі.' : 'Інші учасники бачать лише ваші публічні теми й повідомлення.'}</p>`}
            ${(showHist || (self && restricted)) ? `<p class="ph-status">${activeLine(u)}</p>` : ''}
          </header>
          ${self ? profileFormHtml(u) : ''}
          ${contribHtml(u)}
          ${isTeam() ? `<h2 class="pf-staff-h">Службове<span>бачить лише команда</span></h2>` : ''}
          ${opts ? `<section class="card punpanel" aria-labelledby="pp-title">
            <h2 id="pp-title">Панель покарань</h2>
            <p class="mp-hint">Перед видачею вкажіть покарання, строк і причину. Запис одразу з’явиться в журналі дій.</p>
            ${punishFormHtml(u, opts)}
          </section>` : why ? `<p class="demo-note" role="note">${why}</p>` : ''}
          ${showHist ? `<section class="card" aria-labelledby="ph-title"><h2 id="ph-title">Історія покарань</h2>${historyHtml(u)}</section>` : ''}
          ${isDev() && !self ? `<section class="card" aria-labelledby="role-title"><h2 id="role-title">Роль на форумі</h2>
            <form id="roleform" class="roleform" data-user="${u.id}" novalidate>
              <label for="rf-role">Роль</label>
              <select id="rf-role">${ROLES.map(([k, full]) => `<option value="${k}"${u.role === k ? ' selected' : ''}>${full}</option>`).join('')}</select>
              <label class="sr" for="rf-reason">Причина зміни</label>
              <input id="rf-reason" type="text" maxlength="160" placeholder="Причина (необов’язково)">
              <button class="btn btn-primary" type="submit">Змінити роль</button>
            </form>
            <p class="mp-hint">Призначати ролі може лише розробник. Власну роль змінити не можна. Нова роль діє одразу — зокрема для демо-входу під цим записом.</p>
          </section>` : ''}
        </div>
        <aside class="pg-aside" aria-label="Про учасника">
          ${cityMap('mini')}
          <dl class="facts">
            <div><dt>Роль</dt><dd>${ROLE_NAME[u.role]}</dd></div>
            <div><dt>На форумі з</dt><dd>${fmtDate(u.joined)}</dd></div>
            <div><dt>Остання активність</dt><dd>${last ? `${relTs(last.at)}<small>${fmtTs(last.at)}</small>` : 'Немає даних'}</dd></div>
          </dl>
          ${showHist ? clockCard() : ''}
          <div class="aside-note"><h3>Учасники</h3><p>Пошук за ніком і фільтр за роллю.</p><a class="smalllink" href="#/members">Усі учасники →</a>
            ${isTeam() ? '<br><a class="smalllink" href="#/team/people">Покарання в панелі команди →</a>' : ''}</div>
        </aside>
      </div>`;
  }

  function issuePunishment(u, type, dur, reason) {
    const opts = punishOptions(u);
    if (!opts) return 'Ваша роль не може карати цього учасника.';
    if (reason.length < 5) return 'Вкажіть причину — щонайменше 5 символів.';
    if (type === 'perm' ? !opts.perm : !(opts[type] || []).includes(dur)) return 'Такий тип або строк недоступний для вашої ролі.';
    const kind = type === 'mute' ? 'mute' : 'ban';
    const existing = activeOf(u.id, kind);
    if (existing && !canLift(existing)) return 'Активне покарання видав старший за роллю — замінити його ви не можете.';
    const p = { id: ++punSeq, userId: u.id, type: kind, durMin: type === 'perm' ? null : dur, by: state.userId, byRole: myRole(), at: now(), reason, removed: null };
    p.until = p.durMin == null ? null : p.at + p.durMin * 60000;
    if (existing) {
      existing.removed = { by: state.userId, at: now(), reason: `Замінено покаранням №${p.id}` };
      logAdd({ type: 'punish.lift', target: { kind: 'user', id: u.id }, reason: `Замінено покаранням №${p.id}`, before: `${PTYPE[kind]} №${existing.id} ${untilText(existing)}`, after: 'Знято достроково (заміна)' });
    }
    punishments.push(p);
    logAdd({ type: type === 'perm' ? 'punish.perm' : `punish.${kind}`, target: { kind: 'user', id: u.id }, reason, term: durLabel(p.durMin),
      before: 'Без цього обмеження', after: `${PTYPE[kind]} №${p.id} ${p.until == null ? 'безстроково' : `до ${fmtTs(p.until)}`}` });
    state.punDraft = null;
    toast(`${type === 'perm' ? 'Постійний бан' : PTYPE[kind]} для ${u.name} видано${p.until ? ` до ${fmtTs(p.until)}` : ''}. Запис додано в журнал.`);
    return '';
  }
  function liftPunishment(p, reason) {
    if (!canLift(p)) return 'Ваша роль не може зняти це покарання.';
    if (reason.length < 3) return 'Вкажіть причину зняття.';
    const before = `${PTYPE[p.type]} №${p.id} ${untilText(p)}`;
    p.removed = { by: state.userId, at: now(), reason };
    logAdd({ type: 'punish.lift', target: { kind: 'user', id: p.userId }, reason, before, after: 'Знято достроково' });
    toast(`${PTYPE[p.type]} №${p.id} знято. Запис додано в журнал.`);
    return '';
  }
  function changeRole(u, role, reason) {
    if (!isDev() || u.id === state.userId || !RANK.hasOwnProperty(role) || u.role === role) return false;
    logAdd({ type: 'role', target: { kind: 'user', id: u.id }, before: ROLE_NAME[u.role], after: ROLE_NAME[role], reason });
    // Підпис групи для команди — назва ролі; ігрові підписи гравців (фракція тощо) не чіпаємо
    if (Object.values(ROLE_NAME).includes(u.group) || role !== 'player') u.group = ROLE_NAME[role];
    u.role = role;
    toast(`Роль ${u.name}: ${ROLE_NAME[role]}. Запис додано в журнал.`);
    return true;
  }

  /* Журнал дій */
  const LOG_TYPE = {
    'punish.mute': 'Мут', 'punish.ban': 'Тимчасовий бан', 'punish.perm': 'Постійний бан', 'punish.lift': 'Зняття покарання',
    'topic.status': 'Статус звернення', 'topic.access': 'Тип теми', 'topic.pin': 'Закріплення', 'topic.lock': 'Закриття теми', 'topic.hideTopic': 'Видимість теми',
    'topic.rename': 'Назва теми', 'topic.move': 'Перенесення теми', 'topic.hide': 'Приховано відповідь', 'topic.show': 'Відновлено відповідь', 'topic.edit': 'Редагування повідомлення',
    'section.visibility': 'Доступ до розділу', 'section.name': 'Назва розділу', 'section.topicsBy': 'Хто створює теми', 'section.desc': 'Опис розділу', 'section.group': 'Група розділу',
    'section.create': 'Новий розділ', 'section.restore': 'Відновлено видимість', role: 'Зміна ролі', undo: 'Скасування дії'
  };
  const LOG_GROUPS = [['punish', 'Видача покарань'], ['lift', 'Зняття покарань'], ['topic', 'Керування темами'], ['message', 'Повідомлення'], ['section', 'Розділи'], ['role', 'Ролі'], ['undo', 'Скасування дій']];
  const groupOf = type => type === 'punish.lift' ? 'lift' : type.startsWith('punish.') ? 'punish' : /^topic\.(hide|show|edit)$/.test(type) ? 'message'
    : type.startsWith('topic.') ? 'topic' : type.startsWith('section.') ? 'section' : type;
  const targetName = tg => tg.kind === 'user' ? userBy(tg.id)?.name || tg.id : tg.kind === 'topic' ? topicBy(tg.id)?.title || tg.label || tg.id : rowBy(tg.id)?.name || tg.label || tg.id;
  function targetHtml(tg) {
    if (tg.kind === 'user') { const u = userBy(tg.id); return u ? `${userLink(u)}${roleBadge(u)}` : esc(tg.id); }
    if (tg.kind === 'topic') { const t = topicBy(tg.id); return t && seeTopic(t) ? `тема <a href="#/topic/${t.id}">«${esc(t.title)}»</a>` : `тема «${esc(targetName(tg))}»`; }
    const r = rowBy(tg.id); return r && canSee(r) ? `розділ <a href="#/section/${r.slug}">«${esc(r.name)}»</a>` : `розділ «${esc(targetName(tg))}»`;
  }
  const localDay = ts => localIso(new Date(ts)).slice(0, 10);
  function logMatches(e, f) {
    if (f.staff && e.by !== f.staff) return false;
    if (f.type && groupOf(e.type) !== f.type) return false;
    if (f.date && localDay(e.at) !== f.date) return false;
    if (f.q) {
      const hay = [targetName(e.target), e.target.label || '', userBy(e.by).name, e.reason, e.before, e.after, e.note].join(' ').toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }
  function logRow(e) {
    const actor = userBy(e.by);
    const facts = [
      e.reason && ['Причина', esc(e.reason)],
      e.term && ['Строк', esc(e.term)],
      (e.before || e.after) && ['Було → стало', `${esc(e.before || '—')} <span aria-hidden="true">→</span><span class="sr"> змінено на </span> ${esc(e.after || '—')}`],
      e.undoOf && ['Скасовує', `запис #${e.undoOf}${e.note ? ` · ${esc(e.note)}` : ''}`]
    ].filter(Boolean);
    return `<li class="lg-row lg-${groupOf(e.type)}">
      <div class="lg-when"><b>${fmtTs(e.at)}</b><small>${relTs(e.at)}</small></div>
      <div class="lg-main">
        <p class="lg-head"><span class="lg-type">${LOG_TYPE[e.type] || e.type}</span><span class="lg-no">#${e.id}</span></p>
        <p class="lg-what">${userLink(actor)}<span class="rolebadge rb-${e.byRole}">${ROLE_NAME[e.byRole]}</span><span class="lg-arrow" aria-hidden="true">→</span>${targetHtml(e.target)}</p>
        ${facts.length ? `<dl class="lg-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
      </div>
    </li>`;
  }
  function renderLogList() {
    const f = state.logF;
    const visible = LOG.filter(canSeeLog);
    const found = visible.filter(e => logMatches(e, f)).reverse();
    $('#log-count').textContent = `${plural(found.length, 'запис', 'записи', 'записів')} із ${visible.length}`;
    $('#log-list').innerHTML = found.length ? found.map(logRow).join('') : '<li class="empty">Записів за цими фільтрами немає.</li>';
  }
  function renderLog(query) {
    state.logF ||= { staff: '', type: '', date: '', q: '' };
    if (query != null) state.logF = { staff: '', type: '', date: '', q: query };
    const f = state.logF;
    const visible = LOG.filter(canSeeLog);
    const staff = [...new Set(visible.map(e => e.by))].map(userBy).sort((a, b) => RANK[b.role] - RANK[a.role] || a.name.localeCompare(b.name));
    $('#view-team').innerHTML = `
      ${teamHead('log', 'Журнал дій', isDev()
        ? 'Повний журнал: дії всіх ролей, зокрема ваші власні та зміни закритих розділів.'
        : 'Дії хелперів і модераторів у доступних вам розділах, зокрема покарання. Дії розробників і розділ розробників тут не показано.', 'team-title')}
      <form class="logfilters card" id="logfilters" role="search" aria-label="Фільтри журналу" novalidate>
        <div class="field"><label for="lf-staff">Співробітник</label><select id="lf-staff"><option value="">Усі</option>${staff.map(u => `<option value="${u.id}"${f.staff === u.id ? ' selected' : ''}>${esc(u.name)} · ${ROLE_NAME[u.role]}</option>`).join('')}</select></div>
        <div class="field"><label for="lf-type">Тип дії</label><select id="lf-type"><option value="">Усі дії</option>${LOG_GROUPS.map(([k, l]) => `<option value="${k}"${f.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="lf-date">Дата</label><input id="lf-date" type="date" value="${f.date}"></div>
        <div class="field lf-q"><label for="lf-q">Пошук за учасником або темою</label><input id="lf-q" type="search" value="${esc(f.q)}" placeholder="Напр. Juno або «звернення»" autocomplete="off"></div>
        <button class="btn" type="button" data-log-reset>Скинути</button>
      </form>
      <p class="log-meta"><span id="log-count" aria-live="polite"></span><span>Записи не можна змінити чи видалити. «Скасувати дію» додає новий запис і зберігає вихідний.</span></p>
      <ol class="loglist" id="log-list"></ol>`;
    renderLogList();
  }

  // Бан: немає доступу до форуму. Інші сторінки не рендеряться взагалі.
  function renderBanned(p) {
    const by = userBy(p.by);
    $('#view-banned').innerHTML = `
      <div class="card bannedcard">
        <span class="kicker">Обмеження доступу</span>
        <h1 id="banned-title" tabindex="-1">Доступ до форуму обмежено</h1>
        <p class="ban-lede">${p.until == null ? 'Постійний бан форуму' : `Тимчасовий бан форуму до <b>${fmtTs(p.until)}</b> (ще ${spanText(p.until - now())})`}.</p>
        <dl class="pun-facts">
          <div><dt>Обліковий запис</dt><dd>${esc(me().name)}</dd></div>
          <div><dt>Причина</dt><dd>${esc(p.reason)}</dd></div>
          <div><dt>Видано</dt><dd>${fmtTs(p.at)} · ${ROLE_NAME[p.byRole]} ${esc(by.name)}</dd></div>
          <div><dt>Покарання</dt><dd>№${p.id}</dd></div>
        </dl>
        <p class="mp-hint">Обмеження діє лише на форумі: ігровий сервер і обліковий запис поза форумом воно не зачіпає. ${p.until == null ? 'Зняти постійний бан може лише розробник.' : 'Після закінчення строку доступ відновиться автоматично.'}</p>
        <div class="route-actions"><button class="btn" type="button" id="banned-switch" data-account>Змінити демо-вхід</button></div>
        ${clockCard()}
      </div>`;
  }

  /* Демо-вхід: список облікових записів */
  function accountModal() {
    openModal('Демо-вхід', 'Увійти як', `
      <p class="modalintro">Паролів і справжніх облікових записів тут немає: оберіть запис, щоб перевірити права його ролі. ${esc(DEMO_NOTE)}</p>
      ${ROLES.slice().reverse().map(([k, full]) => {
        const list = USERS.filter(u => u.role === k);
        return list.length ? `<h3 class="acc-role">${full}</h3><ul class="acclist">${list.map(u => `<li>${avatar(u, 'xs')}<span class="acc-name">${esc(u.name)}<small>${activeLine(u)}</small></span>
          ${u.id === state.userId ? '<span class="acc-cur">Ви тут</span>' : `<button class="btn" type="button" data-login="${u.id}">Увійти</button>`}</li>`).join('')}</ul>` : '';
      }).join('')}
      <div class="route-actions"><a class="btn" href="#/user/${state.userId}" data-close>Мій профіль</a><a class="btn" href="#/members" data-close>Учасники</a>${isTeam() ? '<a class="btn" href="#/team" data-close>Панель команди</a>' : ''}</div>`, '#modaltitle');
  }

  /* ---------- Маршрутизація ---------- */
  const views = { home: $('#view-home'), section: $('#view-section'), topic: $('#view-topic'), search: $('#view-search'), manage: $('#view-manage'), team: $('#view-team'), user: $('#view-user'), members: $('#view-members'), banned: $('#view-banned'), denied: $('#view-denied') };
  const show = name => Object.entries(views).forEach(([k, el]) => { el.hidden = k !== name; });
  let firstRender = true, lastSection = null;

  // Недоступне не розкриває навіть назви: для гравця закритий розділ «не існує»
  function renderDenied() {
    $('#view-denied').innerHTML = `${roleBar('<a class="btn" href="#/">← До форуму</a>')}
      <div class="card deniedcard"><h1 id="denied-title" tabindex="-1">Сторінку не знайдено</h1>
      <p>Розділ або тема не існує чи недоступні для вашої ролі.</p><a class="btn btn-primary" href="#/">На головну форуму</a></div>`;
    setCrumbs([...baseCrumbs, { label: 'Недоступно', shrink: true }]);
    document.title = 'Недоступно · Форум Veltmoor RP';
  }

  function route(keep = false) {
    const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
    const [kind, ...rest] = path.split('/');
    const arg = decodeURIComponent(rest.join('/'));
    const q = new URLSearchParams(query || '');
    let focusEl = null;
    const deny = () => { renderDenied(); show('denied'); focusEl = $('#denied-title'); };
    const ban = activeOf(state.userId, 'ban');

    if (ban) {
      // Забанений не бачить жодної сторінки форуму — лише пояснення з терміном
      renderBanned(ban);
      show('banned');
      setCrumbs([...baseCrumbs, { label: 'Доступ обмежено', shrink: true }]);
      document.title = 'Доступ обмежено · Форум Veltmoor RP';
      focusEl = $('#banned-title');
    } else if (kind === 'team') {
      const sub = arg || 'people';
      if (sub === 'people' && isTeam()) {
        renderPeople();
        show('team');
        setCrumbs([...baseCrumbs, { label: 'Панель команди', shrink: true }]);
        document.title = 'Учасники й покарання · Форум Veltmoor RP';
        focusEl = $('#team-title');
        if (!arg) history.replaceState(null, '', '#/team/people');
      } else if (sub === 'log' && canModerate()) {
        renderLog(q.has('q') ? q.get('q') : null);
        show('team');
        setCrumbs([...baseCrumbs, { label: 'Журнал дій', shrink: true }]);
        document.title = 'Журнал дій · Форум Veltmoor RP';
        focusEl = $('#team-title');
        if (q.has('q')) history.replaceState(null, '', '#/team/log');
      } else deny();
    } else if (kind === 'members') {
      renderMembers();
      show('members');
      setCrumbs([...baseCrumbs, { label: 'Учасники', shrink: true }]);
      document.title = 'Учасники · Форум Veltmoor RP';
      focusEl = $('#members-title');
    } else if (kind === 'user') {
      const u = userBy(arg);
      if (!u) deny();
      else {
        if (state.profDraft?.userId !== u.id || u.id !== state.userId) state.profDraft = null;
        renderUser(u);
        show('user');
        setCrumbs([...baseCrumbs, { label: 'Учасники', href: '#/members' }, { label: u.name, shrink: true }]);
        document.title = `${u.name} · Форум Veltmoor RP`;
        focusEl = $('#user-title');
      }
    } else if (kind === 'section') {
      const r = rowBy(arg);
      if (!canSee(r)) deny();
      else {
        if (lastSection !== arg) subFilter = null;
        lastSection = arg;
        renderSection(r);
        show('section');
        setCrumbs([...baseCrumbs, { label: r.name, shrink: true }]);
        document.title = `${r.name} · Форум Veltmoor RP`;
        focusEl = $('#section-title');
      }
    } else if (kind === 'topic') {
      const t = topicBy(arg);
      if (!t || !seeTopic(t)) deny();
      else {
        if (state.shownTopic !== t.id) state.replyTo = null;
        renderTopic(t); // також оновлює шлях у шапці та заголовок вкладки
        show('topic');
        focusEl = $('#topic-title');
        // Посилання з профілю на конкретне повідомлення: #/topic/o1?m=o1-r3
        const msg = q.get('m') && document.getElementById(`msg-${q.get('m')}`);
        if (msg) {
          history.replaceState(null, '', `#/topic/${t.id}`);
          requestAnimationFrame(() => { msg.scrollIntoView({ block: 'center' }); msg.setAttribute('tabindex', '-1'); msg.focus({ preventScroll: true }); msg.classList.add('is-target'); });
          focusEl = null; keep = true;
        }
      }
    } else if (kind === 'manage') {
      if (!canModerate() || (arg && !canManage(rowBy(arg)))) deny();
      else {
        renderManage(arg);
        show('manage');
        setCrumbs([...baseCrumbs, { label: 'Керування розділами', shrink: true }]);
        document.title = 'Керування розділами · Форум Veltmoor RP';
        focusEl = $('#manage-title');
      }
    } else if (kind === 'search') {
      renderSearch(arg);
      show('search');
      setCrumbs([...baseCrumbs, { label: 'Пошук', shrink: true }]);
      document.title = 'Пошук · Форум Veltmoor RP';
      focusEl = $('#search-title');
    } else {
      renderHome();
      show('home');
      setCrumbs(baseCrumbs);
      document.title = 'Форум Veltmoor RP';
      if (location.hash && location.hash !== '#/') history.replaceState(null, '', '#/');
    }

    renderRoleSwitch();
    // Активний пункт меню шапки визначає відкрита сторінка: усе, що є частиною форуму
    // (список розділів, розділ, тема, пошук) — «Форум»; керування — «Керування».
    // «Головна» — сайт проєкту поза форумом, тож у демо вона ніколи не підсвічується.
    const NAV_OF = { manage: 'team', team: 'team', members: 'members', user: 'members' };
    const activeNav = ban ? '' : NAV_OF[kind] || 'forum';
    $$('[data-nav]').forEach(a => a.toggleAttribute('aria-current', a.dataset.nav === activeNav));
    if (!firstRender && !keep) {
      window.scrollTo({ top: 0 });
      if (focusEl) { focusEl.setAttribute('tabindex', '-1'); focusEl.focus({ preventScroll: true }); }
    }
    firstRender = false;
  }
  window.addEventListener('hashchange', () => route());

  /* ---------- Пошук у шапці ---------- */
  const search = $('#search');
  const hint = $('#search-hint');
  const header = $('.header');
  search.addEventListener('input', () => {
    const q = search.value.trim();
    if (views.home.hidden) { location.hash = '#/'; }
    renderGroups(q);
    hint.hidden = !q;
    if (q) hint.innerHTML = `<a href="#/search/${encodeURIComponent(q)}">Enter — шукати «${esc(q)}» у темах →</a>`;
    const cat = $('#categories');
    if (q && cat.getBoundingClientRect().top > window.innerHeight * .5) cat.scrollIntoView({ block: 'start' });
  });
  $('#searchform').addEventListener('submit', e => {
    e.preventDefault();
    const q = search.value.trim();
    if (!q) return;
    hint.hidden = true;
    location.hash = `#/search/${encodeURIComponent(q)}`;
  });
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape' && search.value) { search.value = ''; search.dispatchEvent(new Event('input')); }
  });
  $('#search-toggle').addEventListener('click', e => {
    const open = !header.classList.contains('search-open');
    header.classList.toggle('search-open', open);
    e.currentTarget.setAttribute('aria-expanded', open);
    if (open) search.focus();
  });

  /* ---------- Діалог ---------- */
  const overlay = $('#overlay');
  const modalBody = $('#modal-body');
  let lastFocus = null;

  function openModal(eyebrow, title, html, focusSel) {
    if (overlay.hidden) lastFocus = document.activeElement;
    $('#modaleyebrow').textContent = eyebrow;
    $('#modaltitle').textContent = title;
    modalBody.innerHTML = html;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    ($(focusSel || '#close', overlay) || $('#close')).focus();
  }
  function closeModal(restore = true) {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
    if (restore && lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  overlay.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const f = $$('a[href], button:not([disabled]), input:not([disabled]), select, textarea:not([disabled])', $('#modal')).filter(el => el.offsetParent !== null);
    const first = f[0], last = f.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeModal(); });
  $('#close').addEventListener('click', () => closeModal());

  /* ---------- Навігатор звернень ---------- */
  function navigatorList() {
    openModal('Навігатор звернень', 'Що трапилося?', `
      <p class="modalintro">Оберіть тип звернення — покажемо, куди його подати і які докази потрібні.</p>
      ${D.ROUTES.map(r => `<button class="route" type="button" data-route="${r.key}"><span class="routeicon" aria-hidden="true">${r.icon}</span><span><b>${esc(r.title)}</b><small>${esc(r.short)}</small></span><span class="arrow" aria-hidden="true">→</span></button>`).join('')}
      <div class="route-note">Демо: маршрути й вимоги — приклад для обговорення дизайну, а не чинні правила проєкту.</div>`);
  }
  function navigatorRoute(key) {
    const r = D.ROUTES.find(x => x.key === key);
    const actions = r.actions.map(a => {
      const cls = 'btn' + (a.primary ? ' btn-primary' : '');
      if (a.disabled) return `<button class="${cls}" type="button" disabled>${esc(a.label)} · вимкнено в демо</button>`;
      if (a.compose) return `<button class="${cls}" type="button" data-compose="${a.compose.section}" data-template="${a.compose.template}">${esc(a.label)}</button>`;
      if (a.topic) return `<a class="${cls}" href="#/topic/${a.topic}" data-close>${esc(a.label)} →</a>`;
      return `<a class="${cls}" href="#/section/${a.section}" data-close>${esc(a.label)} →</a>`;
    }).join('');
    openModal('Навігатор звернень', r.title, `
      <button class="back" type="button" data-back>← Усі типи звернень</button>
      <div class="dest"><div class="lbl">Куди подавати</div><strong>${esc(r.where)}</strong><p>${esc(r.whereNote)}</p></div>
      <div class="facts">
        <div><h3>Термін</h3><p class="plain">${esc(r.deadline)}</p></div>
        <div><h3>Що додати</h3><ul>${r.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>
      </div>
      ${r.warn ? `<div class="route-note">${esc(r.warn)}</div>` : ''}
      <div class="route-actions">${actions}</div>`, '#modaltitle');
  }

  /* ---------- Створення теми (лише в пам'яті вкладки) ---------- */
  let pendingFiles = [];
  function openComposer(slug, templateKey) {
    const tpl = templateKey ? D.TEMPLATES[templateKey] : null;
    // Лише розділи, де поточна роль може створювати теми
    if (isBanned()) { toast('Доступ до форуму обмежено баном — створювати теми не можна.'); return; }
    const mute = activeOf(state.userId, 'mute');
    if (mute) { toast(`У вас активний мут до ${fmtTs(mute.until)} — створювати теми не можна.`); return; }
    const writable = ROWS.filter(canCreateIn);
    if (!writable.length) { toast('Немає розділів, де ви можете створити тему.'); return; }
    const sel = canCreateIn(rowBy(slug)) ? slug : (writable.find(r => r.slug === 'tech') || writable[0]).slug;
    const staff = canModerate();
    pendingFiles = [];
    openModal('Нова тема', 'Створити тему', `
      <form id="composer" class="composer" novalidate>
        <div class="field">
          <label for="c-section">Розділ</label>
          <select id="c-section">${writable.map(r => `<option value="${r.slug}"${r.slug === sel ? ' selected' : ''}>${esc(r.group.title)} › ${esc(r.name)}${r.visibility !== 'public' ? ` (${VIS[r.visibility]})` : ''}</option>`).join('')}</select>
        </div>
        ${staff ? `
        <fieldset class="field">
          <legend>Тип теми</legend>
          <label class="choice"><input type="radio" name="c-access" value="discussion" checked><span><b>Обговорення</b><small>Відповідають гравці й команда</small></span></label>
          <label class="choice"><input type="radio" name="c-access" value="info"><span><b>Інформаційна тема</b><small>Гравці читають, публікує лише команда</small></span></label>
        </fieldset>
        <fieldset class="field">
          <legend>Налаштування модерації</legend>
          <label class="check"><input type="checkbox" id="c-pin"> Закріпити тему</label>
          <label class="check"><input type="checkbox" id="c-lock"> Одразу закрити для відповідей</label>
        </fieldset>` : ''}
        <div class="field">
          <label for="c-title">Назва теми</label>
          <input id="c-title" type="text" maxlength="140" value="${esc(tpl?.title || '')}" aria-describedby="c-title-err" autocomplete="off">
          <span class="err" id="c-title-err"></span>
        </div>
        <div class="field">
          <label for="c-text">Текст</label>
          <textarea id="c-text" rows="7" aria-describedby="c-text-err">${esc(tpl?.text || '')}</textarea>
          <span class="err" id="c-text-err"></span>
        </div>
        <div class="field">
          <label for="c-files">Зображення <span class="opt">(до 4, лише попередній перегляд)</span></label>
          <input id="c-files" type="file" accept="image/*" multiple>
          <div class="attachments" id="c-previews"></div>
        </div>
        <input type="hidden" id="c-template" value="${esc(templateKey || '')}">
        <div class="route-note">Автор: ${esc(me().name)} · ${ROLE_NAME[myRole()]}. ${staff ? '' : 'Після публікації назву, розділ і налаштування теми змінює лише модерація; власне повідомлення ви зможете відредагувати. '}Демо: тема з’явиться лише в цій вкладці. Нічого не надсилається.</div>
        <div class="route-actions"><button class="btn btn-primary" type="submit">Опублікувати</button><button class="btn" type="button" data-cancel>Скасувати</button></div>
      </form>`, tpl?.title ? '#c-title' : '#c-section');
  }

  function composerSubmit(form) {
    const title = $('#c-title').value.trim();
    const text = $('#c-text').value.trim();
    const errs = [['#c-title', title.length < 5 ? 'Назва має містити щонайменше 5 символів.' : ''], ['#c-text', text.length < 10 ? 'Опишіть тему детальніше — щонайменше 10 символів.' : '']];
    errs.forEach(([sel, msg]) => { const el = $(sel); el.setAttribute('aria-invalid', !!msg); $(sel + '-err').textContent = msg; });
    const bad = errs.find(([, m]) => m);
    if (bad) { $(bad[0]).focus(); return; }

    const slug = $('#c-section').value;
    if (!canCreateIn(rowBy(slug))) return;
    const tpl = D.TEMPLATES[$('#c-template').value];
    const staff = canModerate();
    // Гравець і хелпер завжди створюють обговорення; тип і налаштування обирають модератор і розробник
    const access = staff ? form.querySelector('[name="c-access"]:checked').value : 'discussion';
    const kind = tpl?.kind || (access === 'info' ? 'guide' : slug === 'tech' ? 'support' : 'discussion');
    const t = {
      id: 'd' + (++state.draftSeq), kind, access, section: slug, sub: tpl && slug === 'org' ? tpl.sub : undefined, draft: true,
      author: authorOf(me()), at: localIso(nowDate()), views: 0, title, text, body: [],
      pinned: staff && $('#c-pin').checked, locked: staff && $('#c-lock').checked,
      attachments: pendingFiles.map(f => ({ kind: 'image', name: f.name, meta: `${Math.max(1, Math.round(f.size / 1024))} КБ · не завантажено`, src: f.url })),
      replies: [], status: D.KINDS[kind].appeal ? 'open' : undefined
    };
    topics.push(t);
    closeModal(false);
    location.hash = `#/topic/${t.id}`;
    toast('Тему створено лише в цій вкладці. Нічого не надіслано.');
  }

  function composerFiles(input) {
    const files = [...input.files].filter(f => f.type.startsWith('image/')).slice(0, 4 - pendingFiles.length);
    files.forEach(f => pendingFiles.push({ name: f.name, size: f.size, url: URL.createObjectURL(f) }));
    input.value = '';
    $('#c-previews').innerHTML = pendingFiles.map(f => `<figure class="attach"><img class="thumb" src="${f.url}" alt="${esc(f.name)}"><span>${esc(f.name)}</span><small>лише попередній перегляд</small></figure>`).join('');
  }

  /* ---------- Вхід ---------- */
  const loginInfo = accountModal;
  // Перемалювати поточну сторінку після зміни входу, часу чи покарань — без стрибка прокрутки
  function rerender() {
    const y = window.scrollY;
    // Зміни, які користувач зробив сам (видача, зняття, перемотка часу), не повідомляємо як «строк минув»
    lastSig = punSig();
    lastActive = new Set(punishments.filter(p => punStatus(p) === 'active').map(p => p.id));
    route(true);
    window.scrollTo({ top: y, behavior: 'instant' });
  }
  function switchUser(id) {
    state.userId = id;
    state.editing = null; state.replyTo = null; state.punDraft = null;
    rerender();
  }

  /* ---------- Події ---------- */
  document.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('.skip')) { e.preventDefault(); $('#main').focus(); return; }
    if (t.closest('#login')) { loginInfo(); return; }
    const nav = t.closest('[data-open-navigator]');
    if (nav) { navigatorList(); return; }
    const rt = t.closest('[data-route]');
    if (rt) { navigatorRoute(rt.dataset.route); return; }
    if (t.closest('[data-back]')) { navigatorList(); return; }
    // Зміст документа: перейти до розділу без зміни адреси (адреса керує маршрутом)
    const toc = t.closest('[data-toc]');
    if (toc) {
      const sec = document.getElementById(toc.dataset.toc);
      if (sec) {
        sec.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        sec.focus({ preventScroll: true });
        $$('[data-toc]').forEach(b => b.toggleAttribute('aria-current', b === toc));
      }
      return;
    }
    const comp = t.closest('[data-compose]');
    if (comp) {
      const cur = currentTopic();
      openComposer(comp.dataset.compose || (views.section.hidden ? null : lastSection) || cur?.section, comp.dataset.template);
      return;
    }
    if (t.closest('[data-cancel]')) { closeModal(); return; }
    if (t.closest('[data-close]')) { closeModal(false); return; }
    const sub = t.closest('[data-sub]');
    if (sub) { subFilter = sub.dataset.sub || null; renderSection(rowBy(lastSection)); $(`[data-sub="${CSS.escape(sub.dataset.sub)}"]`).focus(); return; }

    // Демо-вхід вкладкою ролі діє на будь-якому екрані: миттєво, без прокрутки й анімації
    const role = t.closest('[data-role]');
    if (role) {
      if (loginAs(role.dataset.role)) switchUser(state.userId);
      $(`[data-role="${myRole()}"]`)?.focus({ preventScroll: true });
      return;
    }
    const lg = t.closest('[data-login]');
    if (lg) { closeModal(false); switchUser(lg.dataset.login); toast(`Демо-вхід: ${me().name} · ${ROLE_NAME[myRole()]}.`); return; }
    if (t.closest('[data-account]')) { accountModal(); return; }
    const clk = t.closest('[data-clock]');
    if (clk) {
      const v = clk.dataset.clock;
      state.clockOffset = v === 'reset' ? 0 : state.clockOffset + +v * 60000;
      const ended = punishments.filter(p => lastActive.has(p.id) && punStatus(p) === 'expired');
      rerender();
      ($(`[data-clock="${v}"]`) || $('[data-clock]'))?.focus({ preventScroll: true });
      toast(v === 'reset' ? 'Демо-час скинуто до реального.'
        : `Демо-час: ${fmtTs(now())}.${ended.length ? ` Строк минув: ${ended.map(p => `${PTYPE[p.type].toLowerCase()} ${userBy(p.userId).name}`).join(', ')} — доступ відновлено.` : ''}`);
      return;
    }
    if (t.closest('[data-log-reset]')) { state.logF = { staff: '', type: '', date: '', q: '' }; renderLog(); $('#lf-staff').focus(); return; }
    if (t.closest('[data-restore-vis]')) {
      const r = rowBy($('#secform').dataset.slug);
      const prev = r.visHistory.at(-1);
      if (!prev || !canManage(r) || (prev === 'dev' && !isDev())) return;
      const was = r.visibility;
      r.visibility = r.visHistory.pop();
      logAdd({ type: 'section.restore', target: { kind: 'section', id: r.slug, label: r.name }, section: r.slug, before: VIS[was], after: VIS[r.visibility] });
      toast(`Видимість відновлено: ${VIS[r.visibility]}.`);
      route(true);
      ($('[data-restore-vis]') || $(`[name="s-vis"][value="${r.visibility}"]`)).focus();
      return;
    }

    const topic = currentTopic();
    if (!topic) return;

    // «Відповісти» — відповідь у тему без цитати; «Цитувати» — відповідь конкретній людині
    if (t.closest('[data-reply-top]')) { state.replyTo = null; renderTopic(topic); scrollToEditor(); return; }
    const qb = t.closest('[data-quote]');
    if (qb) {
      const m = messagesOf(topic).find(x => x.id === qb.dataset.quote);
      state.replyTo = { author: m.author.name, text: excerpt(plainOf(m), 110) };
      renderTopic(topic);
      scrollToEditor();
      return;
    }
    if (t.closest('[data-clear-quote]')) { state.replyTo = null; renderTopic(topic); $('#reply-text').focus(); return; }

    // Редагування опублікованого повідомлення
    const eb = t.closest('[data-edit]');
    if (eb) {
      const m = messagesOf(topic).find(x => x.id === eb.dataset.edit);
      state.editing = m.id;
      state.editDraft = sourceOf(m);
      renderTopic(topic);
      const ta = $('#edit-text');
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      return;
    }
    if (t.closest('[data-edit-cancel]')) {
      const id = state.editing;
      state.editing = null;
      renderTopic(topic);
      $(`#msg-${CSS.escape(id)} [data-edit]`)?.focus();
      return;
    }

    // Панель форматування та вкладення
    const fb = t.closest('[data-fmt]');
    if (fb) { applyFmt($('#' + fb.dataset.target), fb.dataset.fmt); return; }
    if (t.closest('[data-attach]')) { $('#reply-files').click(); return; }
    const rm = t.closest('[data-rmfile]');
    if (rm) {
      const list = state.replyFiles[topic.id] || [];
      list.splice(+rm.dataset.rmfile, 1);
      renderTopic(topic);
      ($('[data-rmfile]') || $('[data-attach]')).focus();
      return;
    }

    // Дії модератора
    const btn = t.closest('[data-act]');
    if (btn) {
      const kind = btn.dataset.act;
      const label = act(topic, kind, kind === 'status' ? btn.dataset.status : kind === 'access' ? btn.dataset.access : btn.dataset.id);
      if (!label) return;
      renderTopic(topic);
      refocus(btn);
      announce(label);
      return;
    }
    if (t.closest('[data-undo]')) {
      const label = undo(topic);
      if (!label) return;
      renderTopic(topic);
      const u = $('[data-undo]');
      (u && !u.disabled ? u : $('#mp-title')).focus();
      announce(`Скасовано: ${label}`);
    }
  });

  // Після перемальовування повернути фокус на ту саму кнопку (або на заголовок панелі)
  function refocus(btn) {
    const sel = btn.dataset.act === 'status' ? `[data-act="status"][data-status="${btn.dataset.status}"]`
      : btn.dataset.act === 'access' ? `[data-act="access"][data-access="${btn.dataset.access}"]`
      : btn.closest('.msgactions') ? `#msg-${CSS.escape(btn.dataset.id)} [data-act]`
      : btn.closest('.mp-hide') ? '.mp-hide [data-act]'
      : `.modactions [data-act="${btn.dataset.act}"]`;
    ($(sel) || $('#mp-title')).focus();
  }
  function announce(msg) { toast(msg); }

  // Обгортає виділення розміткою або додає префікс до рядків; текст у полі не губиться
  function applyFmt(ta, kind) {
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const sel = v.slice(s, e);
    let insert, selFrom, selTo;
    const wrap = { bold: '**', italic: '*', underline: '__' }[kind];
    if (wrap) {
      const inner = sel || 'текст';
      insert = wrap + inner + wrap;
      selFrom = s + wrap.length; selTo = selFrom + inner.length;
      ta.setRangeText(insert, s, e);
    } else if (kind === 'link') {
      const label = sel || 'текст посилання';
      insert = `[${label}](https://)`;
      ta.setRangeText(insert, s, e);
      selFrom = s + label.length + 3; selTo = selFrom + 8; // виділити «https://», щоб одразу вставити адресу
    } else {
      // Список або цитата: префікс для кожного виділеного рядка
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const block = v.slice(lineStart, e) || '';
      const prefix = kind === 'list' ? '- ' : '> ';
      insert = (block || (kind === 'list' ? 'пункт' : 'цитата')).split('\n').map(l => prefix + l).join('\n');
      ta.setRangeText(insert, lineStart, e);
      selFrom = lineStart; selTo = lineStart + insert.length;
    }
    ta.focus();
    ta.setSelectionRange(selFrom, selTo);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  document.addEventListener('input', e => {
    const topic = currentTopic();
    if (e.target.id === 'reply-text' && topic) state.drafts[topic.id] = e.target.value;
    if (e.target.id === 'edit-text') state.editDraft = e.target.value;
    if ((e.target.id === 'reply-text' || e.target.id === 'edit-text') && e.target.getAttribute('aria-invalid') === 'true') {
      e.target.removeAttribute('aria-invalid');
      $(e.target.id === 'reply-text' ? '#reply-err' : '#edit-err').textContent = '';
    }
  });

  // Форма покарання: тип і строк оновлюють підказку про закінчення; причина не губиться
  document.addEventListener('change', e => {
    const d = state.punDraft;
    if (d && (e.target.name === 'pf-type' || e.target.id === 'pf-dur')) {
      d.reason = $('#pf-reason').value;
      if (e.target.name === 'pf-type') d.type = e.target.value; else d.dur = +e.target.value;
      renderUser(userBy(d.userId));
      (e.target.name === 'pf-type' ? $(`[name="pf-type"][value="${d.type}"]`) : $('#pf-dur')).focus();
    }
    if (e.target.id === 'people-f') { state.peopleF = e.target.value; renderPeople(); $('#people-f').focus(); }
    if (/^lf-(staff|type|date)$/.test(e.target.id)) { state.logF[e.target.id.slice(3)] = e.target.value; renderLogList(); }
  });
  // Учасники: пошук за ніком і фільтр ролі оновлюють лише список (фокус і курсор лишаються в полі)
  document.addEventListener('input', e => {
    if (e.target.id === 'mem-q') { state.memQ = e.target.value; $('#mem-list').innerHTML = membersListHtml(); }
    if (e.target.id === 'pe-bio' && state.profDraft) { state.profDraft.bio = e.target.value; $('#pe-count').textContent = `${e.target.value.length} / 200`; }
  });
  document.addEventListener('click', e => {
    const mr = e.target.closest('[data-mem-role]');
    if (mr) {
      state.memRole = mr.dataset.memRole;
      $$('[data-mem-role]').forEach(b => b.setAttribute('aria-pressed', b === mr));
      $('#mem-list').innerHTML = membersListHtml();
      return;
    }
    if (e.target.closest('[data-photo-clear]') && state.profDraft) {
      state.profDraft.photo = null;
      renderUser(me());
      $('#pe-file').focus();
    }
  });
  // Профіль: колір і фото одразу видно в попередньому перегляді; зберігається лише кнопкою
  document.addEventListener('change', e => {
    const d = state.profDraft;
    if (!d || d.userId !== state.userId) return;
    if (e.target.name === 'pe-tone') {
      d.tone = e.target.value === '' ? null : +e.target.value;
      $('#pe-preview').innerHTML = avatar({ ...me(), tone: d.tone, photo: d.photo }, 'xl');
    }
    if (e.target.id === 'pe-file') {
      const f = [...e.target.files].find(x => x.type.startsWith('image/'));
      if (!f) return;
      d.photo = URL.createObjectURL(f);
      renderUser(me());
      $('#pe-file').focus();
    }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'people-q') {
      state.peopleQ = e.target.value;
      const pos = e.target.selectionStart;
      renderPeople();
      const q = $('#people-q'); q.focus(); q.setSelectionRange(pos, pos);
    }
    if (e.target.id === 'lf-q') { state.logF.q = e.target.value; renderLogList(); }
    if (e.target.id === 'pf-reason' && state.punDraft) {
      state.punDraft.reason = e.target.value;
      if (e.target.getAttribute('aria-invalid') === 'true') { e.target.removeAttribute('aria-invalid'); $('#pf-err').textContent = ''; }
    }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'mp-reply') {
      const topic = currentTopic();
      state.selReply[topic.id] = e.target.value;
      renderTopic(topic);
      $('#mp-reply').focus();
    }
  });

  document.addEventListener('submit', e => {
    if (e.target.id === 'secform') { e.preventDefault(); saveSection(e.target); return; }
    // Покарання: видача, дострокове зняття, зміна ролі — кожна дія перевіряє права й пише журнал
    if (e.target.id === 'punform') {
      e.preventDefault();
      const u = userBy(e.target.dataset.user);
      const d = state.punDraft;
      d.reason = $('#pf-reason').value.replace(/\s+/g, ' ').trim();
      const err = issuePunishment(u, d.type, +d.dur, d.reason);
      if (err) { $('#pf-err').textContent = err; $('#pf-reason').setAttribute('aria-invalid', 'true'); $('#pf-reason').focus(); return; }
      rerender();
      $('#ph-title')?.focus();
      return;
    }
    if (e.target.classList.contains('liftform')) {
      e.preventDefault();
      const p = punishments.find(x => x.id === +e.target.dataset.pun);
      const input = e.target.querySelector('input');
      const err = liftPunishment(p, input.value.replace(/\s+/g, ' ').trim());
      if (err) { $(`#lift-err-${p.id}`).textContent = err; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      rerender();
      $('#ph-title')?.focus();
      return;
    }
    if (e.target.id === 'memform') { e.preventDefault(); return; }
    if (e.target.id === 'profileform') {
      e.preventDefault();
      const d = state.profDraft, u = me();
      if (!d || d.userId !== u.id) return; // редагувати можна лише власний профіль
      Object.assign(u, { tone: d.tone ?? undefined, photo: d.photo || undefined, bio: d.bio.replace(/\s+/g, ' ').trim().slice(0, 200) });
      if (u.tone === undefined) delete u.tone;
      touch('Оновлено профіль', `#/user/${u.id}`);
      state.profDraft = null;
      rerender();
      $('#pe-title')?.focus();
      toast('Профіль оновлено лише в цій вкладці. Нічого не надіслано.');
      return;
    }
    if (e.target.id === 'roleform') {
      e.preventDefault();
      const u = userBy(e.target.dataset.user);
      if (changeRole(u, $('#rf-role').value, $('#rf-reason').value.trim())) { rerender(); $('#rf-role').focus(); }
      return;
    }
    if (e.target.id === 'mp-rename' || e.target.id === 'mp-move') {
      e.preventDefault();
      const topic = currentTopic();
      const rename = e.target.id === 'mp-rename';
      const field = rename ? $('#mp-title-input') : $('#mp-section');
      const err = rename ? $('#mp-title-err') : $('#mp-move-err');
      const value = field.value.replace(/\s+/g, ' ').trim();
      let msg = '';
      if (rename && value.length < 5) msg = 'Назва має містити щонайменше 5 символів.';
      else if (rename && value === topic.title) msg = 'Назва не змінилася.';
      else if (!rename && value === topic.section) msg = 'Тема вже в цьому розділі.';
      if (msg) { err.textContent = msg; field.setAttribute('aria-invalid', 'true'); field.focus(); return; }
      const label = act(topic, rename ? 'rename' : 'move', value);
      renderTopic(topic);
      $(rename ? '#mp-title-input' : '#mp-section').focus();
      announce(label);
      return;
    }
    if (e.target.id === 'composer') { e.preventDefault(); composerSubmit(e.target); }
    if (e.target.id === 'replyform') {
      e.preventDefault();
      const topic = currentTopic();
      const ta = $('#reply-text');
      const text = ta.value.trim();
      if (!topic || !canPost(topic)) return;
      if (!text) { ta.setAttribute('aria-invalid', 'true'); $('#reply-err').textContent = 'Напишіть текст відповіді.'; ta.focus(); return; }
      const files = state.replyFiles[topic.id] || [];
      const reply = {
        type: 'post', id: `${topic.id}-r${++replySeq}`, author: authorOf(me()), at: localIso(nowDate()), text, local: true,
        attachments: files.length ? files.map(f => ({ kind: 'image', name: f.name, meta: 'лише попередній перегляд', src: f.url })) : undefined
      };
      if (state.replyTo) reply.quote = { ...state.replyTo };
      topic.replies.push(reply);
      state.replyTo = null;
      state.drafts[topic.id] = '';
      state.replyFiles[topic.id] = [];
      renderTopic(topic);
      const el = $(`#msg-${CSS.escape(reply.id)}`);
      el.scrollIntoView({ block: 'center' });
      el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
      toast('Відповідь додано лише на цій сторінці. Нічого не надіслано.');
    }
    if (e.target.id === 'editform') {
      e.preventDefault();
      const topic = currentTopic();
      const id = e.target.dataset.id;
      const ta = $('#edit-text');
      const text = ta.value.trim();
      if (!text) { ta.setAttribute('aria-invalid', 'true'); $('#edit-err').textContent = 'Повідомлення не може бути порожнім.'; ta.focus(); return; }
      const m = messagesOf(topic).find(x => x.id === id);
      if (!canEdit(topic, m)) { state.editing = null; renderTopic(topic); toast('Редагування недоступне для вашої ролі або під час муту.'); return; }
      if (text !== sourceOf(m).trim()) {
        // Правки модератора й розробника йдуть в історію, журнал і скасовуються; решта редагує лише своє
        if (canModerate()) act(topic, 'edit', { id, text });
        else setContent(topic, id, { text, body: undefined, edited: localIso(nowDate()) });
        const hiddenMsg = () => !!topic.replies.find(r => r.id === id)?.hidden && !canModerate();
        touch(`Редагування повідомлення в темі «${excerpt(topic.title, 60)}»`, `#/topic/${topic.id}?m=${id}`, () => seeTopic(topic) && !hiddenMsg());
      }
      state.editing = null;
      renderTopic(topic);
      $(`#msg-${CSS.escape(id)} [data-edit]`)?.focus();
      toast('Зміни збережено лише на цій сторінці.');
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id !== 'reply-files') return;
    const topic = currentTopic();
    const list = (state.replyFiles[topic.id] ||= []);
    [...e.target.files].filter(f => f.type.startsWith('image/')).slice(0, 4 - list.length)
      .forEach(f => list.push({ name: f.name, url: URL.createObjectURL(f) }));
    renderTopic(topic);
    $('[data-attach]').focus();
  });
  document.addEventListener('change', e => { if (e.target.id === 'c-files') composerFiles(e.target); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) closeModal();
    // «/» — швидкий перехід до пошуку, як підказано в полі
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && overlay.hidden) { e.preventDefault(); $('#search').focus(); }
    // Назва теми однорядкова: Enter зберігає, а не переносить рядок
    if (e.key === 'Enter' && e.target.id === 'mp-title-input') { e.preventDefault(); $('#mp-rename').requestSubmit(); }
    // Швидкі клавіші форматування в полях повідомлень
    if ((e.ctrlKey || e.metaKey) && e.target.classList?.contains('fmt-target')) {
      const k = { KeyB: 'bold', KeyI: 'italic', KeyU: 'underline' }[e.code]; // code — працює й в українській розкладці
      if (k) { e.preventDefault(); applyFmt(e.target, k); }
    }
  });

  /* ---------- Автоматичне закінчення покарань ---------- */
  // Стан покарань рахується з часу; щойно якесь змінилося (минув строк) — перемальовуємо сторінку
  const punSig = () => punishments.map(p => p.id + punStatus(p)).join();
  let lastSig = punSig();
  let lastActive = new Set(punishments.filter(p => punStatus(p) === 'active').map(p => p.id));
  setInterval(() => {
    const sig = punSig();
    if (sig === lastSig) return;
    const ended = punishments.filter(p => lastActive.has(p.id) && punStatus(p) === 'expired');
    lastSig = sig;
    lastActive = new Set(punishments.filter(p => punStatus(p) === 'active').map(p => p.id));
    if (!ended.length) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (!typing && overlay.hidden) rerender();
    const mine = ended.some(p => p.userId === state.userId);
    toast(mine ? 'Строк вашого покарання минув — доступ відновлено автоматично.'
      : `Строк минув: ${ended.map(p => `${PTYPE[p.type].toLowerCase()} ${userBy(p.userId).name}`).join(', ')}. Доступ відновлено.`);
  }, 5000);

  /* ---------- Старт ---------- */
  route();
})();
