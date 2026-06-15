/* ============================================================================
 * Pylex Extension: Brick Breaker
 * Adds a "Brick Breaker" tab to the sidebar with a full, polished, touch
 * (finger-slide) and mouse/keyboard controllable brick breaker game,
 * with levels, lives, scoring, and a neon visual style.
 * ============================================================================ */
(function () {
  'use strict';

  const SECTION_ID = 'section-brickbreaker';
  const BTN_ID = 'sb-brickbreaker';

  // ── Sidebar button + section injection ────────────────────────────────
  function injectSidebarButton() {
    if (document.getElementById(BTN_ID)) return;
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    const btn = document.createElement('button');
    btn.className = 'sb-btn';
    btn.id = BTN_ID;
    btn.title = 'Brick Breaker';
    btn.setAttribute('onclick', "switchSection('brickbreaker')");
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="6" height="3" rx="1"></rect>
        <rect x="10" y="4" width="6" height="3" rx="1"></rect>
        <rect x="17" y="4" width="4" height="3" rx="1"></rect>
        <rect x="3" y="9" width="4" height="3" rx="1"></rect>
        <rect x="8" y="9" width="6" height="3" rx="1"></rect>
        <rect x="15" y="9" width="6" height="3" rx="1"></rect>
        <circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none"></circle>
        <rect x="9" y="19.5" width="6" height="1.6" rx="0.8" fill="currentColor" stroke="none"></rect>
      </svg>
      <span class="sb-tooltip">Brick Breaker</span>
    `;

    // Insert before the spacer/danger zone if present, otherwise append
    const spacer = sidebar.querySelector('.sb-spacer');
    if (spacer) sidebar.insertBefore(btn, spacer);
    else sidebar.appendChild(btn);
  }

  function injectSection() {
    if (document.getElementById(SECTION_ID)) return;
    const main = document.querySelector('main.main') || document.querySelector('.main');
    if (!main) return;

    const section = document.createElement('section');
    // Use 'section' class so switchSection() can find it via querySelectorAll('.section'),
    // but override the default padding so bb-wrap controls its own spacing.
    section.className = 'section';
    section.id = SECTION_ID;
    section.style.padding = '0';
    section.innerHTML = `
      <div class="bb-wrap">
        <div class="bb-header">
          <div>
            <h2 class="bb-title">Brick Breaker</h2>
            <p class="bb-subtitle">Slide to move the paddle. Clear every brick to advance.</p>
          </div>
          <div class="bb-hud">
            <div class="bb-hud-item"><span class="bb-hud-label">Score</span><span class="bb-hud-value" id="bb-score">0</span></div>
            <div class="bb-hud-item"><span class="bb-hud-label">Level</span><span class="bb-hud-value" id="bb-level">1</span></div>
            <div class="bb-hud-item"><span class="bb-hud-label">Lives</span><span class="bb-hud-value" id="bb-lives">3</span></div>
          </div>
        </div>

        <div class="bb-stage">
          <canvas id="bb-canvas"></canvas>

          <div class="bb-overlay" id="bb-overlay">
            <div class="bb-overlay-card">
              <div class="bb-logo">
                <span class="bb-logo-brick bb-c1"></span>
                <span class="bb-logo-brick bb-c2"></span>
                <span class="bb-logo-brick bb-c3"></span>
              </div>
              <h3 id="bb-overlay-title">Brick Breaker</h3>
              <p id="bb-overlay-text">Drag / slide on the board to move the paddle.<br>Or use ← → arrow keys.</p>
              <button class="bb-btn bb-btn-primary" id="bb-start-btn">Start Game</button>
            </div>
          </div>
        </div>

        <div class="bb-controls">
          <button class="bb-btn" id="bb-pause-btn">Pause</button>
          <button class="bb-btn" id="bb-restart-btn">Restart</button>
          <div class="bb-best">Best: <span id="bb-best-score">0</span></div>
        </div>
      </div>
    `;
    main.appendChild(section);
  }

  // ── Styles ──────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('bb-ext-styles')) return;
    const style = document.createElement('style');
    style.id = 'bb-ext-styles';
    style.textContent = `
      .bb-wrap {
        display: flex; flex-direction: column; gap: 16px;
        padding: 24px; max-width: 980px; margin: 0 auto; width: 100%;
        box-sizing: border-box; height: 100%;
      }
      .bb-header {
        display: flex; align-items: flex-start; justify-content: space-between;
        gap: 16px; flex-wrap: wrap;
      }
      .bb-title { font-size: 1.35rem; font-weight: 700; color: var(--text); margin: 0; }
      .bb-subtitle { font-size: 0.82rem; color: var(--text-2); margin: 4px 0 0; }
      .bb-hud { display: flex; gap: 10px; }
      .bb-hud-item {
        background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
        padding: 8px 16px; text-align: center; min-width: 70px;
      }
      .bb-hud-label {
        display: block; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.08em;
        text-transform: uppercase; color: var(--text-3); margin-bottom: 2px;
      }
      .bb-hud-value { display: block; font-size: 1.15rem; font-weight: 700; color: var(--orange); font-family: var(--mono); }

      .bb-stage {
        position: relative; width: 100%;
        aspect-ratio: 3 / 4;
        max-height: 70vh;
        margin: 0 auto;
        border-radius: 16px; overflow: hidden;
        border: 1px solid var(--border);
        background: linear-gradient(160deg, #0d0f1a 0%, #181c2e 60%, #0d0f1a 100%);
        box-shadow: 0 12px 40px rgba(0,0,0,0.25), inset 0 0 60px rgba(243,128,32,0.05);
        touch-action: none;
        user-select: none;
      }
      #bb-canvas { display: block; width: 100%; height: 100%; touch-action: none; }

      .bb-overlay {
        position: absolute; inset: 0; z-index: 5;
        background: rgba(10,12,20,0.72); backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        opacity: 1; transition: opacity 0.25s; pointer-events: auto;
      }
      .bb-overlay.hidden { opacity: 0; pointer-events: none; }
      .bb-overlay-card { text-align: center; padding: 28px; max-width: 320px; }
      .bb-overlay-card h3 { color: #fff; font-size: 1.25rem; margin: 14px 0 8px; font-weight: 700; }
      .bb-overlay-card p { color: rgba(255,255,255,0.6); font-size: 0.82rem; line-height: 1.6; margin: 0 0 18px; }

      .bb-logo { display: flex; gap: 6px; justify-content: center; margin-bottom: 6px; }
      .bb-logo-brick {
        width: 34px; height: 14px; border-radius: 4px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        animation: bb-bob 1.8s ease-in-out infinite;
      }
      .bb-c1 { background: linear-gradient(135deg,#f38020,#ff9d4d); animation-delay: 0s; }
      .bb-c2 { background: linear-gradient(135deg,#4dd0e1,#26a69a); animation-delay: 0.2s; }
      .bb-c3 { background: linear-gradient(135deg,#ab47bc,#7e57c2); animation-delay: 0.4s; }
      @keyframes bb-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }

      .bb-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        padding: 10px 22px; border-radius: 8px; font-size: 0.85rem; font-weight: 600;
        border: 1px solid var(--border); background: var(--surface); color: var(--text-2);
        cursor: pointer; transition: all 0.15s; font-family: var(--sans);
      }
      .bb-btn:hover { border-color: var(--orange); color: var(--orange); background: var(--orange-dim); }
      .bb-btn-primary { background: var(--orange); color: #fff; border-color: var(--orange); padding: 11px 28px; font-size: 0.9rem; }
      .bb-btn-primary:hover { background: var(--orange-hover); color: #fff; }

      .bb-controls { display: flex; align-items: center; gap: 10px; justify-content: center; flex-wrap: wrap; }
      .bb-best { font-size: 0.78rem; color: var(--text-3); font-family: var(--mono); margin-left: 8px; }

      @media (max-width: 600px) {
        .bb-wrap { padding: 14px; gap: 12px; }
        .bb-title { font-size: 1.1rem; }
        .bb-hud-item { padding: 6px 10px; min-width: 56px; }
        .bb-hud-value { font-size: 0.95rem; }
        .bb-stage { aspect-ratio: 3 / 4.4; max-height: 75vh; border-radius: 12px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Game ────────────────────────────────────────────────────────────────
  const LEVELS = [
    { rows: 4,  cols: 7, speed: 3.4, hp: 1, layout: 'full' },
    { rows: 5,  cols: 8, speed: 3.8, hp: 1, layout: 'full' },
    { rows: 5,  cols: 8, speed: 4.2, hp: 2, layout: 'checker' },
    { rows: 6,  cols: 9, speed: 4.6, hp: 2, layout: 'diamond' },
    { rows: 6,  cols: 9, speed: 5.0, hp: 3, layout: 'pyramid' },
    { rows: 7,  cols: 10, speed: 5.4, hp: 3, layout: 'random' },
  ];

  const BRICK_COLORS = [
    ['#ff6b6b', '#ee5253'],
    ['#ff9f43', '#f38020'],
    ['#feca57', '#f5b942'],
    ['#1dd1a1', '#10ac84'],
    ['#48dbfb', '#0abde3'],
    ['#a29bfe', '#7c6df2'],
    ['#ff7ac6', '#ec5ea8'],
  ];

  let canvas, ctx;
  let game = null;
  let rafId = null;
  let initialized = false;

  function loadBest() {
    try { return parseInt(localStorage.getItem('pylex_bb_best') || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem('pylex_bb_best', String(v)); } catch (e) {}
  }

  function getLevelConfig(levelIdx) {
    // Loop / scale difficulty past the predefined levels
    if (levelIdx < LEVELS.length) return LEVELS[levelIdx];
    const base = LEVELS[LEVELS.length - 1];
    const extra = levelIdx - LEVELS.length + 1;
    return {
      rows: Math.min(base.rows + Math.floor(extra / 2), 10),
      cols: base.cols,
      speed: Math.min(base.speed + extra * 0.3, 9),
      hp: Math.min(base.hp + Math.floor(extra / 2), 5),
      layout: ['full', 'checker', 'diamond', 'pyramid', 'random'][extra % 5],
    };
  }

  function buildBricks(cfg, areaW, areaH) {
    const padding = 6;
    const topOffset = 50;
    const cellW = (areaW - padding * (cfg.cols + 1)) / cfg.cols;
    const cellH = 22;
    const bricks = [];

    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        let include = true;
        switch (cfg.layout) {
          case 'checker':
            include = (r + c) % 2 === 0;
            break;
          case 'diamond': {
            const midR = (cfg.rows - 1) / 2, midC = (cfg.cols - 1) / 2;
            const dist = Math.abs(r - midR) + Math.abs(c - midC) * (midR / midC || 1);
            include = dist <= Math.max(midR, midC) * 0.85;
            break;
          }
          case 'pyramid':
            include = c >= Math.floor((cfg.cols - (r + 1) * (cfg.cols / cfg.rows)) / 2) &&
                      c < cfg.cols - Math.floor((cfg.cols - (r + 1) * (cfg.cols / cfg.rows)) / 2);
            break;
          case 'random':
            include = Math.random() > 0.18;
            break;
          default:
            include = true;
        }
        if (!include) continue;

        const hp = cfg.hp === 1 ? 1 : (1 + Math.floor(Math.random() * cfg.hp));
        bricks.push({
          x: padding + c * (cellW + padding),
          y: topOffset + r * (cellH + padding),
          w: cellW, h: cellH,
          hp, maxHp: hp,
          colorIdx: (r + c) % BRICK_COLORS.length,
          alive: true,
        });
      }
    }
    return bricks;
  }

  function resizeCanvas() {
    if (!canvas) return;
    const stage = canvas.parentElement;
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (game) {
      game.w = rect.width;
      game.h = rect.height;
      // Reposition paddle to stay on screen
      game.paddle.x = Math.min(game.paddle.x, game.w - game.paddle.w);
      if (game.bricks) {
        // rebuild brick layout to fit new width, preserving alive/hp state by index
        const cfg = getLevelConfig(game.levelIdx);
        const fresh = buildBricks(cfg, game.w, game.h);
        for (let i = 0; i < fresh.length && i < game.bricks.length; i++) {
          fresh[i].hp = game.bricks[i].hp;
          fresh[i].maxHp = game.bricks[i].maxHp;
          fresh[i].alive = game.bricks[i].alive;
          fresh[i].colorIdx = game.bricks[i].colorIdx;
        }
        game.bricks = fresh;
      }
    }
  }

  function newBall(g) {
    return {
      x: g.w / 2,
      y: g.h - 70,
      r: 6,
      vx: g.cfg.speed * (Math.random() > 0.5 ? 1 : -1) * 0.6,
      vy: -g.cfg.speed,
    };
  }

  function initGameState(levelIdx, score, lives) {
    const stage = canvas.parentElement;
    const rect = stage.getBoundingClientRect();
    const cfg = getLevelConfig(levelIdx);
    const g = {
      w: rect.width, h: rect.height,
      cfg, levelIdx,
      score: score || 0,
      lives: lives == null ? 3 : lives,
      paddle: { w: Math.max(70, rect.width * 0.22), h: 12, x: 0, y: 0 },
      bricks: buildBricks(cfg, rect.width, rect.height),
      running: false,
      paused: false,
      gameOver: false,
      won: false,
      particles: [],
      trail: [],
    };
    g.paddle.x = (g.w - g.paddle.w) / 2;
    g.paddle.y = g.h - 28;
    g.ball = newBall(g);
    return g;
  }

  function updateHud() {
    document.getElementById('bb-score').textContent = game.score;
    document.getElementById('bb-level').textContent = game.levelIdx + 1;
    document.getElementById('bb-lives').textContent = game.lives;
    document.getElementById('bb-best-score').textContent = Math.max(loadBest(), game.score);
  }

  function showOverlay(title, text, btnLabel) {
    const overlay = document.getElementById('bb-overlay');
    document.getElementById('bb-overlay-title').textContent = title;
    document.getElementById('bb-overlay-text').innerHTML = text;
    const btn = document.getElementById('bb-start-btn');
    btn.textContent = btnLabel;
    overlay.classList.remove('hidden');
  }
  function hideOverlay() {
    document.getElementById('bb-overlay').classList.add('hidden');
  }

  function spawnParticles(g, x, y, color) {
    for (let i = 0; i < 8; i++) {
      g.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 4,
        vy: (Math.random() - 0.5) * 4 - 1,
        life: 1,
        color,
      });
    }
  }

  function step() {
    if (!game || !game.running || game.paused) { rafId = requestAnimationFrame(step); return; }
    const g = game;
    const b = g.ball;

    b.x += b.vx;
    b.y += b.vy;

    // Trail
    g.trail.push({ x: b.x, y: b.y });
    if (g.trail.length > 10) g.trail.shift();

    // Wall collisions
    if (b.x - b.r <= 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
    if (b.x + b.r >= g.w) { b.x = g.w - b.r; b.vx = -Math.abs(b.vx); }
    if (b.y - b.r <= 0) { b.y = b.r; b.vy = Math.abs(b.vy); }

    // Paddle collision
    const p = g.paddle;
    if (b.y + b.r >= p.y && b.y + b.r <= p.y + p.h + 6 && b.x >= p.x - b.r && b.x <= p.x + p.w + b.r && b.vy > 0) {
      const hitPos = (b.x - (p.x + p.w / 2)) / (p.w / 2); // -1..1
      const speed = Math.min(Math.hypot(b.vx, b.vy) * 1.03, g.cfg.speed * 2.4);
      const angle = hitPos * (Math.PI / 3); // up to 60deg
      b.vx = speed * Math.sin(angle);
      b.vy = -Math.abs(speed * Math.cos(angle));
      b.y = p.y - b.r - 0.5;
    }

    // Brick collisions
    for (const brick of g.bricks) {
      if (!brick.alive) continue;
      if (b.x + b.r > brick.x && b.x - b.r < brick.x + brick.w &&
          b.y + b.r > brick.y && b.y - b.r < brick.y + brick.h) {

        // Determine collision side
        const overlapX = Math.min(b.x + b.r - brick.x, brick.x + brick.w - (b.x - b.r));
        const overlapY = Math.min(b.y + b.r - brick.y, brick.y + brick.h - (b.y - b.r));
        if (overlapX < overlapY) b.vx = -b.vx;
        else b.vy = -b.vy;

        brick.hp -= 1;
        const color = BRICK_COLORS[brick.colorIdx][0];
        spawnParticles(g, b.x, b.y, color);

        if (brick.hp <= 0) {
          brick.alive = false;
          g.score += 10 * (brick.maxHp);
        } else {
          g.score += 2;
        }
        updateHud();
        break;
      }
    }

    // Particles
    for (let i = g.particles.length - 1; i >= 0; i--) {
      const part = g.particles[i];
      part.x += part.vx; part.y += part.vy; part.vy += 0.15; part.life -= 0.04;
      if (part.life <= 0) g.particles.splice(i, 1);
    }

    // Ball lost
    if (b.y - b.r > g.h) {
      g.lives -= 1;
      updateHud();
      if (g.lives <= 0) {
        g.running = false;
        g.gameOver = true;
        const best = Math.max(loadBest(), g.score);
        saveBest(best);
        showOverlay('Game Over', `Final score: <strong>${g.score}</strong><br>Level reached: ${g.levelIdx + 1}`, 'Play Again');
      } else {
        g.ball = newBall(g);
        g.trail = [];
        g.running = false;
        showOverlay('Ball Lost', `${g.lives} ${g.lives === 1 ? 'life' : 'lives'} remaining`, 'Continue');
      }
    }

    // Level cleared
    if (g.bricks.every(br => !br.alive)) {
      const best = Math.max(loadBest(), g.score);
      saveBest(best);
      g.running = false;
      g.levelIdx += 1;
      const nextCfg = getLevelConfig(g.levelIdx);
      g.cfg = nextCfg;
      g.bricks = buildBricks(nextCfg, g.w, g.h);
      g.ball = newBall(g);
      g.trail = [];
      updateHud();
      showOverlay('Level Cleared!', `Get ready for level <strong>${g.levelIdx + 1}</strong>`, 'Next Level');
    }

    render();
    rafId = requestAnimationFrame(step);
  }

  function render() {
    const g = game;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    // Background grid glow
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = '#f38020';
    for (let x = 0; x < g.w; x += 30) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, g.h); ctx.stroke();
    }
    ctx.restore();

    // Bricks
    for (const brick of g.bricks) {
      if (!brick.alive) continue;
      const [c1, c2] = BRICK_COLORS[brick.colorIdx];
      const grad = ctx.createLinearGradient(brick.x, brick.y, brick.x, brick.y + brick.h);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);
      ctx.fillStyle = grad;
      roundRect(ctx, brick.x, brick.y, brick.w, brick.h, 4);
      ctx.fill();

      if (brick.maxHp > 1) {
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '700 10px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(brick.hp), brick.x + brick.w / 2, brick.y + brick.h / 2 + 1);
        ctx.globalAlpha = 1;
      }
    }

    // Particles
    for (const part of g.particles) {
      ctx.globalAlpha = Math.max(part.life, 0);
      ctx.fillStyle = part.color;
      ctx.beginPath();
      ctx.arc(part.x, part.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Ball trail
    for (let i = 0; i < g.trail.length; i++) {
      const t = g.trail[i];
      ctx.globalAlpha = (i / g.trail.length) * 0.35;
      ctx.fillStyle = '#48dbfb';
      ctx.beginPath();
      ctx.arc(t.x, t.y, g.ball.r * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Ball
    const b = g.ball;
    const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r * 3);
    glow.addColorStop(0, 'rgba(255,255,255,0.9)');
    glow.addColorStop(1, 'rgba(72,219,251,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();

    // Paddle
    const p = g.paddle;
    const pGrad = ctx.createLinearGradient(p.x, p.y, p.x + p.w, p.y);
    pGrad.addColorStop(0, '#f38020');
    pGrad.addColorStop(0.5, '#ffb066');
    pGrad.addColorStop(1, '#f38020');
    ctx.fillStyle = pGrad;
    ctx.shadowColor = 'rgba(243,128,32,0.6)';
    ctx.shadowBlur = 14;
    roundRect(ctx, p.x, p.y, p.w, p.h, 6);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ── Controls ───────────────────────────────────────────────────────────
  function setPaddleFromClientX(clientX) {
    if (!game) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    game.paddle.x = Math.min(Math.max(x - game.paddle.w / 2, 0), game.w - game.paddle.w);
  }

  function wireControls() {
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      setPaddleFromClientX(e.clientX);
    });
    canvas.addEventListener('pointermove', (e) => {
      setPaddleFromClientX(e.clientX);
    });

    document.addEventListener('keydown', (e) => {
      if (!game) return;
      const section = document.getElementById(SECTION_ID);
      if (!section || !section.classList.contains('active')) return;
      const step = 28;
      if (e.key === 'ArrowLeft') game.paddle.x = Math.max(game.paddle.x - step, 0);
      if (e.key === 'ArrowRight') game.paddle.x = Math.min(game.paddle.x + step, game.w - game.paddle.w);
      if (e.key === ' ' && game.bricks) {
        e.preventDefault();
        if (!game.running && !game.gameOver) startOrResume();
      }
    });

    window.addEventListener('resize', () => {
      resizeCanvas();
      render();
    });

    document.getElementById('bb-start-btn').addEventListener('click', startOrResume);
    document.getElementById('bb-pause-btn').addEventListener('click', togglePause);
    document.getElementById('bb-restart-btn').addEventListener('click', restartGame);
  }

  function startOrResume() {
    if (!game) return;
    hideOverlay();
    game.running = true;
    game.paused = false;
    document.getElementById('bb-pause-btn').textContent = 'Pause';
  }

  function togglePause() {
    if (!game || !game.running) return;
    game.paused = !game.paused;
    document.getElementById('bb-pause-btn').textContent = game.paused ? 'Resume' : 'Pause';
    if (game.paused) showOverlay('Paused', 'Take a breath.', 'Resume');
    else hideOverlay();
  }

  function restartGame() {
    game = initGameState(0, 0, 3);
    updateHud();
    document.getElementById('bb-pause-btn').textContent = 'Pause';
    showOverlay('Brick Breaker', 'Drag / slide on the board to move the paddle.<br>Or use ← → arrow keys.', 'Start Game');
    render();
  }

  // ── Init ───────────────────────────────────────────────────────────────

  // Patch switchSection FIRST so the canvas resizes correctly when the
  // section becomes visible, and so the game initialises lazily on first visit.
  function patchSwitchSection() {
    if (typeof window.switchSection !== 'function' || window.switchSection._bbPatched) return;
    const original = window.switchSection;
    const patched = function (id) {
      original(id);
      if (id === 'brickbreaker') {
        // If the game hasn't been set up yet (canvas was hidden on load),
        // run setup now that the section is actually visible.
        if (!initialized) {
          setup();
        } else {
          setTimeout(() => { resizeCanvas(); if (game) render(); }, 30);
        }
      }
    };
    patched._bbPatched = true;
    window.switchSection = patched;
  }

  function setup() {
    if (initialized) return;
    // Guard: if DOM targets are missing, don't mark as initialized so we can retry.
    injectStyles();
    injectSidebarButton();
    injectSection();

    canvas = document.getElementById('bb-canvas');
    if (!canvas) return; // section not in DOM yet — bail without setting initialized

    ctx = canvas.getContext('2d');

    resizeCanvas();
    game = initGameState(0, 0, 3);
    updateHud();
    wireControls();
    showOverlay('Brick Breaker', 'Drag / slide on the board to move the paddle.<br>Or use ← → arrow keys.', 'Start Game');
    render();

    rafId = requestAnimationFrame(step);
    initialized = true;
  }

  function init() {
    // Patch switchSection before anything else so clicks work immediately.
    patchSwitchSection();
    // Only run full setup if the sidebar/main are already in the DOM.
    // If not, the patch above will call setup() the first time the user
    // navigates to the brickbreaker section.
    const sidebar = document.querySelector('.sidebar');
    const main = document.querySelector('main.main') || document.querySelector('.main');
    if (sidebar && main) {
      setup();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
