/*
 * Leitor do DXF gerado (R12) para o visualizador.
 * Lê o arquivo em streaming e agrupa a geometria por camada:
 *   segs   Float32Array  x1,y1,x2,y2 ...
 *   solids Float32Array  x1,y1,x2,y2,x3,y3,x4,y4 ... (ordem de contorno)
 *   arcs   Float32Array  cx,cy,r,a0,a1 ... (radianos, anti-horário)
 *   texts  [{x,y,h,rot,t,ah,av}]
 */
(function (root) {
  'use strict';

  const MAX_SEGS = 12e6; // limite de segurança de memória

  function createDxfReader() {
    const layers = new Map(); // nome -> {color, segs:[], solids:[], arcs:[], texts:[]}
    const layerColor = new Map();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let nSegs = 0, truncated = false;
    let section = '', table = '';
    let ent = null;        // entidade em leitura
    let poly = null;       // POLYLINE em andamento
    let code = null;       // código de grupo pendente
    let rest = '';         // linha incompleta do bloco anterior

    function L(name) {
      let l = layers.get(name);
      if (!l) { l = { segs: [], solids: [], arcs: [], texts: [] }; layers.set(name, l); }
      return l;
    }
    function ext(x, y) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    function seg(l, ax, ay, bx, by) {
      if (nSegs >= MAX_SEGS) { truncated = true; return; }
      nSegs++;
      l.segs.push(ax, ay, bx, by);
    }

    function finish(e) {
      if (!e) return;
      const t = e.type;
      if (section === 'TABLES') {
        if (t === 'LAYER' && e[2] !== undefined) layerColor.set(e[2], Math.abs(+e[62] || 7));
        return;
      }
      if (section !== 'ENTITIES') return;
      const layer = e[8] !== undefined ? e[8] : '0';
      const n = (c) => +e[c] || 0;
      switch (t) {
        case 'LINE': {
          const l = L(layer);
          seg(l, n(10), n(20), n(11), n(21)); ext(n(10), n(20)); ext(n(11), n(21));
          break;
        }
        case 'POLYLINE': poly = { layer, closed: (n(70) & 1) === 1, pts: [] }; break;
        case 'VERTEX': if (poly) { poly.pts.push(n(10), n(20)); ext(n(10), n(20)); } break;
        case 'SEQEND':
          if (poly) {
            const l = L(poly.layer), p = poly.pts;
            for (let i = 0; i + 3 < p.length; i += 2) seg(l, p[i], p[i + 1], p[i + 2], p[i + 3]);
            if (poly.closed && p.length >= 6) seg(l, p[p.length - 2], p[p.length - 1], p[0], p[1]);
            poly = null;
          }
          break;
        case 'CIRCLE':
          L(layer).arcs.push(n(10), n(20), n(40), 0, Math.PI * 2);
          ext(n(10) - n(40), n(20) - n(40)); ext(n(10) + n(40), n(20) + n(40));
          break;
        case 'ARC': {
          let a0 = n(50) * Math.PI / 180, a1 = n(51) * Math.PI / 180;
          if (a1 <= a0) a1 += Math.PI * 2;
          L(layer).arcs.push(n(10), n(20), n(40), a0, a1);
          ext(n(10) - n(40), n(20) - n(40)); ext(n(10) + n(40), n(20) + n(40));
          break;
        }
        case 'SOLID': {
          // DXF usa a ordem 1,2,4,3; guardamos em ordem de contorno
          const v = [n(10), n(20), n(11), n(21), n(13), n(23), n(12), n(22)];
          L(layer).solids.push(...v);
          for (let i = 0; i < 8; i += 2) ext(v[i], v[i + 1]);
          break;
        }
        case 'TEXT': {
          const txt = String(e[1] || '').replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
          const ah = n(72), av = n(73);
          const aligned = ah || av;
          const x = aligned ? n(11) : n(10), y = aligned ? n(21) : n(20);
          L(layer).texts.push({ x, y, h: n(40), rot: n(50), t: txt, ah, av });
          ext(x, y);
          break;
        }
      }
    }

    function pair(c, v) {
      if (c === 0) {
        finish(ent);
        ent = { type: v };
        if (v === 'ENDSEC') { section = ''; }
        if (v === 'TABLE') table = '';
        return;
      }
      if (!ent) return;
      if (ent.type === 'SECTION' && c === 2) { section = v; return; }
      if (ent.type === 'TABLE' && c === 2) { table = v; return; }
      ent[c] = v;
    }

    function feed(text) {
      const lines = (rest + text).split('\n');
      rest = lines.pop();
      for (let i = 0; i < lines.length; i++) {
        let s = lines[i];
        if (s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
        if (code === null) code = parseInt(s, 10);
        else { pair(code, code === 1 || code === 2 || code === 8 ? s : s.trim()); code = null; }
      }
    }

    function done() {
      if (rest) feed('\n');
      finish(ent); ent = null;
      if (!isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }
      const out = [];
      const transfer = [];
      for (const [name, l] of layers) {
        const o = {
          name,
          color: layerColor.get(name) || 7,
          segs: new Float32Array(l.segs),
          solids: new Float32Array(l.solids),
          arcs: new Float32Array(l.arcs),
          texts: l.texts
        };
        transfer.push(o.segs.buffer, o.solids.buffer, o.arcs.buffer);
        out.push(o);
      }
      out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return { layers: out, bounds: { minX, minY, maxX, maxY }, truncated, transfer };
    }

    return { feed, done };
  }

  async function readDxf(blob, onProgress) {
    const r = createDxfReader();
    const dec = new TextDecoder('windows-1252');
    const CH = 8 * 1024 * 1024;
    for (let off = 0; off < blob.size; off += CH) {
      r.feed(dec.decode(await blob.slice(off, off + CH).arrayBuffer(), { stream: true }));
      if (onProgress) onProgress(Math.min(1, (off + CH) / blob.size));
    }
    r.feed(dec.decode());
    return r.done();
  }

  root.DxfView = { createDxfReader, readDxf };
})(typeof self !== 'undefined' ? self : globalThis);
