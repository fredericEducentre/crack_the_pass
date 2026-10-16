// Configuration du thème Tailwind (couleurs, police mono, animations) pour le CDN Play.
// Fichier à part (plutôt qu'un <script> en ligne dans index.html) pour rester compatible avec
// la Content-Security-Policy du serveur, qui n'autorise que les scripts de même origine ou
// explicitement listés (voir script-src dans server.js) — pas de script "inline" arbitraire.
tailwind.config = {
  theme: {
    extend: {
      colors: {
        bg: '#0a0e14',
        surface: '#111823',
        surface2: '#172131',
        border: '#22304a',
        ink: '#e6edf7',
        muted: '#8b9ab3',
        accent: '#35f0a0',
        accentink: '#04170f',
        danger: '#ff5d73',
        warn: '#ffc857',
        info: '#6cb6ff',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        blink: { '50%': { opacity: 0 } },
        shake: {
          '20%': { transform: 'translateX(-8px)' },
          '40%': { transform: 'translateX(7px)' },
          '60%': { transform: 'translateX(-5px)' },
          '80%': { transform: 'translateX(3px)' },
        },
        pop: { from: { transform: 'scale(0.6)', opacity: 0 } },
      },
      animation: {
        blink: 'blink 1.1s steps(1) infinite',
        shake: 'shake 0.35s',
        pop: 'pop 0.4s backwards',
      },
    },
  },
};
