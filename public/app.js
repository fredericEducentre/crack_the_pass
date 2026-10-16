'use strict';

(() => {
  const app = document.getElementById('app');
  const nav = document.getElementById('nav');

  const state = {
    user: null,
    config: { levels: [] },
    progress: [],
    offset: 0, // serverTime - clientTime, pour que le chrono suive l'horloge du serveur
  };

  // Choses à nettoyer (timers...) quand l'utilisateur quitte la vue courante.
  let cleanups = [];
  const onLeave = (fn) => cleanups.push(fn);
  const leave = () => {
    cleanups.forEach((fn) => fn());
    cleanups = [];
  };

  // ------------------------------------------------------------ helpers ---
  // Mini helper hyperscript. Le texte est toujours ajouté comme nœud texte, jamais
  // comme HTML, pour que les pseudos et messages serveur ne puissent pas injecter de balises.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // ------------------------------------------------------- styles (Tailwind) ---
  // Le site entier est stylé avec des classes utilitaires Tailwind (chargé via CDN dans
  // index.html, voir tailwind.config pour les couleurs/animations du thème). Ces petites
  // fonctions évitent de répéter de longues chaînes de classes partout dans le fichier.
  const H1 = 'text-[clamp(1.5rem,4vw,2rem)] tracking-[-0.01em] leading-[1.2] mb-2 font-bold';
  const H2 = 'text-[1.1rem] leading-[1.2] mb-2 font-bold';
  const CARD = (extra = '') => `bg-surface border border-border rounded-2xl p-[18px] sm:p-7 ${extra}`.trim();
  const CODE = (extra = '') => `font-mono text-ink bg-bg px-1.5 py-px rounded-[5px] ${extra}`.trim();
  const INPUT = 'w-full px-[13px] py-[11px] rounded-[10px] border border-border bg-bg text-ink font-mono text-base focus:border-info focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-info';
  const EMPTY = 'text-center text-muted py-7 px-2';
  const TABLE_WRAP = 'overflow-auto max-h-[480px]';

  function eyebrow(mb = 'mb-2') {
    return `font-mono text-xs font-semibold tracking-[0.14em] uppercase text-accent ${mb}`;
  }

  function actionsClass(mt = 'mt-[22px]', extra = '') {
    return `flex flex-wrap gap-2.5 ${mt} ${extra}`.trim();
  }

  function btn(variant = 'default', size = 'md', extra = '') {
    const base = 'inline-flex items-center justify-center gap-2 rounded-[10px] border font-semibold font-sans ' +
      'no-underline cursor-pointer transition duration-150 active:translate-y-px focus-visible:outline ' +
      'focus-visible:outline-2 focus-visible:outline-info disabled:opacity-45 disabled:cursor-not-allowed disabled:pointer-events-none';
    const variants = {
      default: 'bg-surface2 border-border text-ink hover:border-[#3a527d]',
      primary: 'bg-accent border-accent text-accentink hover:bg-[#5cf5b4] hover:border-[#5cf5b4]',
      ghost: 'bg-transparent border-border text-ink hover:border-[#3a527d]',
      danger: 'bg-transparent border-border text-danger hover:border-danger',
    };
    const sizes = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-[18px] py-2.5 text-[0.95rem]',
      big: 'px-[26px] py-3.5 text-[1.05rem]',
    };
    return `${base} ${variants[variant]} ${sizes[size]} ${extra}`.trim();
  }

  function badge(kind) {
    const base = 'font-mono text-[0.72rem] font-semibold tracking-wider uppercase px-2.5 py-1 rounded-full border';
    const kinds = {
      locked: 'border-border text-muted',
      ready: 'border-info/40 text-info',
      progress: 'border-warn/45 text-warn',
      done: 'border-accent/45 text-accent',
    };
    return `${base} ${kinds[kind]}`;
  }

  // Les "slots" sont les cases qui affichent un caractère (aperçu, saisie, secret révélé).
  // slotBase() ne fixe pas la couleur de bordure : runLevel() la fait varier dynamiquement
  // (focus + position courante) ; slot() fixe la bordure par défaut pour les usages statiques.
  function slotBase(size) {
    const base = 'inline-flex items-center justify-center rounded-[9px] bg-bg border font-mono font-bold';
    const sizes = {
      preview: 'w-[1.9em] h-[2.3em] text-base text-muted',
      normal: 'w-[3.2rem] h-16 text-[1.9rem] text-accent',
      many: 'w-[2.3rem] h-[3.1rem] text-[1.4rem] text-accent ' +
        'max-[420px]:w-[1.95rem] max-[420px]:h-[2.8rem] max-[420px]:text-[1.2rem]',
    };
    return `${base} ${sizes[size]}`;
  }
  const slot = (size) => `${slotBase(size)} border-border`;

  function tabLink(isCurrent) {
    const base = 'px-3.5 py-1.5 rounded-full border font-semibold text-[0.9rem] no-underline';
    return isCurrent ? `${base} bg-accent border-accent text-accentink` : `${base} border-border text-muted hover:text-ink`;
  }

  function th(num = false) {
    return `px-3 py-2.5 border-b border-border font-mono text-[0.7rem] font-semibold tracking-[0.1em] ` +
      `uppercase text-muted whitespace-nowrap ${num ? 'text-right' : 'text-left'}`;
  }
  function td(num = false, extra = '') {
    return `px-3 py-2.5 border-b border-border whitespace-nowrap group-last:border-b-0 ` +
      `${num ? 'text-right font-mono tabular-nums' : 'text-left'} ${extra}`.trim();
  }

  function hexToRgba(hex, alpha) {
    const h2 = hex.replace('#', '');
    const r = parseInt(h2.slice(0, 2), 16);
    const g = parseInt(h2.slice(2, 4), 16);
    const b = parseInt(h2.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Petite pluie de caractères façon Matrix, purement décorative, sur un <canvas>. Ignorée si
  // l'utilisateur préfère moins d'animations ; renvoie une fonction "stop" à appeler en quittant.
  // `widthPx` doit correspondre exactement à la largeur fixée en CSS (classe w-[...]) : comme
  // Tailwind est chargé en JIT à l'exécution (CDN), la classe peut ne pas encore être appliquée
  // juste après l'insertion du <canvas>, donc on ne peut pas se fier à canvas.offsetWidth ici.
  // La hauteur, elle, dépend vraiment de la fenêtre : on la calcule nous-mêmes (même formule
  // que le CSS, `100vh - topOffset`) plutôt que de la mesurer.
  function matrixRain(canvas, widthPx, topOffset) {
    const ctx = canvas.getContext('2d');
    const chars = '01<>[]{}()!@#$%^&*=+-_~/\\|ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const fontSize = 16;
    const fadeColor = hexToRgba('#0a0e14', 0.12);
    const dropColor = '#35f0a0';
    let cols = 0;
    let drops = [];
    let raf = null;
    let lastStep = 0;
    const stepInterval = 110; // ms entre deux descentes d'une rangée : plus grand = plus lent

    function resize() {
      canvas.width = widthPx;
      canvas.height = window.innerHeight - topOffset;
      cols = Math.max(1, Math.floor(canvas.width / fontSize));
      drops = Array.from({ length: cols }, () => Math.random() * -40);
    }
    resize();
    window.addEventListener('resize', resize);

    // La boucle rAF tourne à la vitesse de l'écran (fluide), mais on ne fait avancer
    // la pluie que toutes les `stepInterval` ms, pour qu'elle tombe lentement.
    function tick(now) {
      // getComputedStyle (pas offsetWidth) : fiable même si la classe Tailwind qui masque le
      // canvas sous 1240px n'était pas encore posée au tout premier rendu.
      if (getComputedStyle(canvas).display !== 'none' && now - lastStep >= stepInterval) {
        lastStep = now;
        ctx.fillStyle = fadeColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = dropColor;
        ctx.font = `${fontSize}px monospace`;
        for (let i = 0; i < cols; i++) {
          ctx.fillText(chars[(Math.random() * chars.length) | 0], i * fontSize, drops[i] * fontSize);
          if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
          drops[i]++;
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }

  // Monte la pluie Matrix des deux côtés de l'écran pour la vue courante. Ajoutée au <body>
  // (pas à #app, vidé à chaque rendu) et toujours démontée via onLeave au changement de page.
  // Seulement visible sur grand écran (>= 1240px), là où il y a la place dans les marges.
  function mountMatrixRain() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const RAIN_WIDTH = 90;
    const RAIN_TOP = 57; // sous la barre du haut
    const base = `fixed top-[${RAIN_TOP}px] h-[calc(100vh-${RAIN_TOP}px)] w-[${RAIN_WIDTH}px] ` +
      'pointer-events-none z-[1] opacity-50 hidden min-[1240px]:block';
    const rainLeft = h('canvas', { class: `${base} left-0`, 'aria-hidden': 'true' });
    const rainRight = h('canvas', { class: `${base} right-0`, 'aria-hidden': 'true' });
    document.body.append(rainLeft, rainRight);
    const stopLeft = matrixRain(rainLeft, RAIN_WIDTH, RAIN_TOP);
    const stopRight = matrixRain(rainRight, RAIN_WIDTH, RAIN_TOP);
    onLeave(() => {
      stopLeft();
      stopRight();
      rainLeft.remove();
      rainRight.remove();
    });
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* corps vide */ }
    if (res.status === 401 && state.user) {
      state.user = null;
      route();
    }
    if (!res.ok) {
      const err = new Error(data.error || `Échec de la requête (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  function fmtDuration(ms) {
    ms = Math.max(0, Math.round(ms));
    const h_ = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    return (h_ ? `${h_}:${pad(m)}` : pad(m)) + `:${pad(s)}.${pad(milli, 3)}`;
  }

  // "14:03:22" pour aujourd'hui, "16 oct., 14:03:22" pour un autre jour.
  function fmtClock(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}, ${time}`;
  }

  const compact = new Intl.NumberFormat('fr', { notation: 'compact', maximumFractionDigits: 1 });

  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

  function humanTime(sec) {
    if (sec < 0.001) return 'instantanément';
    if (sec < 1) return "moins d'une seconde";
    if (sec < 60) return plural(Math.round(sec), 'seconde');
    if (sec < 3600) return plural(Math.round(sec / 60), 'minute');
    if (sec < 86400) return plural(Math.round(sec / 3600), 'heure');
    if (sec < 86400 * 365) return plural(Math.round(sec / 86400), 'jour');
    const years = sec / (86400 * 365);
    if (years >= 1.4e10) return "plus que l'âge de l'univers";
    return years < 1000 ? plural(Math.round(years), 'an') : `${compact.format(years)} ans`;
  }

  const GUESS_RATE = 1e10; // essais/seconde utilisés dans les estimations (attaque hors ligne rapide sur un hash faible)

  // Le jeu de caractères complet du clavier (ASCII imprimable '!' à '~'), pour le décrire joliment.
  const KEYBOARD_CHARSET = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join('');

  function describeCharset(cs) {
    if (cs === '0123456789') return 'un chiffre de 0 à 9';
    if (cs === 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') return 'une lettre, minuscule (a à z) ou majuscule (A à Z)';
    if (cs === KEYBOARD_CHARSET) return 'n\'importe quel caractère du clavier (lettres, chiffres et symboles)';
    return `un de ces caractères : ${cs}`;
  }

  // Les niveaux sont rangés en catégories (le serveur envoie l'id de catégorie de chaque niveau).
  // L'ordre d'affichage est celui de ce tableau.
  const CATEGORY_ORDER = ['chiffres', 'lettres', 'caracteres'];
  const CATEGORIES = {
    chiffres: { name: 'Chiffres', blurb: 'Uniquement des chiffres.' },
    lettres: { name: 'Lettres', blurb: 'Uniquement des lettres, minuscules et majuscules.' },
    caracteres: { name: 'Caractères', blurb: 'Tout le clavier : lettres, chiffres et symboles.' },
  };
  const categoryName = (id) => (CATEGORIES[id] ? CATEGORIES[id].name : id);
  // Petit mot pour un niveau verrouillé : un seul prérequis ("le niveau 4") ou plusieurs ("les niveaux 4, 8, 13").
  const lockedLabel = (requires) =>
    requires.length > 1 ? `les niveaux ${requires.join(', ')}` : `le niveau ${requires[0]}`;

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  async function loadMe() {
    const d = await api('/me');
    if (!d.user) {
      state.user = null;
      const err = new Error('Veuillez vous connecter.');
      err.status = 401;
      throw err;
    }
    state.user = d.user;
    state.config = d.config;
    state.progress = d.progress;
    state.offset = d.serverNow - Date.now();
  }

  const errorCard = (msg) =>
    h('section', { class: CARD() },
      h('h1', { class: H1 }, 'Oups'),
      h('p', { class: 'mb-4' }, msg),
      h('a', { class: btn('default'), href: '#/levels' }, 'Retour aux niveaux'));

  // ----------------------------------------------------------------- nav ---
  function renderNav(page) {
    if (!state.user) return nav.replaceChildren();
    const link = (href, label, current) =>
      h('a', {
        class: 'px-3 py-1.5 rounded-lg font-semibold text-[0.95rem] no-underline ' +
          (current ? 'text-accent bg-accent/10' : 'text-muted hover:text-ink hover:bg-surface2'),
        href,
      }, label);
    // nav.replaceChildren() est l'API native du DOM : contrairement à notre helper h(), elle ne
    // filtre pas les valeurs null/false (elle les transforme en texte "null"/"false" littéral !),
    // d'où le .filter(Boolean) ci-dessous.
    nav.replaceChildren(...[
      link('#/levels', 'Niveaux', page === 'levels' || page === 'play'),
      link('#/leaderboard', 'Classement', page === 'leaderboard'),
      state.user.isAdmin ? link('#/admin', 'Base de données', page === 'admin') : null,
      h('span', { class: 'font-mono text-sm text-muted px-2' }, state.user.username),
      h('button', {
        class: btn('default', 'sm'),
        onclick: async () => {
          try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
          state.user = null;
          go('#/login');
        },
      }, 'Déconnexion'),
    ].filter(Boolean));
  }

  // ---------------------------------------------------------------- auth ---
  function strengthHint(pw) {
    if (!pw) return null;
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
    const sec = Math.pow(pool, pw.length) / GUESS_RATE;
    const cls = sec < 86400 * 30 ? 'text-danger' : sec < 86400 * 365 * 100 ? 'text-warn' : 'text-accent';
    return { text: humanTime(sec), cls };
  }

  function renderAuth(mode = 'login') {
    leave();
    renderNav(null);
    const isRegister = mode === 'register';

    const err = h('p', { class: 'text-danger min-h-[1.4em] mb-3 text-[0.92rem]', role: 'alert' });
    const username = h('input', {
      id: 'username', type: 'text', name: 'username', required: true, minlength: 3, maxlength: 20,
      autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', class: INPUT,
    });
    const password = h('input', {
      id: 'password', type: 'password', name: 'password', required: true, maxlength: 72,
      minlength: isRegister ? 8 : null, autocomplete: isRegister ? 'new-password' : 'current-password', class: INPUT,
    });
    const DEFAULT_METER_TEXT = 'Choisissez un mot de passe pour votre compte. Vous allez comprendre pourquoi il doit être long.';
    const meter = h('p', { class: 'text-[0.85rem] -mt-1.5 mb-4 min-h-[2.8em] text-muted', 'aria-live': 'polite' }, DEFAULT_METER_TEXT);
    const submit = h('button', { class: btn('primary', 'big', 'w-full'), type: 'submit' }, isRegister ? 'Créer mon compte' : 'Se connecter');

    if (isRegister) {
      password.addEventListener('input', () => {
        const s = strengthHint(password.value);
        if (!s) { meter.textContent = DEFAULT_METER_TEXT; return; }
        meter.replaceChildren(
          'Estimation approximative : un attaquant essayant 10 milliards de combinaisons par seconde mettrait ',
          h('strong', { class: s.cls }, s.text),
          ' pour tester tous les mots de passe de ce type. Les vrais mots et les prénoms tombent bien plus vite.'
        );
      });
    }

    const tab = (m, label) =>
      h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(mode === m),
        class: 'flex-1 py-2 rounded-[7px] font-semibold text-[0.95rem] cursor-pointer ' +
          (mode === m ? 'bg-surface2 text-ink' : 'bg-transparent text-muted'),
        onclick: () => renderAuth(m),
      }, label);

    const form = h('form', {
      class: CARD('max-w-[440px] mx-auto mt-[4vh]'),
      novalidate: false,
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        try {
          await api(isRegister ? '/register' : '/login', {
            method: 'POST',
            body: { username: username.value.trim(), password: password.value },
          });
          await loadMe();
          go('#/levels');
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
      h('p', { class: eyebrow() }, 'Accès élève'),
      h('h1', { class: 'text-[clamp(1.5rem,4vw,2rem)] tracking-[-0.01em] leading-[1.2] mb-1.5 font-bold' },
        isRegister ? 'Rejoindre la classe' : 'Content de vous revoir'),
      h('p', { class: 'text-muted mb-4' }, 'Cassez des mots de passe secrets de 1 à 8 caractères, le plus vite possible.'),
      h('div', { class: 'flex gap-1.5 my-[18px] mb-5 bg-bg p-1 rounded-[10px]', role: 'tablist' }, tab('login', 'Se connecter'), tab('register', "S'inscrire")),
      h('div', { class: 'mb-4' }, h('label', { for: 'username', class: 'block text-[0.85rem] font-semibold text-muted mb-1.5' }, "Nom d'utilisateur"), username),
      h('div', { class: 'mb-4' }, h('label', { for: 'password', class: 'block text-[0.85rem] font-semibold text-muted mb-1.5' }, 'Mot de passe'), password),
      meter,
      err,
      submit
    );

    app.replaceChildren(form);
    username.focus();
  }

  // -------------------------------------------------------------- levels ---
  function slotsPreview(n) {
    return h('div', { class: 'flex gap-1.5', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('span', { class: slot('preview') }, '?')));
  }

  function levelCard(p) {
    let badgeEl, action, best;
    if (!p.unlocked) {
      badgeEl = h('span', { class: badge('locked') }, 'Verrouillé');
      action = h('button', { class: btn('default', 'md', 'opacity-45 cursor-not-allowed'), disabled: true }, `Cassez d'abord ${lockedLabel(p.requires)}`);
    } else if (p.active) {
      badgeEl = h('span', { class: badge('progress') }, 'En cours');
      action = h('a', { class: btn('primary'), href: `#/play/${p.level}` }, 'Reprendre');
    } else if (p.best) {
      badgeEl = h('span', { class: badge('done') }, 'Cassé');
      action = h('a', { class: btn('default'), href: `#/play/${p.level}` }, 'Rejouer');
    } else {
      badgeEl = h('span', { class: badge('ready') }, 'Prêt');
      action = h('a', { class: btn('primary'), href: `#/play/${p.level}` }, 'Démarrer');
    }
    if (p.best) best = h('p', { class: 'font-mono text-[0.9rem] text-accent m-0' }, `Meilleur : ${fmtDuration(p.best.durationMs)} · ${p.best.guesses.toLocaleString('fr-FR')} essais`);

    return h('article', { class: CARD('flex flex-col gap-3' + (p.unlocked ? '' : ' opacity-60')) },
      h('div', { class: 'flex justify-between items-center gap-2' }, h('h2', { class: 'm-0 text-[1.2rem] font-bold' }, `Niveau ${p.level}`), badgeEl),
      slotsPreview(p.length),
      // Explication très courte du nombre de possibilités : choix par caractère ^ longueur.
      h('p', { class: 'text-muted text-[0.9rem] m-0' },
        `${p.length} caractère${p.length > 1 ? 's' : ''} · `,
        p.length > 1 ? [`${p.charset.length}`, h('sup', null, String(p.length)), ' = '] : null,
        h('strong', { class: 'text-ink font-mono font-semibold' }, p.possibilities.toLocaleString('fr-FR')),
        ' possibilités'),
      // Nombre de tentatives (parties lancées) de tous les élèves sur ce niveau, vous compris.
      h('p', { class: 'text-muted text-[0.9rem] m-0' },
        'Tentatives de tous les élèves, vous compris : ',
        h('strong', { class: 'text-ink font-mono font-semibold' }, (p.totalAttempts || 0).toLocaleString('fr-FR'))),
      best,
      h('div', { class: actionsClass('mt-auto', 'pt-1') }, action)
    );
  }

  // Un encart « vous pouvez aussi faire ça via l'API », affiché sur la page des niveaux.
  // Il explique ce qu'est une API, liste les endpoints et donne un script Python
  // tout prêt. Les mêmes endpoints POST fonctionnent pour chaque niveau.
  function apiHowtoBlock() {
    // Squelette Python prêt à copier. On ne donne PAS la solution : la partie 3 est
    // laissée à l'élève. Les caractères et longueurs viennent de la config du serveur :
    // un jeu de caractères par catégorie, puis un niveau = (catégorie, longueur).
    const pyName = (id) => id.toUpperCase();
    const charsets = CATEGORY_ORDER.map((id) => {
      const first = state.progress.find((p) => p.category === id);
      return `${pyName(id).padEnd(10)} = ${JSON.stringify(first.charset)}`;
    });
    const niveaux = state.progress
      .map((p) => `    ${String(p.level).padStart(2)}: (${pyName(p.category)}, ${p.length}),   # ${categoryName(p.category)}`);
    const firstId = state.progress[0].level;
    const lastId = state.progress[state.progress.length - 1].level;
    const py = [
      '# crack.py - communique avec l\'API de Crack the Pass',
      '# Prerequis : installez la bibliotheque "requests" avec  pip install requests',
      'import requests',
      '',
      'BASE     = "http://localhost:3000"   # adresse du serveur du jeu',
      'USERNAME = "ton_pseudo"              # votre identifiant',
      'PASSWORD = "ton_mot_de_passe"        # votre mot de passe',
      `LEVEL    = ${firstId}                         # le niveau a casser : de ${firstId} a ${lastId}`,
      '',
      '# Les caracteres possibles de chaque categorie',
      ...charsets,
      '',
      '# Pour chaque niveau : (caracteres possibles, longueur du secret)',
      'NIVEAUX = {',
      ...niveaux,
      '}',
      'CHARSET, LONGUEUR = NIVEAUX[LEVEL]',
      '',
      '# Une "session" garde le cookie de connexion entre les requetes.',
      'session = requests.Session()',
      '',
      '# 1. Connexion. L\'API renvoie une erreur (code 401) si les identifiants sont faux.',
      'reponse = session.post(f"{BASE}/api/login",',
      '                       json={"username": USERNAME, "password": PASSWORD})',
      'if reponse.status_code != 200:',
      '    print("Connexion refusee :", reponse.json().get("error"))',
      '    exit()',
      '',
      '# 2. Demarrer le chrono du niveau.',
      'session.post(f"{BASE}/api/levels/{LEVEL}/start", json={})',
      '',
      '# 3. Votre code pour cracker le mot de passe ici.',
      '#    Pour tester un essai, envoyez-le a l\'API :',
      '#        reponse = session.post(f"{BASE}/api/levels/{LEVEL}/guess",',
      '#                               json={"guess": essai})',
      '#        data = reponse.json()',
      '#    data vaut {"correct": False, ...} tant que l\'essai est faux.',
      '#    Quand vous trouvez, l\'API repond :',
      '#        {"correct": True, "secret": ..., "guesses": ..., "durationMs": ...}',
      '#    ou "durationMs" est le temps realise, en millisecondes.',
    ].join('\n');

    const endpoint = (method, path, desc) =>
      h('li', { class: 'mb-1.5' }, h('code', { class: CODE('text-[0.86rem]') }, `${method} ${path}`), ' — ', desc);

    return h('details', { class: CARD('mt-5 group') },
      h('summary', { class: 'flex items-center gap-3 cursor-pointer list-none font-semibold [&::-webkit-details-marker]:hidden' },
        h('span', { class: eyebrow('m-0') }, 'Pour aller plus vite'),
        h('span', null, "Vous pouvez aussi jouer via l'API"),
        h('span', { class: 'ml-auto text-muted transition-transform duration-150 group-open:rotate-90', 'aria-hidden': 'true' }, '▸')),

      h('h2', { class: 'mt-6 mb-2 text-[1.05rem] font-bold' }, "C'est quoi, une API ?"),
      h('p', { class: 'text-muted mb-4' },
        'Une API (Application Programming Interface) est une « porte d\'entrée » qu\'un programme ' +
        'ouvre pour que d\'autres programmes lui parlent. Au lieu de cliquer sur des boutons, un ' +
        'logiciel envoie une requête (un petit message) au serveur, et le serveur répond. ' +
        'Ici, chaque action du jeu — se connecter, démarrer un niveau, tenter un mot de passe — ' +
        'est une requête HTTP envoyée à l\'API du serveur.'),
      h('p', { class: 'text-muted mb-4 max-w-[70ch]' },
        'En fait, les boutons de cette page ne font rien d\'autre : quand vous cliquez sur « Essayer », ' +
        'le navigateur envoie une requête à l\'API. Vous pouvez envoyer exactement les mêmes requêtes ' +
        'vous-même, depuis un terminal ou un programme, dans n\'importe quel langage.'),

      h('h2', { class: 'mt-6 mb-2 text-[1.05rem] font-bold' }, 'Les endpoints du jeu'),
      h('p', { class: 'text-muted mb-4 max-w-[70ch]' },
        'Un « endpoint » est une adresse de l\'API pour une action précise. Les quatre ci-dessous ' +
        `fonctionnent pour chaque niveau (de ${firstId} à ${lastId}) : seuls changent le nombre de caractères d'un essai ` +
        '(de 1 à 8) et les caractères autorisés.'),
      h('ul', { class: 'mt-3.5 pl-5 text-muted text-[0.92rem]' },
        endpoint('POST', '/api/login', 'se connecter ; pose votre cookie de session, ou renvoie une erreur 401 si les identifiants sont faux.'),
        endpoint('POST', '/api/levels/:level/start', `démarrer le chrono de ce niveau (:level vaut ${firstId} à ${lastId}).`),
        endpoint('POST', '/api/levels/:level/guess', 'envoyer { guess } ; recevoir { correct } — et le temps réalisé (durationMs) quand c\'est gagné.'),
        endpoint('POST', '/api/levels/:level/giveup', 'abandonner la partie en cours et révéler le mot de passe.')),
      h('p', { class: 'text-muted text-[0.85rem] mb-4' },
        'Un essai doit avoir exactement la longueur du secret et n\'utiliser que les caractères du niveau ' +
        '(un essai qui ne respecte pas ça est refusé avec une erreur). Les écritures doivent être en JSON ' +
        '(Content-Type: application/json), et chaque élève est limité à un nombre sûr d\'essais par seconde.'),

      h('h2', { class: 'mt-6 mb-2 text-[1.05rem] font-bold' }, 'Créer un fichier Python pour parler à l\'API'),
      h('p', { class: 'text-muted mb-4' },
        'Python sait envoyer des requêtes à une API avec la bibliothèque ', h('code', { class: CODE() }, 'requests'),
        '. Voici la recette complète :'),
      h('ol', { class: 'mt-3.5 pl-5 text-muted text-[0.92rem]' },
        h('li', { class: 'mb-1.5' }, 'Installez la bibliothèque : dans un terminal, tapez ', h('code', { class: CODE() }, 'pip install requests'), '.'),
        h('li', { class: 'mb-1.5' }, 'Copiez le code ci-dessous dans un fichier nommé ', h('code', { class: CODE() }, 'crack.py'), '.'),
        h('li', { class: 'mb-1.5' }, 'Remplacez ', h('code', { class: CODE() }, 'ton_pseudo'), ' et ', h('code', { class: CODE() }, 'ton_mot_de_passe'),
          ' par vos identifiants, et choisissez le ', h('code', { class: CODE() }, 'LEVEL'), '.'),
        h('li', { class: 'mb-1.5' }, 'Lancez-le : ', h('code', { class: CODE() }, 'python crack.py'), '.')),
      h('pre', { class: 'mt-4 p-4 bg-bg border border-border rounded-[10px] overflow-x-auto font-mono text-[0.82rem] leading-[1.5] text-ink' },
        h('code', null, py)),
      h('p', { class: 'text-muted text-[0.85rem] mb-4' },
        'Ce squelette se connecte et démarre le niveau ; à vous d\'écrire la partie 3, la boucle qui ' +
        'essaie les mots de passe. Quand votre code trouve le bon, l\'API renvoie le temps réalisé ' +
        '(durationMs). À la main, les niveaux longs sont interminables ; quelques lignes de code les cassent. ' +
        `Au niveau ${lastId} (8 caractères), même un programme n'y arrive pas par cette API : c'est toute la leçon — ` +
        'et un vrai attaquant qui aurait le hash du mot de passe pourrait tenter des milliards de ' +
        'combinaisons par seconde hors ligne.')
    );
  }

  // Un encart statique décrivant le défi bonus : un VRAI compte que l'enseignant crée lui-même
  // (voir scripts/create-admin.js), hors du système de niveaux. Pas de secret, pas de chrono, pas
  // d'entrée dans le classement : juste le formulaire de connexion normal.
  function bonusChallengeBlock() {
    return h('section', { class: CARD('mt-[30px] border-dashed') },
      h('p', { class: eyebrow() }, 'Défi bonus (facultatif)'),
      h('h2', { class: 'mb-2.5 text-[1.1rem] font-bold' }, 'Le compte administrateur'),
      h('p', { class: 'text-muted mb-4' },
        'Votre enseignant a peut-être créé un vrai compte sur ce serveur, par exemple ',
        h('code', { class: CODE() }, 'admin'), ', avec un vrai mot de passe. Essayez de vous y connecter avec le ' +
        'formulaire de connexion habituel (déconnectez-vous d\'abord, puis entrez ce nom ' +
        'd\'utilisateur et un mot de passe à deviner).'),
      h('p', { class: 'text-muted text-[0.85rem]' },
        'Ce n\'est pas un niveau : il n\'y a pas de secret généré par le jeu, pas de chrono, et il ' +
        'n\'apparaît pas dans le classement. Les tentatives de connexion restent limitées comme ' +
        'pour n\'importe quel compte (10 essais ratés toutes les 15 minutes) : même un mot de passe ' +
        'court peut résister longtemps si les connexions sont ainsi limitées.'));
  }

  async function renderLevels() {
    await loadMe();
    renderNav('levels');
    app.replaceChildren(
      h('section', { class: 'mb-6' },
        h('h1', { class: H1 }, 'À quelle vitesse savez-vous casser un mot de passe ?'),
        h('p', { class: 'text-muted max-w-[62ch] mb-4' },
          'Choisissez une catégorie : uniquement des chiffres, uniquement des lettres, ou n\'importe quel caractère. ' +
          'Dans chacune, le secret s\'allonge niveau après niveau. ' +
          'Le chrono démarre quand vous appuyez sur Démarrer et s\'arrête quand vous le trouvez.'),
        h('div', { class: CARD('mt-[18px] max-w-[70ch]') },
          h('h2', { class: 'mb-2 text-[1.1rem] font-bold' }, 'Qu\'est-ce qu\'un caractère ?'),
          h('p', { class: 'mb-2' },
            'Un caractère, c\'est un seul symbole que vous pouvez taper au clavier. Il peut être :'),
          h('ul', { class: 'mb-2.5 pl-5 text-muted' },
            h('li', { class: 'mb-1' }, h('strong', { class: 'text-ink' }, 'une lettre minuscule'), ' : ', h('code', { class: CODE('break-all') }, 'a b c … z')),
            h('li', { class: 'mb-1' }, h('strong', { class: 'text-ink' }, 'une lettre majuscule'), ' : ', h('code', { class: CODE('break-all') }, 'A B C … Z')),
            h('li', { class: 'mb-1' }, h('strong', { class: 'text-ink' }, 'un chiffre'), ' : ', h('code', { class: CODE('break-all') }, '0 1 2 … 9')),
            h('li', { class: 'mb-1' }, h('strong', { class: 'text-ink' }, 'un caractère spécial'), ' : ', h('code', { class: CODE('break-all') }, '! ? # $ % & @ * + - = _ . , ; : / ( ) [ ] { } < > ~ ^ | \\ " \' `'))),
          h('p', { class: 'text-[0.85rem] text-muted' },
            `Dans la catégorie Caractères, cela fait ${KEYBOARD_CHARSET.length} choix possibles pour chaque position du secret. ` +
            'Les emojis et l\'espace ne sont jamais utilisés. Majuscules et minuscules sont deux caractères ' +
            'différents (a ≠ A).'))
      ),
      // replaceChildren n'aplatit pas les tableaux : on déplie les sections avec "...".
      ...CATEGORY_ORDER.map((id) => {
        const levels = state.progress.filter((p) => p.category === id);
        if (!levels.length) return null;
        const choices = levels[0].charset.length;
        return h('section', { class: 'mt-[30px]' },
          h('div', { class: 'mb-3.5' },
            h('h2', { class: 'mb-0.5 text-[1.35rem] text-accent font-bold' }, categoryName(id)),
            h('p', { class: 'text-[0.92rem] text-muted' }, `${CATEGORIES[id].blurb} ${choices} choix par caractère.`)),
          h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-4' }, levels.map(levelCard)));
      }).filter(Boolean),
      bonusChallengeBlock(),
      apiHowtoBlock()
    );
  }

  // ---------------------------------------------------------------- play ---
  async function renderPlay(level) {
    await loadMe();
    renderNav('play');
    const p = state.progress.find((x) => x.level === level);
    if (!p) return app.replaceChildren(errorCard("Ce niveau n'existe pas."));
    if (!p.unlocked) return app.replaceChildren(errorCard(`Cassez d'abord ${lockedLabel(p.requires)} pour débloquer le niveau ${level}.`));
    if (p.active) return runLevel(level, p.active);
    readyScreen(p);
  }

  function readyScreen(p) {
    app.replaceChildren(
      h('section', { class: CARD('text-center max-w-[620px] mx-auto') },
        h('p', { class: eyebrow('mb-4') }, `${categoryName(p.category)} · niveau ${p.level}`),
        h('h1', { class: H1 }, `Un secret de ${p.length} caractère${p.length > 1 ? 's' : ''}`),
        h('div', { class: 'flex gap-1.5 justify-center my-[14px] mb-[18px]', 'aria-hidden': 'true' },
          Array.from({ length: p.length }, () => h('span', { class: slot('preview') }, '?'))),
        h('p', { class: 'text-muted mb-4' }, `Chaque caractère : ${describeCharset(p.charset)}.`),
        h('div', { class: actionsClass('mt-[22px]', 'justify-center') },
          h('button', {
            class: btn('primary', 'big'),
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                const r = await api(`/levels/${p.level}/start`, { method: 'POST' });
                state.offset = r.serverNow - Date.now();
                runLevel(p.level, { startedAt: r.startedAt, guesses: r.guesses });
              } catch (ex) {
                app.replaceChildren(errorCard(ex.message));
              }
            },
          }, 'Démarrer le chrono'),
          h('a', { class: btn('ghost'), href: '#/levels' }, 'Retour')
        )
      )
    );
  }

  function runLevel(level, attempt) {
    // Chaque niveau a sa propre longueur de secret et son propre jeu de caractères.
    const { length, charset, category } = state.progress.find((x) => x.level === level);
    const allowed = new Set(charset);
    const hasUpper = charset !== charset.toLowerCase();
    const sizeKey = length > 5 ? 'many' : 'normal';
    let guesses = attempt.guesses;
    let busy = false;
    let finished = false;

    const timerEl = h('div', { class: 'font-mono font-bold text-[2rem] sm:text-[3rem] tabular-nums text-ink' }, '00:00.000');
    const countEl = h('div', { class: 'font-mono font-bold text-[2rem] sm:text-[3rem] tabular-nums text-info' }, String(guesses));
    const tick = () => { timerEl.textContent = fmtDuration(Date.now() + state.offset - attempt.startedAt); };
    tick();
    const iv = setInterval(tick, 47);
    onLeave(() => clearInterval(iv));

    const input = h('input', {
      class: 'absolute inset-0 w-full h-full opacity-0 border-0 bg-transparent text-base cursor-text',
      type: 'text', maxlength: length, autocomplete: 'off', autocapitalize: 'off',
      autocorrect: 'off', spellcheck: 'false', 'aria-label': `Votre essai : ${length} caractère${length > 1 ? 's' : ''}`,
    });
    const slots = Array.from({ length }, () => h('span', { class: slot(sizeKey) }));
    const slotBoxBase = 'relative inline-flex gap-2.5 mb-[18px] cursor-text' +
      (sizeKey === 'many' ? ' flex-wrap justify-center max-w-full gap-1.5' : '');
    const slotBox = h('div', { class: slotBoxBase, onclick: () => input.focus() }, slots, input);
    const msg = h('p', { class: 'min-h-[1.5em] text-danger text-[0.92rem] mb-2.5', role: 'alert' });
    const historyEl = h('ul', { class: 'list-none p-0 mt-5 flex flex-wrap gap-2 justify-center' });
    const historyTitle = h('p', {
      class: 'mt-[22px] mb-4 font-mono text-[0.7rem] font-semibold tracking-[0.12em] uppercase text-muted',
      hidden: true,
    }, 'Mauvais essais');
    const history = [];

    // Case active : celle de la position courante. Elle n'est mise en valeur (bordure verte)
    // que pendant que le bloc a vraiment le focus, comme un :focus-within.
    const paintSlots = () => {
      const isFocused = document.activeElement === input;
      slots.forEach((s, i) => {
        s.textContent = input.value[i] || '';
        const isActive = i === Math.min(input.value.length, length - 1);
        const highlight = isActive && isFocused ? 'border-accent shadow-[0_0_0_3px_rgba(53,240,160,0.18)]' : 'border-border';
        s.className = `${slotBase(sizeKey)} ${highlight}`;
      });
    };
    input.addEventListener('focus', paintSlots);
    input.addEventListener('blur', paintSlots);
    input.addEventListener('input', () => {
      let v = hasUpper ? input.value : input.value.toLowerCase();
      v = [...v].filter((c) => allowed.has(c)).join('').slice(0, length);
      input.value = v;
      msg.textContent = '';
      paintSlots();
    });

    async function submitGuess(e) {
      e.preventDefault();
      if (busy || finished) return;
      if (input.value.length !== length) {
        msg.textContent = `Tapez exactement ${length} caractère${length > 1 ? 's' : ''}.`;
        return;
      }
      busy = true;
      const guess = input.value;
      try {
        const r = await api(`/levels/${level}/guess`, { method: 'POST', body: { guess } });
        guesses = r.guesses;
        countEl.textContent = guesses.toLocaleString('fr-FR');
        if (r.correct) {
          finished = true;
          clearInterval(iv);
          timerEl.textContent = fmtDuration(r.durationMs);
          return renderSuccess(level, r);
        }
        history.unshift(guess);
        historyEl.replaceChildren(...history.slice(0, 40).map((g) =>
          h('li', {
            class: "font-mono text-[0.9rem] text-muted bg-bg border border-border rounded-lg px-2.5 py-[3px] before:content-['✗_'] before:text-danger",
          }, g)));
        historyTitle.hidden = false;
        slotBox.classList.remove('animate-shake');
        void slotBox.offsetWidth; // relance l'animation
        slotBox.classList.add('animate-shake', 'motion-reduce:animate-none');
      } catch (ex) {
        msg.textContent = ex.message;
      } finally {
        busy = false;
        input.value = '';
        paintSlots();
        input.focus();
      }
    }

    async function giveUp() {
      if (!confirm('Abandonner ce mot de passe ? Vous le verrez, mais cette partie ne comptera pas.')) return;
      try {
        const r = await api(`/levels/${level}/giveup`, { method: 'POST' });
        finished = true;
        clearInterval(iv);
        app.replaceChildren(
          h('section', { class: CARD('text-center') },
            h('p', { class: eyebrow() }, 'Partie abandonnée'),
            h('h1', { class: H1 }, 'Le mot de passe était'),
            h('div', { class: 'flex gap-2.5 justify-center my-[14px] mb-[22px]' + (sizeKey === 'many' ? ' flex-wrap' : '') },
              [...r.secret].map((c) => h('span', { class: `${slotBase(sizeKey)} border-accent` }, c))),
            h('p', { class: 'text-muted mb-4' }, `Vous avez fait ${r.guesses.toLocaleString('fr-FR')} essai${r.guesses === 1 ? '' : 's'}. La prochaine partie utilise un tout nouveau mot de passe.`),
            h('div', { class: actionsClass('mt-[22px]', 'justify-center') },
              h('button', { class: btn('primary'), onclick: () => route() }, 'Réessayer'),
              h('a', { class: btn('ghost'), href: '#/levels' }, 'Retour aux niveaux'))
          )
        );
      } catch (ex) {
        msg.textContent = ex.message;
      }
    }

    app.replaceChildren(
      h('section', { class: CARD('text-center max-w-[620px] mx-auto') },
        h('p', { class: eyebrow('mb-4') }, `${categoryName(category)} · niveau ${level} · ${length} caractère${length > 1 ? 's' : ''}`),
        h('div', { class: 'flex justify-center gap-6 sm:gap-12 my-2 mb-[22px]' },
          h('div', null, h('div', { class: 'font-mono text-[0.7rem] font-semibold tracking-[0.12em] uppercase text-muted' }, 'Temps'), timerEl),
          h('div', null, h('div', { class: 'font-mono text-[0.7rem] font-semibold tracking-[0.12em] uppercase text-muted' }, 'Essais'), countEl)
        ),
        h('form', { onsubmit: submitGuess, autocomplete: 'off' },
          slotBox,
          h('p', { class: 'text-muted text-[0.85rem] mb-2.5' }, `Chaque caractère : ${describeCharset(charset)}`),
          msg,
          h('button', { class: btn('primary', 'big'), type: 'submit' }, 'Essayer')
        ),
        historyTitle,
        historyEl,
        h('div', { class: 'mt-[26px]' }, h('button', { class: btn('danger'), type: 'button', onclick: giveUp }, 'Abandonner'))
      )
    );
    paintSlots();
    input.focus();
  }

  // ---------------------------------------------------------- success view ---
  function renderSuccess(level, r) {
    const current = state.progress.find((x) => x.level === level);
    // Le niveau suivant est celui qui demande celui-ci (tous les niveaux actuels n'ont qu'un seul prérequis).
    const next = state.progress.find((x) => x.requires.includes(level));
    const hasNext = !!next;
    const stat = (label, value) => h('div', { class: 'bg-bg border border-border rounded-xl p-3' },
      h('dt', { class: 'font-mono text-[0.68rem] font-semibold tracking-[0.1em] uppercase text-muted' }, label),
      h('dd', { class: 'mt-1 font-mono font-bold text-[1.15rem] tabular-nums' }, value));
    const sizeKey = r.secret.length > 5 ? 'many' : 'normal';
    app.replaceChildren(
      h('section', { class: CARD('text-center') },
        h('p', { class: eyebrow() }, 'Accès autorisé'),
        h('h1', { class: H1 }, hasNext ? 'Mot de passe cassé !' : `Catégorie ${categoryName(current.category)} terminée. Bravo !`),
        h('div', { class: 'flex gap-2.5 justify-center my-[14px] mb-[22px]' + (sizeKey === 'many' ? ' flex-wrap' : '') },
          [...r.secret].map((c, i) =>
            h('span', {
              class: `${slotBase(sizeKey)} border-accent animate-pop motion-reduce:animate-none`,
              style: i < 4 ? `animation-delay:${i * 80}ms` : '',
            }, c))),
        h('dl', { class: 'grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3 mb-2' },
          stat('Temps', fmtDuration(r.durationMs)),
          stat('Essais', r.guesses.toLocaleString('fr-FR')),
          stat('Rang', r.rank ? `#${r.rank} sur ${r.players}` : '-'),
          stat('Terminé à', fmtClock(r.finishedAt))
        ),
        h('div', { class: actionsClass('mt-[22px]', 'justify-center') },
          hasNext ? h('a', { class: btn('primary'), href: `#/play/${next.level}` }, 'Niveau suivant →')
            : h('a', { class: btn('primary'), href: '#/levels' }, 'Choisir une autre catégorie'),
          h('a', { class: btn('default'), href: `#/leaderboard/${level}` }, 'Voir le classement'),
          h('button', { class: btn('ghost'), onclick: () => route() }, 'Rejouer (nouveau mot de passe)')
        )
      )
    );
  }

  // ------------------------------------------------------------- admin page ---
  // Lecture seule : cette page n'a aucun bouton d'ajout, de modification ou de suppression,
  // et ne fait que lire /api/admin/overview (un GET). Le serveur refuse l'accès à qui n'est
  // pas le compte admin (403), donc un élève qui tape l'URL à la main voit une erreur, pas les données.
  function adminUsersTable(users, filter) {
    const rows = users.filter((u) => u.username.toLowerCase().includes(filter));
    if (!rows.length) return h('p', { class: EMPTY }, 'Aucun compte ne correspond.');
    return h('div', { class: TABLE_WRAP },
      h('table', { class: 'w-full border-collapse text-[0.95rem]' },
        h('thead', null, h('tr', null, h('th', { class: th() }, 'ID'), h('th', { class: th() }, 'Nom d\'utilisateur'), h('th', { class: th() }, 'Créé le'))),
        h('tbody', null, rows.map((u) =>
          h('tr', { class: 'group' },
            h('td', { class: td(true) }, u.id),
            h('td', { class: td() }, u.username),
            h('td', { class: td() }, fmtClock(u.createdAt)))))));
  }

  function adminAttemptsTable(attempts, filter) {
    const rows = attempts.filter((a) => a.username.toLowerCase().includes(filter));
    if (!rows.length) return h('p', { class: EMPTY }, 'Aucune tentative ne correspond.');
    const statusLabel = { active: 'en cours', done: 'cassé', abandoned: 'abandonné' };
    return h('div', { class: TABLE_WRAP },
      h('table', { class: 'w-full border-collapse text-[0.95rem]' },
        h('thead', null, h('tr', null,
          h('th', { class: th() }, 'ID'), h('th', { class: th() }, 'Élève'), h('th', { class: th() }, 'Niveau'), h('th', { class: th() }, 'Secret'),
          h('th', { class: th() }, 'Statut'), h('th', { class: th(true) }, 'Essais'), h('th', { class: th() }, 'Démarré'),
          h('th', { class: th() }, 'Terminé'), h('th', { class: th(true) }, 'Temps'))),
        h('tbody', null, rows.map((a) =>
          h('tr', { class: 'group' },
            h('td', { class: td(true) }, a.id),
            h('td', { class: td() }, a.username),
            h('td', { class: td(true) }, a.level),
            h('td', { class: td() }, h('code', { class: CODE() }, a.secret)),
            h('td', { class: td() }, statusLabel[a.status] || a.status),
            h('td', { class: td(true) }, a.guesses.toLocaleString('fr-FR')),
            h('td', { class: td() }, fmtClock(a.startedAt)),
            h('td', { class: td() }, a.finishedAt ? fmtClock(a.finishedAt) : '—'),
            h('td', { class: td(true) }, a.durationMs != null ? fmtDuration(a.durationMs) : '—'))))));
  }

  async function renderAdmin() {
    renderNav('admin');
    if (!state.user.isAdmin) return app.replaceChildren(errorCard('Cette page est réservée au compte administrateur.'));

    mountMatrixRain();

    const search = h('input', { type: 'text', placeholder: 'Filtrer par élève…', class: `${INPUT} max-w-[320px]` });
    const usersBox = h('div', { class: CARD() }, h('p', { class: EMPTY }, 'Chargement…'));
    const attemptsBox = h('div', { class: CARD() }, h('p', { class: EMPTY }, 'Chargement…'));

    app.replaceChildren(
      h('section', null,
        h('p', { class: eyebrow() }, 'Lecture seule'),
        h('h1', { class: H1 }, 'Base de données'),
        h('p', { class: 'text-muted mb-4' },
          'Tous les comptes et toutes les tentatives, tous élèves confondus. Cette page ne permet ' +
          'ni d\'ajouter, ni de modifier, ni de supprimer quoi que ce soit — uniquement de lire.'),
        h('div', { class: 'mb-4' }, search),
        h('h2', { class: `${H2} mt-2.5` }, `Comptes`),
        usersBox,
        h('h2', { class: `${H2} mt-2.5` }, 'Tentatives'),
        attemptsBox)
    );

    let data;
    try {
      data = await api('/admin/overview');
    } catch (ex) {
      usersBox.replaceChildren(h('p', { class: EMPTY }, ex.message));
      attemptsBox.replaceChildren();
      return;
    }

    const paint = () => {
      const filter = search.value.trim().toLowerCase();
      usersBox.replaceChildren(adminUsersTable(data.users, filter));
      attemptsBox.replaceChildren(adminAttemptsTable(data.attempts, filter));
    };
    search.addEventListener('input', paint);
    paint();
  }

  // --------------------------------------------------------- leaderboard ---
  function rankCell(n, isMe) {
    const medal = n === 1 ? 'text-[#ffd34d]' : n === 2 ? 'text-[#cfd8e6]' : n === 3 ? 'text-[#e0955a]' : '';
    const highlight = isMe ? 'bg-accent/[0.08] shadow-[inset_3px_0_0_#35f0a0]' : '';
    return h('td', { class: `${td(false)} font-mono font-bold text-[0.95rem] w-[3.2em] ${medal} ${highlight}`.trim() }, `#${n}`);
  }

  function boardTable(data) {
    if (!data.rows.length) {
      return h('p', { class: EMPTY }, data.which === 'overall'
        ? "Personne n'a encore cassé de niveau. Soyez le premier !"
        : "Personne n'a encore cassé ce niveau. Soyez le premier !");
    }
    const bg = (isMe) => (isMe ? ' bg-accent/[0.08]' : '');
    let head, body;
    if (data.which === 'overall') {
      head = ['#', 'Élève', 'Niveaux', 'Temps total', 'Dernière réussite'];
      body = data.rows.map((r) =>
        h('tr', { class: 'group' },
          rankCell(r.rank, r.isMe),
          h('td', { class: td(false) + bg(r.isMe) }, r.username + (r.isMe ? ' (vous)' : '')),
          h('td', { class: td(true) + bg(r.isMe) }, `${r.levelsDone}/${data.totalLevels}`),
          h('td', { class: td(true) + bg(r.isMe) }, fmtDuration(r.totalMs)),
          h('td', { class: td(true) + bg(r.isMe) }, fmtClock(r.lastFinished))));
    } else {
      head = ['#', 'Élève', 'Temps', 'Terminé à', 'Essais'];
      body = data.rows.map((r) =>
        h('tr', { class: 'group' },
          rankCell(r.rank, r.isMe),
          h('td', { class: td(false) + bg(r.isMe) }, r.username + (r.isMe ? ' (vous)' : '')),
          h('td', { class: td(true) + bg(r.isMe) }, fmtDuration(r.durationMs)),
          h('td', { class: td(true) + bg(r.isMe) }, fmtClock(r.finishedAt)),
          h('td', { class: td(true) + bg(r.isMe) }, r.guesses.toLocaleString('fr-FR'))));
    }
    return h('div', { class: 'overflow-x-auto' },
      h('table', { class: 'w-full border-collapse text-[0.95rem]' },
        h('thead', null, h('tr', null, head.map((t, i) => h('th', { class: th(i >= 2) }, t)))),
        h('tbody', null, body)));
  }

  async function renderLeaderboard(which) {
    renderNav('leaderboard');
    const valid = ['overall', ...state.config.levels.map(String)];
    if (!valid.includes(which)) which = 'overall';

    // Un onglet « Général », puis un groupe par catégorie avec un onglet par niveau (numéroté par longueur).
    const tabs = [
      h('a', { href: '#/leaderboard/overall', class: tabLink(which === 'overall') }, 'Général'),
      ...CATEGORY_ORDER.map((id) => {
        const levels = state.progress.filter((p) => p.category === id);
        if (!levels.length) return null;
        return h('div', { class: 'flex items-center gap-1.5 flex-wrap' },
          h('span', { class: 'font-mono text-[0.7rem] font-semibold tracking-[0.1em] uppercase text-muted pl-2.5' }, categoryName(id)),
          levels.map((p) =>
            h('a', {
              href: `#/leaderboard/${p.level}`,
              class: tabLink(String(p.level) === which),
              title: `Niveau ${p.level} : ${p.length} caractère${p.length > 1 ? 's' : ''}`,
            }, `${p.length} car.`)));
      }),
    ];
    const container = h('div', { class: CARD() }, h('p', { class: EMPTY }, 'Chargement…'));
    const note = h('p', { class: 'mt-3.5 mx-0.5 text-muted text-[0.82rem]' },
      which === 'overall'
        ? 'Classé par niveaux cassés, puis par total de vos meilleurs temps. En cas d\'égalité, le premier à avoir terminé passe devant.'
        : 'Chaque élève apparaît une fois avec sa meilleure partie. Classé par temps le plus court ; en cas d\'égalité, le premier à avoir terminé passe devant.');

    app.replaceChildren(
      h('section', null,
        h('p', { class: eyebrow() }, 'Panthéon'),
        h('h1', { class: H1 }, 'Classement'),
        h('div', { class: 'flex gap-1.5 flex-wrap my-3.5 mb-4' }, tabs),
        container, note)
    );

    const load = async () => container.replaceChildren(boardTable(await api(`/leaderboard/${which}`)));
    await load();
    const iv = setInterval(() => load().catch(() => {}), 8000);
    onLeave(() => clearInterval(iv));
  }

  // -------------------------------------------------------------- router ---
  async function route() {
    leave();
    const [, page, arg] = (location.hash || '#/levels').split('/');
    if (!state.user) return renderAuth(page === 'register' ? 'register' : 'login');
    try {
      if (page === 'play') await renderPlay(Number(arg));
      else if (page === 'leaderboard') await renderLeaderboard(arg || 'overall');
      else if (page === 'admin') await renderAdmin();
      else if (page === 'login' || page === 'register') go('#/levels');
      else await renderLevels();
    } catch (e) {
      if (e.status === 401) {
        state.user = null;
        renderAuth('login');
      } else {
        app.replaceChildren(errorCard(e.message));
      }
    }
  }

  window.addEventListener('hashchange', route);

  (async function init() {
    try { await loadMe(); } catch { /* pas encore connecté */ }
    if (!location.hash) history.replaceState(null, '', '#/levels');
    route();
  })();
})();
