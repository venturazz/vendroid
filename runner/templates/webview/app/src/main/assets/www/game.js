// Tap-the-dot: a tiny starter game. Edit freely, or ask the AI assistant to change it.
(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const BEST_KEY = 'best-score';
  let dots = [];
  let score = 0;
  let misses = 0;
  let best = Number(localStorage.getItem(BEST_KEY)) || 0;
  let running = false;
  let lastSpawn = 0;
  let last = 0;
  bestEl.textContent = `Best ${best}`;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  function spawn() {
    const r = 22 + Math.random() * 18;
    dots.push({
      x: r + Math.random() * (innerWidth - 2 * r),
      y: 60 + r + Math.random() * (innerHeight - 80 - 2 * r),
      r,
      life: Math.max(900, 2200 - score * 25), // gets faster as you score
      age: 0,
      hue: Math.floor(Math.random() * 360),
    });
  }

  function start() {
    dots = [];
    score = 0;
    misses = 0;
    scoreEl.textContent = '0';
    overlay.hidden = true;
    running = true;
    last = performance.now();
    lastSpawn = 0;
    requestAnimationFrame(loop);
  }

  function gameOver() {
    running = false;
    if (score > best) {
      best = score;
      localStorage.setItem(BEST_KEY, String(best));
      bestEl.textContent = `Best ${best}`;
    }
    overlay.querySelector('p').textContent = `Score ${score}. Tap Play to try again.`;
    overlay.hidden = false;
  }

  function loop(now) {
    if (!running) return;
    const dt = now - last;
    last = now;
    lastSpawn += dt;
    if (lastSpawn > Math.max(350, 900 - score * 10)) { spawn(); lastSpawn = 0; }
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    dots = dots.filter((d) => {
      d.age += dt;
      if (d.age >= d.life) {
        misses++;
        if (navigator.vibrate) navigator.vibrate(60);
        return false;
      }
      const k = 1 - d.age / d.life;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * (0.6 + 0.4 * k), 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${d.hue}, 90%, 60%, ${0.25 + 0.75 * k})`;
      ctx.shadowColor = `hsl(${d.hue}, 90%, 60%)`;
      ctx.shadowBlur = 20;
      ctx.fill();
      return true;
    });
    ctx.shadowBlur = 0;
    if (misses >= 3) return gameOver();
    requestAnimationFrame(loop);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!running) return;
    for (let i = dots.length - 1; i >= 0; i--) {
      const d = dots[i];
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= d.r + 10) {
        dots.splice(i, 1);
        score++;
        scoreEl.textContent = String(score);
        return;
      }
    }
  });
  document.getElementById('start').addEventListener('click', start);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) gameOver();
  });
})();
