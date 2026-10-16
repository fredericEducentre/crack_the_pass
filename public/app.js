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

  function hexToRgba(hex, alpha) {
    const h2 = hex.replace('#', '');
    const r = parseInt(h2.slice(0, 2), 16);
    const g = parseInt(h2.slice(2, 4), 16);
    const b = parseInt(h2.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Petite pluie de caractères façon Matrix, purement décorative, sur un <canvas>. Ignorée si
  // l'utilisateur préfère moins d'animations ; renvoie une fonction "stop" à appeler en quittant.
  function matrixRain(canvas) {
    const ctx = canvas.getContext('2d');
    const chars = '01<>[]{}()!@#$%^&*=+-_~/\\|ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const fontSize = 16;
    const styles = getComputedStyle(document.documentElement);
    const fadeColor = hexToRgba(styles.getPropertyValue('--bg').trim() || '#0a0e14', 0.12);
    const dropColor = styles.getPropertyValue('--accent').trim() || '#35f0a0';
    let cols = 0;
    let drops = [];
    let raf = null;
    let lastStep = 0;
    const stepInterval = 110; // ms entre deux descentes d'une rangée : plus grand = plus lent

    function resize() {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      cols = Math.max(1, Math.floor(canvas.width / fontSize));
      drops = Array.from({ length: cols }, () => Math.random() * -40);
    }
    resize();
    window.addEventListener('resize', resize);

    // La boucle rAF tourne à la vitesse de l'écran (fluide), mais on ne fait avancer
    // la pluie que toutes les `stepInterval` ms, pour qu'elle tombe lentement.
    function tick(now) {
      if (canvas.offsetWidth > 0 && now - lastStep >= stepInterval) {
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
  function mountMatrixRain() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rainLeft = h('canvas', { class: 'matrix-rain matrix-rain-left', 'aria-hidden': 'true' });
    const rainRight = h('canvas', { class: 'matrix-rain matrix-rain-right', 'aria-hidden': 'true' });
    document.body.append(rainLeft, rainRight);
    const stopLeft = matrixRain(rainLeft);
    const stopRight = matrixRain(rainRight);
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
  // Petit mot pour un niveau verrouillé : un seul prérequis ("le niveau 4").
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
    h('section', { class: 'card' }, h('h1', null, 'Oups'), h('p', null, msg), h('a', { class: 'btn', href: '#/levels' }, 'Retour aux niveaux'));

  // ----------------------------------------------------------------- nav ---
  function renderNav(page) {
    if (!state.user) return nav.replaceChildren();
    nav.replaceChildren(
      h('a', { class: 'link' + (page === 'levels' || page === 'play' ? ' current' : ''), href: '#/levels' }, 'Niveaux'),
      h('a', { class: 'link' + (page === 'leaderboard' ? ' current' : ''), href: '#/leaderboard' }, 'Classement'),
      state.user.isAdmin
        ? h('a', { class: 'link' + (page === 'admin' ? ' current' : ''), href: '#/admin' }, 'Base de données')
        : null,
      h('span', { class: 'who' }, state.user.username),
      h('button', {
        class: 'btn ghost sm',
        onclick: async () => {
          try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
          state.user = null;
          go('#/login');
        },
      }, 'Déconnexion')
    );
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
    const cls = sec < 86400 * 30 ? 'bad' : sec < 86400 * 365 * 100 ? 'ok' : 'good';
    return { text: humanTime(sec), cls };
  }

  function renderAuth(mode = 'login') {
    leave();
    renderNav(null);
    const isRegister = mode === 'register';

    const err = h('p', { class: 'form-error', role: 'alert' });
    const username = h('input', {
      id: 'username', type: 'text', name: 'username', required: true, minlength: 3, maxlength: 20,
      autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false',
    });
    const password = h('input', {
      id: 'password', type: 'password', name: 'password', required: true, maxlength: 72,
      minlength: isRegister ? 8 : null, autocomplete: isRegister ? 'new-password' : 'current-password',
    });
    const meter = h('p', { class: 'meter', 'aria-live': 'polite' });
    const submit = h('button', { class: 'btn primary big', type: 'submit' }, isRegister ? 'Créer mon compte' : 'Se connecter');

    if (isRegister) {
      meter.textContent = 'Choisissez un mot de passe pour votre compte. Vous allez comprendre pourquoi il doit être long.';
      password.addEventListener('input', () => {
        const s = strengthHint(password.value);
        if (!s) { meter.textContent = 'Choisissez un mot de passe pour votre compte. Vous allez comprendre pourquoi il doit être long.'; return; }
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
        onclick: () => renderAuth(m),
      }, label);

    const form = h('form', {
      class: 'card auth',
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
      h('p', { class: 'eyebrow' }, 'Accès élève'),
      h('h1', null, isRegister ? 'Rejoindre la classe' : 'Content de vous revoir'),
      h('p', { class: 'muted' }, 'Cassez des mots de passe secrets de 1 à 8 caractères, le plus vite possible.'),
      h('div', { class: 'tabs', role: 'tablist' }, tab('login', 'Se connecter'), tab('register', "S'inscrire")),
      h('div', { class: 'field' }, h('label', { for: 'username' }, "Nom d'utilisateur"), username),
      h('div', { class: 'field' }, h('label', { for: 'password' }, 'Mot de passe'), password),
      meter,
      err,
      submit
    );

    app.replaceChildren(form);
    username.focus();
  }

  // -------------------------------------------------------------- levels ---
  function slotsPreview(n) {
    return h('div', { class: 'slots-preview', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('span', { class: 'slot' }, '?')));
  }

  function levelCard(p) {
    let badge, action, best;
    if (!p.unlocked) {
      badge = h('span', { class: 'badge' }, 'Verrouillé');
      action = h('button', { class: 'btn', disabled: true }, `Cassez d'abord ${lockedLabel(p.requires)}`);
    } else if (p.active) {
      badge = h('span', { class: 'badge progress' }, 'En cours');
      action = h('a', { class: 'btn primary', href: `#/play/${p.level}` }, 'Reprendre');
    } else if (p.best) {
      badge = h('span', { class: 'badge done' }, 'Cassé');
      action = h('a', { class: 'btn', href: `#/play/${p.level}` }, 'Rejouer');
    } else {
      badge = h('span', { class: 'badge ready' }, 'Prêt');
      action = h('a', { class: 'btn primary', href: `#/play/${p.level}` }, 'Démarrer');
    }
    if (p.best) best = h('p', { class: 'best' }, `Meilleur : ${fmtDuration(p.best.durationMs)} · ${p.best.guesses.toLocaleString('fr-FR')} essais`);

    return h('article', { class: 'card level' + (p.unlocked ? '' : ' locked') },
      h('div', { class: 'level-head' }, h('h2', null, `Niveau ${p.level}`), badge),
      slotsPreview(p.length),
      // Explication très courte du nombre de possibilités : choix par caractère ^ longueur.
      h('p', { class: 'meta count' },
        `${p.length} caractère${p.length > 1 ? 's' : ''} · `,
        p.length > 1 ? [`${p.charset.length}`, h('sup', null, String(p.length)), ' = '] : null,
        h('strong', null, p.possibilities.toLocaleString('fr-FR')),
        ' possibilités'),
      // Nombre de tentatives (parties lancées) de tous les élèves sur ce niveau, vous compris.
      h('p', { class: 'meta count' },
        'Tentatives de tous les élèves, vous compris : ',
        h('strong', null, (p.totalAttempts || 0).toLocaleString('fr-FR'))),
      best,
      h('div', { class: 'actions' }, action)
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
      h('li', null, h('code', null, `${method} ${path}`), ' — ', desc);

    return h('details', { class: 'card api-howto' },
      h('summary', null,
        h('span', { class: 'eyebrow' }, 'Pour aller plus vite'),
        h('span', null, "Vous pouvez aussi jouer via l'API")),

      h('h2', null, "C'est quoi, une API ?"),
      h('p', { class: 'muted' },
        'Une API (Application Programming Interface) est une « porte d\'entrée » qu\'un programme ' +
        'ouvre pour que d\'autres programmes lui parlent. Au lieu de cliquer sur des boutons, un ' +
        'logiciel envoie une requête (un petit message) au serveur, et le serveur répond. ' +
        'Ici, chaque action du jeu — se connecter, démarrer un niveau, tenter un mot de passe — ' +
        'est une requête HTTP envoyée à l\'API du serveur.'),
      h('p', { class: 'muted' },
        'En fait, les boutons de cette page ne font rien d\'autre : quand vous cliquez sur « Essayer », ' +
        'le navigateur envoie une requête à l\'API. Vous pouvez envoyer exactement les mêmes requêtes ' +
        'vous-même, depuis un terminal ou un programme, dans n\'importe quel langage.'),

      h('h2', null, 'Les endpoints du jeu'),
      h('p', { class: 'muted' },
        'Un « endpoint » est une adresse de l\'API pour une action précise. Les quatre ci-dessous ' +
        `fonctionnent pour chaque niveau (de ${firstId} à ${lastId}) : seuls changent le nombre de caractères d'un essai ` +
        '(de 1 à 8) et les caractères autorisés.'),
      h('ul', { class: 'api-list' },
        endpoint('POST', '/api/login', 'se connecter ; pose votre cookie de session, ou renvoie une erreur 401 si les identifiants sont faux.'),
        endpoint('POST', '/api/levels/:level/start', `démarrer le chrono de ce niveau (:level vaut ${firstId} à ${lastId}).`),
        endpoint('POST', '/api/levels/:level/guess', 'envoyer { guess } ; recevoir { correct } — et le temps réalisé (durationMs) quand c\'est gagné.'),
        endpoint('POST', '/api/levels/:level/giveup', 'abandonner la partie en cours et révéler le mot de passe.')),
      h('p', { class: 'muted small' },
        'Un essai doit avoir exactement la longueur du secret et n\'utiliser que les caractères du niveau ' +
        '(un essai qui ne respecte pas ça est refusé avec une erreur). Les écritures doivent être en JSON ' +
        '(Content-Type: application/json), et chaque élève est limité à un nombre sûr d\'essais par seconde.'),

      h('h2', null, 'Créer un fichier Python pour parler à l\'API'),
      h('p', { class: 'muted' },
        'Python sait envoyer des requêtes à une API avec la bibliothèque ', h('code', null, 'requests'),
        '. Voici la recette complète :'),
      h('ol', { class: 'api-list' },
        h('li', null, 'Installez la bibliothèque : dans un terminal, tapez ', h('code', null, 'pip install requests'), '.'),
        h('li', null, 'Copiez le code ci-dessous dans un fichier nommé ', h('code', null, 'crack.py'), '.'),
        h('li', null, 'Remplacez ', h('code', null, 'ton_pseudo'), ' et ', h('code', null, 'ton_mot_de_passe'),
          ' par vos identifiants, et choisissez le ', h('code', null, 'LEVEL'), '.'),
        h('li', null, 'Lancez-le : ', h('code', null, 'python crack.py'), '.')),
      h('pre', { class: 'api-code' }, h('code', null, py)),
      h('p', { class: 'muted small' },
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
    return h('section', { class: 'card bonus-challenge' },
      h('p', { class: 'eyebrow' }, 'Défi bonus (facultatif)'),
      h('h2', null, 'Le compte administrateur'),
      h('p', { class: 'muted' },
        'Votre enseignant a peut-être créé un vrai compte sur ce serveur, par exemple ',
        h('code', null, 'admin'), ', avec un vrai mot de passe. Essayez de vous y connecter avec le ' +
        'formulaire de connexion habituel (déconnectez-vous d\'abord, puis entrez ce nom ' +
        'd\'utilisateur et un mot de passe à deviner).'),
      h('p', { class: 'muted small' },
        'Ce n\'est pas un niveau : il n\'y a pas de secret généré par le jeu, pas de chrono, et il ' +
        'n\'apparaît pas dans le classement. Les tentatives de connexion restent limitées comme ' +
        'pour n\'importe quel compte (10 essais ratés toutes les 15 minutes) : même un mot de passe ' +
        'court peut résister longtemps si les connexions sont ainsi limitées.'));
  }

  async function renderLevels() {
    await loadMe();
    renderNav('levels');
    app.replaceChildren(
      h('section', { class: 'intro' },
        h('h1', null, 'À quelle vitesse savez-vous casser un mot de passe ?'),
        h('p', null,
          'Choisissez une catégorie : uniquement des chiffres, uniquement des lettres, ou n\'importe quel caractère. ' +
          'Dans chacune, le secret s\'allonge niveau après niveau. ' +
          'Le chrono démarre quand vous appuyez sur Démarrer et s\'arrête quand vous le trouvez.'),
        h('div', { class: 'charset-help' },
          h('h2', null, 'Qu\'est-ce qu\'un caractère ?'),
          h('p', null,
            'Un caractère, c\'est un seul symbole que vous pouvez taper au clavier. Il peut être :'),
          h('ul', null,
            h('li', null, h('strong', null, 'une lettre minuscule'), ' : ', h('code', null, 'a b c … z')),
            h('li', null, h('strong', null, 'une lettre majuscule'), ' : ', h('code', null, 'A B C … Z')),
            h('li', null, h('strong', null, 'un chiffre'), ' : ', h('code', null, '0 1 2 … 9')),
            h('li', null, h('strong', null, 'un caractère spécial'), ' : ', h('code', null, '! ? # $ % & @ * + - = _ . , ; : / ( ) [ ] { } < > ~ ^ | \\ " \' `'))),
          h('p', { class: 'small' },
            `Dans la catégorie Caractères, cela fait ${KEYBOARD_CHARSET.length} choix possibles pour chaque position du secret. ` +
            'Les emojis et l\'espace ne sont jamais utilisés. Majuscules et minuscules sont deux caractères ' +
            'différents (a ≠ A).'))
      ),
      // replaceChildren n'aplatit pas les tableaux : on déplie les sections avec "...".
      ...CATEGORY_ORDER.map((id) => {
        const levels = state.progress.filter((p) => p.category === id);
        if (!levels.length) return null;
        const choices = levels[0].charset.length;
        return h('section', { class: 'category' },
          h('div', { class: 'category-head' },
            h('h2', null, categoryName(id)),
            h('p', { class: 'muted' }, `${CATEGORIES[id].blurb} ${choices} choix par caractère.`)),
          h('div', { class: 'levels' }, levels.map(levelCard)));
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
      h('section', { class: 'card play' },
        h('p', { class: 'eyebrow' }, `${categoryName(p.category)} · niveau ${p.level}`),
        h('h1', null, `Un secret de ${p.length} caractère${p.length > 1 ? 's' : ''}`),
        slotsPreview(p.length),
        h('p', { class: 'rules' }, `Chaque caractère : ${describeCharset(p.charset)}.`),
        h('div', { class: 'actions', style: 'justify-content:center' },
          h('button', {
            class: 'btn primary big',
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
          h('a', { class: 'btn ghost', href: '#/levels' }, 'Retour')
        )
      )
    );
  }

  function runLevel(level, attempt) {
    // Chaque niveau a sa propre longueur de secret et son propre jeu de caractères.
    const { length, charset, category } = state.progress.find((x) => x.level === level);
    const allowed = new Set(charset);
    const hasUpper = charset !== charset.toLowerCase();
    let guesses = attempt.guesses;
    let busy = false;
    let finished = false;

    const timerEl = h('div', { class: 'timer' }, '00:00.000');
    const countEl = h('div', { class: 'count' }, String(guesses));
    const tick = () => { timerEl.textContent = fmtDuration(Date.now() + state.offset - attempt.startedAt); };
    tick();
    const iv = setInterval(tick, 47);
    onLeave(() => clearInterval(iv));

    const input = h('input', {
      class: 'slot-input', type: 'text', maxlength: length, autocomplete: 'off', autocapitalize: 'off',
      autocorrect: 'off', spellcheck: 'false', 'aria-label': `Votre essai : ${length} caractère${length > 1 ? 's' : ''}`,
    });
    const slots = Array.from({ length }, () => h('span', { class: 'slot' }));
    const slotBox = h('div', { class: 'slots' + (length > 5 ? ' many' : ''), onclick: () => input.focus() }, slots, input);
    const msg = h('p', { class: 'msg', role: 'alert' });
    const historyEl = h('ul', { class: 'history' });
    const historyTitle = h('p', { class: 'history-title', hidden: true }, 'Mauvais essais');
    const history = [];

    const paintSlots = () => {
      slots.forEach((s, i) => {
        s.textContent = input.value[i] || '';
        s.classList.toggle('active', i === Math.min(input.value.length, length - 1));
      });
    };
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
        historyEl.replaceChildren(...history.slice(0, 40).map((g) => h('li', null, g)));
        historyTitle.hidden = false;
        slotBox.classList.remove('shake');
        void slotBox.offsetWidth; // relance l'animation
        slotBox.classList.add('shake');
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
          h('section', { class: 'card result' },
            h('p', { class: 'eyebrow' }, 'Partie abandonnée'),
            h('h1', null, 'Le mot de passe était'),
            h('div', { class: 'secret' + (length > 5 ? ' many' : '') }, [...r.secret].map((c) => h('span', { class: 'slot' }, c))),
            h('p', { class: 'muted' }, `Vous avez fait ${r.guesses.toLocaleString('fr-FR')} essai${r.guesses === 1 ? '' : 's'}. La prochaine partie utilise un tout nouveau mot de passe.`),
            h('div', { class: 'actions' },
              h('button', { class: 'btn primary', onclick: () => route() }, 'Réessayer'),
              h('a', { class: 'btn ghost', href: '#/levels' }, 'Retour aux niveaux'))
          )
        );
      } catch (ex) {
        msg.textContent = ex.message;
      }
    }

    app.replaceChildren(
      h('section', { class: 'card play' },
        h('p', { class: 'eyebrow' }, `${categoryName(category)} · niveau ${level} · ${length} caractère${length > 1 ? 's' : ''}`),
        h('div', { class: 'hud' },
          h('div', null, h('div', { class: 'label' }, 'Temps'), timerEl),
          h('div', null, h('div', { class: 'label' }, 'Essais'), countEl)
        ),
        h('form', { onsubmit: submitGuess, autocomplete: 'off' },
          slotBox,
          h('p', { class: 'muted small' }, `Chaque caractère : ${describeCharset(charset)}`),
          msg,
          h('button', { class: 'btn primary big', type: 'submit' }, 'Essayer')
        ),
        historyTitle,
        historyEl,
        h('div', { class: 'giveup' }, h('button', { class: 'btn danger', type: 'button', onclick: giveUp }, 'Abandonner'))
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
    const stat = (label, value) => h('div', null, h('dt', null, label), h('dd', null, value));
    app.replaceChildren(
      h('section', { class: 'card result' },
        h('p', { class: 'eyebrow' }, 'Accès autorisé'),
        h('h1', null, hasNext ? 'Mot de passe cassé !' : `Catégorie ${categoryName(current.category)} terminée. Bravo !`),
        h('div', { class: 'secret' + (r.secret.length > 5 ? ' many' : '') }, [...r.secret].map((c) => h('span', { class: 'slot' }, c))),
        h('dl', { class: 'stats' },
          stat('Temps', fmtDuration(r.durationMs)),
          stat('Essais', r.guesses.toLocaleString('fr-FR')),
          stat('Rang', r.rank ? `#${r.rank} sur ${r.players}` : '-'),
          stat('Terminé à', fmtClock(r.finishedAt))
        ),
        h('div', { class: 'actions' },
          hasNext ? h('a', { class: 'btn primary', href: `#/play/${next.level}` }, 'Niveau suivant →')
            : h('a', { class: 'btn primary', href: '#/levels' }, 'Choisir une autre catégorie'),
          h('a', { class: 'btn', href: `#/leaderboard/${level}` }, 'Voir le classement'),
          h('button', { class: 'btn ghost', onclick: () => route() }, 'Rejouer (nouveau mot de passe)')
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
    if (!rows.length) return h('p', { class: 'empty' }, 'Aucun compte ne correspond.');
    return h('div', { class: 'table-scroll' },
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, 'Nom d\'utilisateur'), h('th', null, 'Créé le'))),
        h('tbody', null, rows.map((u) =>
          h('tr', null,
            h('td', { class: 'num' }, u.id),
            h('td', null, u.username),
            h('td', null, fmtClock(u.createdAt)))))));
  }

  function adminAttemptsTable(attempts, filter) {
    const rows = attempts.filter((a) => a.username.toLowerCase().includes(filter));
    if (!rows.length) return h('p', { class: 'empty' }, 'Aucune tentative ne correspond.');
    const statusLabel = { active: 'en cours', done: 'cassé', abandoned: 'abandonné' };
    return h('div', { class: 'table-scroll' },
      h('table', null,
        h('thead', null, h('tr', null,
          h('th', null, 'ID'), h('th', null, 'Élève'), h('th', null, 'Niveau'), h('th', null, 'Secret'),
          h('th', null, 'Statut'), h('th', { class: 'num' }, 'Essais'), h('th', null, 'Démarré'),
          h('th', null, 'Terminé'), h('th', { class: 'num' }, 'Temps'))),
        h('tbody', null, rows.map((a) =>
          h('tr', null,
            h('td', { class: 'num' }, a.id),
            h('td', null, a.username),
            h('td', { class: 'num' }, a.level),
            h('td', null, h('code', null, a.secret)),
            h('td', null, statusLabel[a.status] || a.status),
            h('td', { class: 'num' }, a.guesses.toLocaleString('fr-FR')),
            h('td', null, fmtClock(a.startedAt)),
            h('td', null, a.finishedAt ? fmtClock(a.finishedAt) : '—'),
            h('td', { class: 'num' }, a.durationMs != null ? fmtDuration(a.durationMs) : '—'))))));
  }

  async function renderAdmin() {
    renderNav('admin');
    if (!state.user.isAdmin) return app.replaceChildren(errorCard('Cette page est réservée au compte administrateur.'));

    mountMatrixRain();

    const search = h('input', { type: 'text', placeholder: 'Filtrer par élève…', class: 'admin-search' });
    const usersBox = h('div', { class: 'card' }, h('p', { class: 'empty' }, 'Chargement…'));
    const attemptsBox = h('div', { class: 'card' }, h('p', { class: 'empty' }, 'Chargement…'));

    app.replaceChildren(
      h('section', null,
        h('p', { class: 'eyebrow' }, 'Lecture seule'),
        h('h1', null, 'Base de données'),
        h('p', { class: 'muted' },
          'Tous les comptes et toutes les tentatives, tous élèves confondus. Cette page ne permet ' +
          'ni d\'ajouter, ni de modifier, ni de supprimer quoi que ce soit — uniquement de lire.'),
        h('div', { class: 'field' }, search),
        h('h2', null, `Comptes`),
        usersBox,
        h('h2', null, 'Tentatives'),
        attemptsBox)
    );

    let data;
    try {
      data = await api('/admin/overview');
    } catch (ex) {
      usersBox.replaceChildren(h('p', { class: 'empty' }, ex.message));
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
  function boardTable(data) {
    if (!data.rows.length) {
      return h('p', { class: 'empty' }, data.which === 'overall'
        ? "Personne n'a encore cassé de niveau. Soyez le premier !"
        : "Personne n'a encore cassé ce niveau. Soyez le premier !");
    }
    const rankCell = (n) => h('td', { class: 'rank' + (n <= 3 ? ` r${n}` : '') }, `#${n}`);
    let head, body;
    if (data.which === 'overall') {
      head = ['#', 'Élève', 'Niveaux', 'Temps total', 'Dernière réussite'];
      body = data.rows.map((r) =>
        h('tr', { class: r.isMe ? 'me' : null },
          rankCell(r.rank),
          h('td', null, r.username + (r.isMe ? ' (vous)' : '')),
          h('td', { class: 'num' }, `${r.levelsDone}/${data.totalLevels}`),
          h('td', { class: 'num' }, fmtDuration(r.totalMs)),
          h('td', { class: 'num' }, fmtClock(r.lastFinished))));
    } else {
      head = ['#', 'Élève', 'Temps', 'Terminé à', 'Essais'];
      body = data.rows.map((r) =>
        h('tr', { class: r.isMe ? 'me' : null },
          rankCell(r.rank),
          h('td', null, r.username + (r.isMe ? ' (vous)' : '')),
          h('td', { class: 'num' }, fmtDuration(r.durationMs)),
          h('td', { class: 'num' }, fmtClock(r.finishedAt)),
          h('td', { class: 'num' }, r.guesses.toLocaleString('fr-FR'))));
    }
    return h('div', { class: 'table-scroll' },
      h('table', null,
        h('thead', null, h('tr', null, head.map((t, i) => h('th', { class: i >= 2 ? 'num' : null }, t)))),
        h('tbody', null, body)));
  }

  async function renderLeaderboard(which) {
    renderNav('leaderboard');
    const valid = ['overall', ...state.config.levels.map(String)];
    if (!valid.includes(which)) which = 'overall';

    // Un onglet « Général », puis un groupe par catégorie avec un onglet par niveau (numéroté par longueur).
    const tabs = [
      h('a', { href: '#/leaderboard/overall', class: which === 'overall' ? 'current' : null }, 'Général'),
      ...CATEGORY_ORDER.map((id) => {
        const levels = state.progress.filter((p) => p.category === id);
        if (!levels.length) return null;
        return h('div', { class: 'board-group' },
          h('span', { class: 'board-group-name' }, categoryName(id)),
          levels.map((p) =>
            h('a', {
              href: `#/leaderboard/${p.level}`,
              class: String(p.level) === which ? 'current' : null,
              title: `Niveau ${p.level} : ${p.length} caractère${p.length > 1 ? 's' : ''}`,
            }, `${p.length} car.`)));
      }),
    ];
    const container = h('div', { class: 'card' }, h('p', { class: 'empty' }, 'Chargement…'));
    const note = h('p', { class: 'board-note' },
      which === 'overall'
        ? 'Classé par niveaux cassés, puis par total de vos meilleurs temps. En cas d\'égalité, le premier à avoir terminé passe devant.'
        : 'Chaque élève apparaît une fois avec sa meilleure partie. Classé par temps le plus court ; en cas d\'égalité, le premier à avoir terminé passe devant.');

    app.replaceChildren(
      h('section', null,
        h('p', { class: 'eyebrow' }, 'Panthéon'),
        h('h1', null, 'Classement'),
        h('div', { class: 'board-tabs' }, tabs),
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
