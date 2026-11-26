(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const drop = $('drop'), list = $('list'), toolbar = $('toolbar'), summary = $('summary');
  const PLT_EXT = /\.(plt|hpgl|hpg|plo|hgl|prn)$/i;

  const jobs = [];       // {id, file, name, el, status, blob, url, stats}
  const queue = [];
  let nextId = 1;

  // ---------- Pool de workers ----------
  const POOL = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const workers = [];
  let useWorkers = true;
  try {
    for (let i = 0; i < POOL; i++) {
      const w = new Worker('worker.js?v=' + (window.APP_VERSION || ''));
      w.busy = false;
      w.onmessage = (e) => onWorkerMessage(w, e.data);
      w.onerror = (e) => { e.preventDefault(); if (w.job) fail(w.job, 'Erro no processamento'); w.busy = false; w.job = null; pump(); };
      workers.push(w);
    }
  } catch (e) {
    useWorkers = false; // ex.: aberto via file:// — processa na thread principal
  }

  function options() {
    const r = $('optRes').value;
    const upm = r === 'custom' ? parseFloat($('optCustom').value) : parseFloat(r);
    return {
      unitsPerMM: upm > 0 ? upm : 40,
      outUnit: $('optUnit').value,
      previewLimit: $('optPreview').checked ? 200000 : 0,
      textAsLines: $('optTextLines').checked,
      textStyle: $('optTextStyle').value,
      textWeight: parseFloat($('optTextWeight').value),
      charset: $('optCharset').value
    };
  }

  // Opções de texto: lembradas entre visitas
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* sem storage */ } }
  };
  function syncTextUI() {
    $('textSub').hidden = !$('optTextLines').checked;
    $('weightWrap').hidden = $('optTextStyle').value === 'simple';
    $('weightVal').textContent = $('optTextWeight').value;
  }
  $('optTextLines').checked = store.get('textAsLines') === '1';
  if (store.get('textStyle')) $('optTextStyle').value = store.get('textStyle');
  if (store.get('textWeight')) $('optTextWeight').value = store.get('textWeight');
  if (!$('optTextStyle').value) $('optTextStyle').value = 'filled';
  syncTextUI();
  $('optTextLines').addEventListener('change', () => { store.set('textAsLines', $('optTextLines').checked ? '1' : '0'); syncTextUI(); });
  $('optTextStyle').addEventListener('change', () => { store.set('textStyle', $('optTextStyle').value); syncTextUI(); });
  $('optTextWeight').addEventListener('input', () => { store.set('textWeight', $('optTextWeight').value); syncTextUI(); });

  $('optRes').addEventListener('change', () => { $('customWrap').hidden = $('optRes').value !== 'custom'; });

  // ---------- Entrada de arquivos ----------
  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files, true); e.target.value = ''; });
  $('dirInput').addEventListener('change', (e) => { addFiles(e.target.files, false); e.target.value = ''; });

  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  drop.addEventListener('drop', async (e) => {
    const items = e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      const entries = Array.from(items).map((it) => it.webkitGetAsEntry()).filter(Boolean);
      const files = [];
      for (const en of entries) await walk(en, '', files);
      addFiles(files, false);
    } else {
      addFiles(e.dataTransfer.files, false);
    }
  });

  async function walk(entry, path, out) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      f._path = path + f.name;
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const ch of batch) await walk(ch, path + entry.name + '/', out);
      } while (batch.length);
    }
  }

  function addFiles(fileList, acceptAll) {
    const files = Array.from(fileList).filter((f) => acceptAll || PLT_EXT.test(f.name));
    if (!files.length) return;
    const frag = document.createDocumentFragment();
    for (const file of files) {
      const rel = file._path || file.webkitRelativePath || file.name;
      const job = { id: nextId++, file, rel, name: rel.replace(/\.[^./\\]+$/, '') + '.dxf', status: 'queued' };
      job.el = renderItem(job);
      frag.appendChild(job.el.root);
      jobs.push(job);
      queue.push(job);
    }
    list.appendChild(frag);
    toolbar.hidden = false;
    updateSummary();
    pump();
  }

  // ---------- Fila ----------
  let mainBusy = false;
  function pump() {
    if (useWorkers) {
      for (const w of workers) {
        if (w.busy || !queue.length) continue;
        const job = queue.shift();
        w.busy = true; w.job = job;
        start(job);
        w.postMessage({ id: job.id, file: job.file, options: options() });
      }
    } else if (!mainBusy && queue.length) {
      const job = queue.shift();
      mainBusy = true;
      start(job);
      window.PltDxf.convertFile(job.file, options(), (p) => progress(job, p))
        .then((r) => done(job, r.blob, r.stats, r.preview))
        .catch((err) => fail(job, String(err && err.message || err)))
        .finally(() => { mainBusy = false; setTimeout(pump, 0); });
    }
  }

  function onWorkerMessage(w, m) {
    const job = jobs.find((j) => j.id === m.id);
    if (!job) return;
    if (m.type === 'progress') { progress(job, m.p); return; }
    if (m.type === 'done') done(job, m.blob, m.stats, m.preview);
    else fail(job, m.message);
    w.busy = false; w.job = null;
    pump();
  }

  function start(job) {
    job.status = 'running';
    job.t0 = performance.now();
    job.el.detail.textContent = 'Convertendo…';
    job.el.detail.className = 'detail';
  }

  function progress(job, p) {
    job.el.bar.style.width = (p * 100).toFixed(1) + '%';
  }

  function done(job, blob, stats, preview) {
    job.status = 'done';
    job.blob = blob; job.stats = stats;
    job.url = URL.createObjectURL(blob);
    const secs = ((performance.now() - job.t0) / 1000).toFixed(1);
    const b = stats.bounds;
    const u = b.unit === 'pu' ? 'un' : b.unit;
    const parts = [];
    const nEnt = stats.polylines + stats.lines + stats.circles + stats.arcs + stats.solids + (stats.textAsLines ? 0 : stats.texts);
    parts.push(nEnt.toLocaleString('pt-BR') + ' entidades');
    if (stats.texts) parts.push(stats.texts.toLocaleString('pt-BR') + (stats.textAsLines ? ' textos em linhas' : ' textos editáveis'));
    parts.push(fmtNum(b.maxX - b.minX) + ' × ' + fmtNum(b.maxY - b.minY) + ' ' + u);
    parts.push(stats.layers.length + (stats.layers.length === 1 ? ' camada' : ' camadas'));
    parts.push(fmtSize(blob.size));
    parts.push(secs + ' s');
    let txt = parts.join(' · ');
    if (stats.unsupported.length) txt += ' · ignorados: ' + stats.unsupported.join(', ');
    if (stats.unknownChars && stats.unknownChars.length) txt += ' · caracteres não reconhecidos (viraram ?): ' + stats.unknownChars.join(', ') + ' — tente outra codificação nas opções';
    if (nEnt === 0) { txt = 'Nenhuma geometria encontrada — o arquivo é mesmo HPGL/PLT? ' + txt; job.el.detail.className = 'detail err'; }
    else job.el.detail.className = 'detail ok';
    job.el.detail.textContent = txt;
    job.el.bar.style.width = '100%';
    job.el.bar.parentElement.hidden = true;
    const a = job.el.dl;
    a.href = job.url; a.download = baseName(job.name);
    a.removeAttribute('aria-disabled'); a.classList.remove('disabled');
    a.hidden = false;
    job.el.vw.hidden = false;
    job.el.root.classList.add('viewable');
    if (preview && preview.length) drawPreview(job.el.canvas, preview);
    else job.el.root.classList.add('nopreview');
    updateSummary();
  }

  function fail(job, msg) {
    job.status = 'error';
    job.el.detail.textContent = 'Erro: ' + msg;
    job.el.detail.className = 'detail err';
    job.el.bar.parentElement.hidden = true;
    job.el.root.classList.add('nopreview');
    updateSummary();
  }

  // ---------- UI ----------
  function renderItem(job) {
    const root = document.createElement('li');
    root.className = 'item' + ($('optPreview').checked ? '' : ' nopreview');
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 160;
    const meta = document.createElement('div'); meta.className = 'meta';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = job.rel; name.title = job.rel;
    const detail = document.createElement('div'); detail.className = 'detail'; detail.textContent = fmtSize(job.file.size) + ' · na fila';
    const barWrap = document.createElement('div'); barWrap.className = 'bar';
    const bar = document.createElement('span'); barWrap.appendChild(bar);
    meta.append(name, detail, barWrap);
    const acts = document.createElement('div'); acts.className = 'acts';
    const vw = document.createElement('button'); vw.className = 'btn small'; vw.textContent = 'Visualizar'; vw.hidden = true;
    const dl = document.createElement('a'); dl.className = 'btn small'; dl.textContent = 'Baixar DXF'; dl.hidden = true;
    acts.append(vw, dl);
    root.append(canvas, meta, acts);
    const openViewer = () => { if (job.status === 'done' && window.DxfViewer) window.DxfViewer.open(job); };
    vw.addEventListener('click', openViewer);
    canvas.addEventListener('click', openViewer);
    canvas.title = 'Clique para ampliar';
    return { root, canvas, detail, bar, dl, vw };
  }

  function drawPreview(canvas, seg) {
    const ctx = canvas.getContext('2d');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < seg.length; i += 2) {
      const x = seg[i], y = seg[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const W = canvas.width, H = canvas.height, pad = 10;
    const s = Math.min((W - 2 * pad) / ((maxX - minX) || 1), (H - 2 * pad) / ((maxY - minY) || 1));
    const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--preview-line').trim() || '#93c5fd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < seg.length; i += 4) {
      ctx.moveTo(ox + (seg[i] - minX) * s, H - oy - (seg[i + 1] - minY) * s);
      ctx.lineTo(ox + (seg[i + 2] - minX) * s, H - oy - (seg[i + 3] - minY) * s);
    }
    ctx.stroke();
  }

  function updateSummary() {
    const d = jobs.filter((j) => j.status === 'done').length;
    const e = jobs.filter((j) => j.status === 'error').length;
    const total = jobs.length;
    let t = d + ' de ' + total + ' convertidos';
    if (e) t += ' · ' + e + ' com erro';
    summary.textContent = t;
    $('btnZip').disabled = d === 0;
    $('btnFolder').disabled = d === 0;
  }

  // ---------- Downloads em lote ----------
  if (window.showDirectoryPicker) $('btnFolder').hidden = false;

  $('btnFolder').addEventListener('click', async () => {
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { return; }
    const btn = $('btnFolder'); const label = btn.textContent; btn.disabled = true;
    const ready = jobs.filter((j) => j.status === 'done');
    let n = 0;
    for (const j of ready) {
      btn.textContent = 'Salvando ' + (++n) + '/' + ready.length + '…';
      const parts = j.name.split(/[\\/]/);
      let d = dir;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
      const ws = await fh.createWritable();
      await ws.write(j.blob); await ws.close();
    }
    btn.textContent = label; btn.disabled = false;
  });

  $('btnZip').addEventListener('click', async () => {
    const ready = jobs.filter((j) => j.status === 'done');
    if (!ready.length) return;
    if (ready.length === 1) { ready[0].el.dl.click(); return; }
    if (!window.JSZip) { alert('Não foi possível carregar o gerador de ZIP. Baixe os arquivos individualmente.'); return; }
    const btn = $('btnZip'); const label = btn.textContent; btn.disabled = true;
    const zip = new window.JSZip();
    const used = new Set();
    for (const j of ready) {
      let name = j.name, i = 1;
      while (used.has(name)) name = j.name.replace(/\.dxf$/, '') + ' (' + (i++) + ').dxf';
      used.add(name);
      zip.file(name, j.blob);
    }
    try {
      const out = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true },
        (m) => { btn.textContent = 'Compactando ' + m.percent.toFixed(0) + '%'; });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(out); a.download = 'dxf-convertidos.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch (e) {
      alert('Memória insuficiente para gerar o ZIP. Use "Salvar todos em uma pasta" ou baixe individualmente.');
    }
    btn.textContent = label; btn.disabled = false;
  });

  $('btnClear').addEventListener('click', () => {
    queue.length = 0;
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (jobs[i].status !== 'running') {
        if (jobs[i].url) URL.revokeObjectURL(jobs[i].url);
        jobs[i].viewData = null;
        jobs[i].el.root.remove(); jobs.splice(i, 1);
      }
    }
    if (!jobs.length) toolbar.hidden = true;
    updateSummary();
  });

  // ---------- Utilidades ----------
  function baseName(p) { return p.split(/[\\/]/).pop(); }
  function fmtSize(b) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toLocaleString('pt-BR', { maximumFractionDigits: i ? 1 : 0 }) + ' ' + u[i];
  }
  function fmtNum(n) { return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 }); }
})();
