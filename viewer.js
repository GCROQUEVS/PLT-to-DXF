/*
 * Visualizador do DXF exportado: janela ampliada com zoom (roda do mouse / pinça),
 * arrastar para mover, ajustar à tela, camadas e coordenadas do cursor.
 */
(function () {
  'use strict';

  // ---------- Cores ACI ----------
  const ACI_BASE = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 8: '#808080', 9: '#c0c0c0' };
  function aci(c, dark) {
    if (c === 7 || c === 0 || c > 255) return dark ? '#ffffff' : '#000000';
    if (ACI_BASE[c]) return c === 2 && !dark ? '#b8a000' : ACI_BASE[c];
    if (c >= 250) { const g = [51, 80, 105, 130, 190, 255][c - 250]; return 'rgb(' + g + ',' + g + ',' + g + ')'; }
    const h = (((c - 10) / 10) | 0) * 15, k = (c - 10) % 10;
    const v = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][k], s = k % 2 ? 0.5 : 1;
    const f = (n) => { const kk = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1)))); };
    return 'rgb(' + f(5) + ',' + f(3) + ',' + f(1) + ')';
  }

  // ---------- Montagem da janela ----------
  const el = document.createElement('div');
  el.className = 'viewer';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML =
    '<div class="vbar">' +
    '  <div class="vhead"><strong class="vtitle"></strong><span class="vinfo"></span></div>' +
    '  <div class="vtools">' +
    '    <button class="btn small" data-a="out" title="Diminuir zoom (−)" aria-label="Diminuir zoom">−</button>' +
    '    <span class="vzoom">100%</span>' +
    '    <button class="btn small" data-a="in" title="Aumentar zoom (+)" aria-label="Aumentar zoom">+</button>' +
    '    <button class="btn small" data-a="fit" title="Ajustar à tela (0)">Ajustar</button>' +
    '    <button class="btn small" data-a="layers">Camadas</button>' +
    '    <button class="btn small" data-a="bg" title="Fundo claro/escuro">Fundo</button>' +
    '    <a class="btn small primary vdl">Baixar DXF</a>' +
    '    <button class="btn small" data-a="close" title="Fechar (Esc)" aria-label="Fechar">✕</button>' +
    '  </div>' +
    '</div>' +
    '<div class="vstage">' +
    '  <canvas></canvas>' +
    '  <div class="vlayers" hidden></div>' +
    '  <div class="vstatus"></div>' +
    '  <div class="vcoords"></div>' +
    '  <div class="vhint">Roda do mouse ou pinça: zoom · Arrastar: mover · Duplo clique: aproximar</div>' +
    '</div>';
  document.body.appendChild(el);

  const $ = (s) => el.querySelector(s);
  const stage = $('.vstage'), canvas = $('canvas'), ctx = canvas.getContext('2d');
  const status = $('.vstatus'), coords = $('.vcoords'), layersEl = $('.vlayers'), zoomEl = $('.vzoom');
  const snap = document.createElement('canvas'), sctx = snap.getContext('2d');

  let job = null, data = null, unit = 'mm';
  let W = 0, H = 0, dpr = 1;
  let s = 1, tx = 0, ty = 0, fitScale = 1;     // tela = (x*s + tx, -y*s + ty)
  let snapView = null, lastMs = 0, idleTimer = 0, raf = 0;
  let grid = null, stamp = 0;
  let dark = true;
  try { dark = localStorage.getItem('viewerBg') !== 'light'; } catch (e) { /* sem storage */ }
  const hidden = new Set();
  let worker = null, reqId = 0;

  // ---------- Abrir / fechar ----------
  function open(j) {
    job = j;
    $('.vtitle').textContent = j.rel || j.name;
    $('.vinfo').textContent = '';
    const dl = $('.vdl'); dl.href = j.url; dl.download = (j.name || 'desenho.dxf').split(/[\\/]/).pop();
    hidden.clear();
    layersEl.hidden = true;
    unit = (j.stats && j.stats.bounds && j.stats.bounds.unit) || 'mm';
    if (unit === 'pu') unit = 'un';
    el.hidden = false;
    document.documentElement.classList.add('viewer-open');
    resize();
    if (j.viewData) { show(j.viewData); return; }
    data = null;
    clear();
    status.textContent = 'Lendo o DXF…';
    status.hidden = false;
    load(j.blob).then((d) => {
      j.viewData = d;
      if (job === j) show(d);
    }).catch((err) => { status.textContent = 'Não foi possível abrir: ' + err; });
  }

  function close() {
    el.hidden = true;
    document.documentElement.classList.remove('viewer-open');
    job = null; data = null;
  }

  function load(blob) {
    const id = ++reqId;
    const onP = (p) => { if (id === reqId) status.textContent = 'Lendo o DXF… ' + Math.round(p * 100) + '%'; };
    try {
      if (!worker) worker = new Worker('worker.js?v=' + (window.APP_VERSION || ''));
    } catch (e) {
      return window.DxfView.readDxf(blob, onP);
    }
    return new Promise((resolve, reject) => {
      const handler = (e) => {
        const m = e.data;
        if (m.id !== 'v' + id) return;
        if (m.type === 'progress') onP(m.p);
        else { worker.removeEventListener('message', handler); m.type === 'view' ? resolve(m.data) : reject(m.message); }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ id: 'v' + id, type: 'view', blob });
    });
  }

  function show(d) {
    data = d;
    status.hidden = !d.truncated;
    if (d.truncated) status.textContent = 'Desenho muito grande: parte da geometria não é mostrada no visualizador (o DXF está completo).';
    const b = d.bounds;
    $('.vinfo').textContent = fmt(b.maxX - b.minX) + ' × ' + fmt(b.maxY - b.minY) + ' ' + unit;
    buildLayers();
    fit();
  }

  // ---------- Camadas ----------
  function buildLayers() {
    layersEl.innerHTML = '';
    for (const l of data.layers) {
      const n = l.segs.length / 4 + l.solids.length / 8 + l.arcs.length / 5 + l.texts.length;
      const row = document.createElement('label');
      row.innerHTML = '<input type="checkbox" checked><span class="sw"></span><span class="ln"></span><span class="lc"></span>';
      row.querySelector('.sw').style.background = aci(l.color, true);
      row.querySelector('.ln').textContent = l.name;
      row.querySelector('.lc').textContent = n.toLocaleString('pt-BR');
      row.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) hidden.delete(l.name); else hidden.add(l.name);
        draw();
      });
      layersEl.appendChild(row);
    }
  }

  // ---------- Vista ----------
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = stage.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width * dpr)), nh = Math.max(1, Math.round(r.height * dpr));
    if (nw === W && nh === H) return;
    // mantém o centro da vista
    const cx = (W / 2 - tx) / s, cy = (ty - H / 2) / s;
    W = canvas.width = snap.width = nw;
    H = canvas.height = snap.height = nh;
    if (data) { tx = W / 2 - cx * s; ty = H / 2 + cy * s; draw(); }
  }

  function fit() {
    if (!data) return;
    const b = data.bounds;
    const bw = (b.maxX - b.minX) || 1, bh = (b.maxY - b.minY) || 1;
    s = fitScale = Math.min(W * 0.94 / bw, H * 0.94 / bh);
    tx = W / 2 - (b.minX + bw / 2) * s;
    ty = H / 2 + (b.minY + bh / 2) * s;
    draw();
  }

  function zoomAt(f, px, py) {
    if (!data) return;
    const ns = Math.max(fitScale / 20, Math.min(fitScale * 200000, s * f));
    f = ns / s;
    tx = px - (px - tx) * f;
    ty = py - (py - ty) * f;
    s = ns;
    request();
  }

  function clear() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = dark ? '#1f232a' : '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }

  // Desenho rápido durante a interação: reaproveita a última imagem completa
  function quick() {
    clear();
    if (!snapView) return;
    const k = s / snapView.s;
    ctx.drawImage(snap, tx - snapView.tx * k, ty - snapView.ty * k, W * k, H * k);
  }

  function request() {
    zoomEl.textContent = fmtZoom();
    if (lastMs < 35) {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
      return;
    }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; quick(); });
    clearTimeout(idleTimer);
    idleTimer = setTimeout(draw, 160);
  }

  // ---------- Desenho completo ----------
  function draw() {
    if (!data) { clear(); return; }
    const t0 = performance.now();
    zoomEl.textContent = fmtZoom();
    clear();
    const x0 = -tx / s, x1 = (W - tx) / s, y0 = (ty - H) / s, y1 = ty / s;
    const px = 1 / s; // 1 pixel em unidades do desenho
    ctx.setTransform(s, 0, 0, -s, tx, ty);
    ctx.lineWidth = Math.max(1, dpr * 0.9) * px;
    ctx.lineJoin = 'round';

    // Nível de detalhe: o que é menor que um pixel vira um ponto, sem repetir o mesmo pixel
    if (!grid || grid.length !== W * H) grid = new Uint32Array(W * H);
    const tiny = 2 * px;
    const dot = (wx, wy) => {
      const sx = (wx * s + tx) | 0, sy = (ty - wy * s) | 0;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) return false;
      const k = sy * W + sx;
      if (grid[k] === stamp) return false;
      grid[k] = stamp;
      return true;
    };

    for (const l of data.layers) {
      if (hidden.has(l.name)) continue;
      const col = aci(l.color, dark);
      ctx.strokeStyle = col; ctx.fillStyle = col;
      if (++stamp >= 0xFFFFFFFF) { stamp = 1; grid.fill(0); }
      const dots = [];

      // Preenchimentos (SOLID)
      const so = l.solids;
      if (so.length) {
        ctx.beginPath();
        let n = 0;
        for (let i = 0; i < so.length; i += 8) {
          let ax = so[i], bx = ax, ay = so[i + 1], by = ay;
          for (let j = 2; j < 8; j += 2) {
            const vx = so[i + j], vy = so[i + j + 1];
            if (vx < ax) ax = vx; else if (vx > bx) bx = vx;
            if (vy < ay) ay = vy; else if (vy > by) by = vy;
          }
          if (bx < x0 || ax > x1 || by < y0 || ay > y1) continue;
          if (bx - ax < tiny && by - ay < tiny) { if (dot(ax, ay)) dots.push(ax, ay, bx - ax, by - ay); continue; }
          ctx.moveTo(so[i], so[i + 1]); ctx.lineTo(so[i + 2], so[i + 3]); ctx.lineTo(so[i + 4], so[i + 5]); ctx.lineTo(so[i + 6], so[i + 7]);
          ctx.closePath();
          if (++n === 20000) { ctx.fill(); ctx.beginPath(); n = 0; }
        }
        ctx.fill();
      }

      // Linhas
      const sg = l.segs;
      if (sg.length) {
        ctx.beginPath();
        let n = 0;
        for (let i = 0; i < sg.length; i += 4) {
          const ax = sg[i], ay = sg[i + 1], bx = sg[i + 2], by = sg[i + 3];
          if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (ay < y0 && by < y0) || (ay > y1 && by > y1)) continue;
          if (Math.abs(bx - ax) < tiny && Math.abs(by - ay) < tiny) { if (dot(ax, ay)) dots.push(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)); continue; }
          ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
          if (++n === 50000) { ctx.stroke(); ctx.beginPath(); n = 0; }
        }
        ctx.stroke();
      }

      // Círculos e arcos
      const ar = l.arcs;
      if (ar.length) {
        ctx.beginPath();
        for (let i = 0; i < ar.length; i += 5) {
          const cx = ar[i], cy = ar[i + 1], r = ar[i + 2];
          if (cx + r < x0 || cx - r > x1 || cy + r < y0 || cy - r > y1) continue;
          if (r < tiny / 2) { if (dot(cx, cy)) dots.push(cx - r, cy - r, 2 * r, 2 * r); continue; }
          ctx.moveTo(cx + r * Math.cos(ar[i + 3]), cy + r * Math.sin(ar[i + 3]));
          ctx.arc(cx, cy, r, ar[i + 3], ar[i + 4], false);
        }
        ctx.stroke();
      }

      // Pontos (elementos menores que um pixel)
      if (dots.length) {
        ctx.beginPath();
        for (let i = 0; i < dots.length; i += 4) ctx.rect(dots[i], dots[i + 1], Math.max(px, dots[i + 2]), Math.max(px, dots[i + 3]));
        ctx.fill();
      }
    }

    // Textos editáveis (desenhados em coordenadas de tela)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const l of data.layers) {
      if (hidden.has(l.name) || !l.texts.length) continue;
      ctx.fillStyle = aci(l.color, dark);
      for (const t of l.texts) {
        const hp = t.h * s;
        if (hp < 2.5) continue;
        const reach = t.h * (t.t.length + 2);
        if (t.x + reach < x0 || t.x - reach > x1 || t.y + reach < y0 || t.y - reach > y1) continue;
        ctx.save();
        ctx.translate(t.x * s + tx, -t.y * s + ty);
        if (t.rot) ctx.rotate(-t.rot * Math.PI / 180);
        ctx.font = (hp / 0.72).toFixed(1) + 'px Arial, Helvetica, sans-serif';
        ctx.textAlign = t.ah === 1 || t.ah === 4 ? 'center' : t.ah === 2 ? 'right' : 'left';
        ctx.textBaseline = t.av === 2 ? 'middle' : t.av === 3 ? 'top' : 'alphabetic';
        ctx.fillText(t.t, 0, 0);
        ctx.restore();
      }
    }

    // guarda a imagem para o desenho rápido
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(canvas, 0, 0);
    snapView = { s, tx, ty };
    lastMs = performance.now() - t0;
  }

  // ---------- Interação ----------
  const pointers = new Map();
  let pinch = null;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const f = Math.min(2, Math.max(0.5, Math.exp(-d * 0.0018)));
    zoomAt(f, (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinch = pinchState();
    canvas.classList.add('grabbing');
  });

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * dpr, my = (e.clientY - r.top) * dpr;
    if (data) coords.textContent = 'X ' + fmt((mx - tx) / s) + '   Y ' + fmt((ty - my) / s) + ' ' + unit;
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      const dx = (e.clientX - p.x) * dpr, dy = (e.clientY - p.y) * dpr;
      tx += dx; ty += dy;
      p.x = e.clientX; p.y = e.clientY;
      request();
    } else if (pointers.size === 2 && pinch) {
      p.x = e.clientX; p.y = e.clientY;
      const now = pinchState();
      tx += (now.cx - pinch.cx) * dpr; ty += (now.cy - pinch.cy) * dpr;
      zoomAt(now.d / pinch.d, (now.cx - r.left) * dpr, (now.cy - r.top) * dpr);
      pinch = now;
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    pinch = pointers.size === 2 ? pinchState() : null;
    if (!pointers.size) canvas.classList.remove('grabbing');
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { coords.textContent = ''; });

  function pinchState() {
    const [a, b] = Array.from(pointers.values());
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  }

  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    zoomAt(e.shiftKey ? 0.5 : 2, (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
  });

  el.querySelector('.vtools').addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]');
    if (!a) return;
    switch (a.dataset.a) {
      case 'in': zoomAt(1.6, W / 2, H / 2); break;
      case 'out': zoomAt(1 / 1.6, W / 2, H / 2); break;
      case 'fit': fit(); break;
      case 'layers': layersEl.hidden = !layersEl.hidden; break;
      case 'bg':
        dark = !dark;
        try { localStorage.setItem('viewerBg', dark ? 'dark' : 'light'); } catch (err) { /* sem storage */ }
        stage.classList.toggle('light', !dark);
        draw();
        break;
      case 'close': close(); break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (el.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === '+' || e.key === '=') zoomAt(1.6, W / 2, H / 2);
    else if (e.key === '-') zoomAt(1 / 1.6, W / 2, H / 2);
    else if (e.key === '0') fit();
  });

  if (window.ResizeObserver) new ResizeObserver(() => { if (!el.hidden) resize(); }).observe(stage);
  else window.addEventListener('resize', () => { if (!el.hidden) resize(); });
  stage.classList.toggle('light', !dark);

  // ---------- Utilidades ----------
  function fmt(n) { return n.toLocaleString('pt-BR', { maximumFractionDigits: Math.abs(n) < 10 ? 3 : 2 }); }
  function fmtZoom() {
    const z = s / fitScale * 100;
    return z.toLocaleString('pt-BR', { maximumFractionDigits: z < 10 ? 1 : 0, useGrouping: false }) + '%';
  }

  // Aproxima para um retângulo do desenho (unidades do DXF)
  function zoomTo(ax, ay, bx, by) {
    const w = Math.abs(bx - ax) || 1, h = Math.abs(by - ay) || 1;
    s = Math.min(W / w, H / h);
    tx = W / 2 - (ax + bx) / 2 * s;
    ty = H / 2 + (ay + by) / 2 * s;
    draw();
    return lastMs;
  }

  window.DxfViewer = { open, close, zoomTo };
})();
