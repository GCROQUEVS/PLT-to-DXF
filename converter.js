/*
 * Conversor HPGL/HPGL-2 (.plt) -> DXF (R12 / AC1009)
 * Roda 100% no navegador (Web Worker ou thread principal) e também no Node.
 * Processa o arquivo em streaming, caractere a caractere, sem limite de tamanho.
 */
(function (root) {
  'use strict';

  // Cores ACI por caneta: 1=branco/preto, 2=vermelho, 3=verde, 4=azul, ...
  const ACI = [7, 1, 3, 5, 2, 6, 4, 8, 9, 30, 140, 200, 40, 90, 160, 220];

  // Comandos reconhecidos mas que não geram geometria
  const IGNORED = new Set([
    'LT', 'VS', 'FS', 'PW', 'WU', 'NP', 'PC', 'CO', 'BP', 'PS', 'RO', 'PG', 'EC',
    'IW', 'OP', 'OI', 'OS', 'OE', 'OH', 'OW', 'OA', 'OC', 'OD', 'OF', 'OG', 'OL',
    'OO', 'MC', 'MG', 'PP', 'QL', 'FT', 'LA', 'SM', 'SA', 'SS', 'SL',
    'ES', 'CP', 'TR', 'AC', 'AF', 'AH', 'AP', 'CT', 'DC', 'DP', 'IM', 'CV', 'GC',
    'KY', 'PM', 'EP', 'FP', 'SB', 'SD', 'AD', 'NR', 'BL', 'TD', 'UL', 'WG',
    'EW', 'CC', 'CM', 'CR', 'DL', 'DS', 'DV', 'FI', 'FN', 'IV', 'LM', 'MT', 'PB',
    'RF', 'SG', 'SV', 'TL', 'XT', 'YT', 'ZZ', 'PT', 'GM', 'MV', 'EM', 'BR', 'BZ'
  ]);

  function fmt(n) {
    if (!isFinite(n)) n = 0;
    let s = n.toFixed(4);
    if (s.indexOf('.') >= 0) {
      let e = s.length;
      while (s.charCodeAt(e - 1) === 48) e--;
      if (s.charCodeAt(e - 1) === 46) e--;
      s = s.slice(0, e);
    }
    return s === '-0' ? '0' : s;
  }

  function dxfText(t) {
    let out = '';
    for (const ch of t) {
      const c = ch.codePointAt(0);
      if (c < 32) continue;
      if (c > 126) out += '\\U+' + c.toString(16).toUpperCase().padStart(4, '0');
      else out += ch;
    }
    return out;
  }

  function createConverter(opts) {
    const o = Object.assign({ unitsPerMM: 40, outUnit: 'mm', previewLimit: 250000, textAsLines: false, textStyle: 'filled', textWeight: 10, charset: 'auto' }, opts || {});
    const upm = o.unitsPerMM > 0 ? o.unitsPerMM : 40;
    const k = o.outUnit === 'in' ? 1 / (upm * 25.4) : o.outUnit === 'pu' ? 1 : 1 / upm;

    // ---------- Escrita do DXF (em blocos de ~1 MB) ----------
    const chunks = [];
    let cur = [];
    let curLen = 0;
    // Blobs podem ser paginados em disco pelo navegador, liberando memória do JS
    const pushChunk = (str) => chunks.push(typeof Blob !== 'undefined' ? new Blob([str]) : str);
    function w(s) {
      cur.push(s);
      curLen += s.length;
      if (curLen > 1048576) { pushChunk(cur.join('')); cur = []; curLen = 0; }
    }

    const layers = new Map();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function ext(px, py) {
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    const stats = { polylines: 0, lines: 0, circles: 0, arcs: 0, solids: 0, texts: 0, commands: 0, points: 0, unsupported: [] };
    const unsupported = new Set();

    // Pré-visualização: segmentos x1,y1,x2,y2 (unidades de plotter)
    const prev = [];
    let prevCount = 0, prevTruncated = false;
    function pseg(ax, ay, bx, by) {
      if (prevCount >= o.previewLimit) { prevTruncated = true; return; }
      prev.push(ax, ay, bx, by); prevCount++;
    }

    function layerName() {
      const n = pen | 0;
      const name = 'PEN' + n;
      if (!layers.has(name)) layers.set(name, n <= 0 ? 7 : ACI[(n - 1) % ACI.length]);
      return name;
    }

    function emitPoly(pts, layer) {
      let n = pts.length;
      if (n < 4) return;
      let closed = false;
      if (n >= 8 && pts[0] === pts[n - 2] && pts[1] === pts[n - 1]) { closed = true; n -= 2; }
      for (let i = 0; i < pts.length - 2; i += 2) pseg(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
      if (n === 4) {
        stats.lines++;
        const ax = pts[0] * k, ay = pts[1] * k, bx = pts[2] * k, by = pts[3] * k;
        ext(ax, ay); ext(bx, by);
        w('0\nLINE\n8\n' + layer + '\n10\n' + fmt(ax) + '\n20\n' + fmt(ay) + '\n30\n0\n11\n' + fmt(bx) + '\n21\n' + fmt(by) + '\n31\n0\n');
        return;
      }
      stats.polylines++;
      w('0\nPOLYLINE\n8\n' + layer + '\n66\n1\n10\n0\n20\n0\n30\n0\n70\n' + (closed ? 1 : 0) + '\n');
      for (let i = 0; i < n; i += 2) {
        const px = pts[i] * k, py = pts[i + 1] * k;
        ext(px, py);
        w('0\nVERTEX\n8\n' + layer + '\n10\n' + fmt(px) + '\n20\n' + fmt(py) + '\n30\n0\n');
      }
      w('0\nSEQEND\n8\n' + layer + '\n');
    }

    function previewArc(cx, cy, r, a0, sweep) {
      const steps = Math.max(8, Math.min(180, Math.ceil(Math.abs(sweep) / 5)));
      let px = cx + r * Math.cos(a0 * Math.PI / 180), py = cy + r * Math.sin(a0 * Math.PI / 180);
      for (let i = 1; i <= steps; i++) {
        const a = (a0 + sweep * i / steps) * Math.PI / 180;
        const nx = cx + r * Math.cos(a), ny = cy + r * Math.sin(a);
        pseg(px, py, nx, ny); px = nx; py = ny;
      }
    }

    function emitCircle(cx, cy, r) {
      if (!(r > 0)) return;
      stats.circles++;
      previewArc(cx, cy, r, 0, 360);
      const X = cx * k, Y = cy * k, R = r * k;
      ext(X - R, Y - R); ext(X + R, Y + R);
      w('0\nCIRCLE\n8\n' + layerName() + '\n10\n' + fmt(X) + '\n20\n' + fmt(Y) + '\n30\n0\n40\n' + fmt(R) + '\n');
    }

    function emitArc(cx, cy, r, a0, sweep) {
      if (!(r > 0) || sweep === 0) return;
      if (Math.abs(sweep) >= 360) { emitCircle(cx, cy, r); return; }
      stats.arcs++;
      previewArc(cx, cy, r, a0, sweep);
      let s = sweep > 0 ? a0 : a0 + sweep;
      let e = sweep > 0 ? a0 + sweep : a0;
      s = ((s % 360) + 360) % 360; e = ((e % 360) + 360) % 360;
      const X = cx * k, Y = cy * k, R = r * k;
      ext(X - R, Y - R); ext(X + R, Y + R);
      w('0\nARC\n8\n' + layerName() + '\n10\n' + fmt(X) + '\n20\n' + fmt(Y) + '\n30\n0\n40\n' + fmt(R) + '\n50\n' + fmt(s) + '\n51\n' + fmt(e) + '\n');
    }

    // Preenchimento sólido (SOLID do DXF R12). Cantos em ordem de contorno; o SOLID usa 1,2,4,3.
    function emitSolid(c, layer) {
      stats.solids++;
      const v = [c[0], c[1], c[2], c[3], c[6], c[7], c[4], c[5]];
      let e = '0\nSOLID\n8\n' + layer + '\n';
      for (let i = 0; i < 4; i++) {
        const px = v[i * 2] * k, py = v[i * 2 + 1] * k;
        ext(px, py);
        e += (10 + i) + '\n' + fmt(px) + '\n' + (20 + i) + '\n' + fmt(py) + '\n' + (30 + i) + '\n0\n';
      }
      w(e);
    }

    // Transforma cada segmento de um traço em uma forma retangular fechada de espessura t
    // (com pontas estendidas t/2 para cobrir as junções), opcionalmente com preenchimento sólido.
    function strokeShapes(pts, t, layer) {
      const h = t / 2;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
        let dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
        const nx = -dy * h, ny = dx * h, ex = dx * h, ey = dy * h;
        const c = [
          ax - ex + nx, ay - ey + ny,
          bx + ex + nx, by + ey + ny,
          bx + ex - nx, by + ey - ny,
          ax - ex - nx, ay - ey - ny
        ];
        emitPoly(c.concat(c[0], c[1]), layer);
        if (o.textStyle === 'filled') emitSolid(c, layer);
      }
    }

    // Traços dos acentos, em coordenadas da fonte (c = centro do glifo, t = topo do acento)
    function accentStrokes(mark, c, t) {
      switch (mark) {
        case 0x301: return [[c - 1, t, c + 2, t - 3]];                                  // agudo
        case 0x300: return [[c - 2, t - 3, c + 1, t]];                                  // grave
        case 0x302: return [[c - 3, t, c, t - 3, c + 3, t]];                            // circunflexo
        case 0x303: return [[c - 3, t - 1, c - 1.5, t - 2.5, c + 1.5, t - 0.5, c + 3, t - 2]]; // til
        case 0x308: return [[c - 2.5, t - 1, c - 2.5, t - 2], [c + 2.5, t - 1, c + 2.5, t - 2]]; // trema
        case 0x30A: return [[c - 1, t - 3, c + 1, t - 3, c + 1.5, t - 1.5, c + 1, t, c - 1, t, c - 1.5, t - 1.5, c - 1, t - 3]]; // anel
        case 0x327: return [[c, 22, c, 24, c + 2, 25, c, 27, c - 2, 27]];               // cedilha
      }
      return [];
    }
    const DEGREE = [8, [[3, 1, 1, 2, 0, 4, 1, 6, 3, 7, 5, 6, 6, 4, 5, 2, 3, 1]]];

    // Retorna os traços de um caractere: {adv, strokes:[[x,y,...]]} em coordenadas da fonte
    function glyph(ch) {
      const font = root.HERSHEY_SIMPLEX;
      const code = ch.codePointAt(0);
      if (font[code]) return { adv: font[code][0], strokes: font[code][1] };
      if (ch === '°' || ch === 'º' || ch === 'ª') return { adv: DEGREE[0], strokes: DEGREE[1] };
      const nfd = ch.normalize('NFD');
      const base = nfd[0], bc = base.codePointAt(0);
      if (nfd.length > 1 && font[bc]) {
        const adv = font[bc][0];
        let strokes = font[bc][1];
        if (base === 'i' || base === 'j') strokes = strokes.filter((s) => Math.max(...s.filter((_, i) => i % 2)) >= 8);
        strokes = strokes.slice();
        const top = (bc >= 65 && bc <= 90) ? -1 : 6;
        for (let m = 1; m < nfd.length; m++) strokes.push(...accentStrokes(nfd.codePointAt(m), adv / 2, top));
        return { adv, strokes };
      }
      const ex = extraGlyph(code);
      if (ex) return ex;
      unknownChars.add(code);
      return { adv: font[63][0], strokes: font[63][1] }; // '?'
    }

    // Símbolos montados a partir de outros glifos
    function extraGlyph(code) {
      const font = root.HERSHEY_SIMPLEX, extra = root.HERSHEY_EXTRA || {};
      if (extra[code]) return { adv: extra[code][0], strokes: extra[code][1] };
      const slashed = (bc) => {
        const st = font[bc][1];
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const s of st) for (let i = 0; i < s.length; i += 2) {
          x0 = Math.min(x0, s[i]); x1 = Math.max(x1, s[i]); y0 = Math.min(y0, s[i + 1]); y1 = Math.max(y1, s[i + 1]);
        }
        return { adv: font[bc][0], strokes: st.concat([[x0 - 1, y1 + 2, x1 + 1, y0 - 2]]) };
      };
      const small = (bc) => ({
        adv: Math.round(font[bc][0] * 0.6) + 2,
        strokes: font[bc][1].map((s) => s.map((v, i) => (i % 2 ? v * 0.6 - 1 : v * 0.6 + 1)))
      });
      switch (code) {
        case 0xD8: case 0x2205: case 0x2300: return slashed(79);   // Ø ∅ ⌀ (diâmetro)
        case 0xF8: return slashed(111);                            // ø
        case 0xB9: return small(49);                               // ¹
        case 0xB2: return small(50);                               // ²
        case 0xB3: return small(51);                               // ³
        case 0xB1: return { adv: 26, strokes: [[13, 5, 13, 17], [5, 11, 21, 11], [5, 21, 21, 21]] }; // ±
        case 0xB7: case 0x2219: return { adv: 10, strokes: [[5, 11, 5, 12]] };                       // ·
        case 0xA0: return { adv: 16, strokes: [] };                // espaço não separável
      }
      return null;
    }

    // A entrada pode vir decodificada como Windows-1252 (0x80-0x9F viram outros códigos); volta ao byte original
    let rev = null;
    function rawByte(u) {
      if (!rev) {
        rev = new Map();
        const t = (root.CHARSETS || {}).cp1252 || [];
        for (let i = 0; i < 32; i++) if (t[i] && t[i] !== 0xFFFD) rev.set(t[i], 128 + i);
      }
      return rev.get(u) || 63;
    }

    // Converte os bytes de um texto (LB) para Unicode conforme a codificação
    const SETS = { 277: 'roman8', 341: 'cp437', 405: 'cp850', 14: 'cp1252', 629: 'cp1252', 19: 'cp1252' };
    function decodeLabel(str) {
      const tables = root.CHARSETS || {};
      const forced = o.charset && o.charset !== 'auto' ? o.charset : null;
      const std = tables[forced || SETS[charsetStd] || 'cp1252'];
      const alt = tables[forced || SETS[charsetAlt] || 'roman8'];
      let out = '', shifted = false;
      for (let i = 0; i < str.length; i++) {
        let b = str.charCodeAt(i);
        if (b > 255) b = rawByte(b);
        if (b === 14) { shifted = true; continue; }   // SO: conjunto alternativo
        if (b === 15) { shifted = false; continue; }  // SI: conjunto padrão
        let u = b;
        if (b >= 128) u = std ? std[b - 128] : b;
        else if (shifted && b >= 33 && b <= 126) u = alt ? alt[b] : b;
        if (u === 0xFFFD) { unknownChars.add(b); u = 63; } // vira '?'
        out += String.fromCodePoint(u);
      }
      return out;
    }

    function emitText(str) {
      flushPoly();
      const lines = decodeLabel(str).replace(/\r\n?/g, '\n').split('\n');
      const rad = dirAngle * Math.PI / 180, cs = Math.cos(rad), sn = Math.sin(rad);
      const x0 = x, y0 = y;
      const W = (u, v) => [x0 + u * cs - v * sn, y0 + u * sn + v * cs];
      const cell = 1.5 * charW;
      const lo = ((labelOrigin % 10) || 1);
      const hz = ((lo - 1) / 3) | 0, vt = (lo - 1) % 3;
      const fx = charW / 14, fy = charH / 21;
      const layer = layerName();
      let endU = 0, endV = 0;
      for (let i = 0; i < lines.length; i++) {
        const chars = Array.from(lines[i]).filter((c) => c.codePointAt(0) >= 32);
        const lineV = -i * 2 * charH;
        // Modo linhas: espaçamento proporcional (avanço de cada glifo); modo texto: passo fixo do HPGL
        const glyphs = o.textAsLines ? chars.map(glyph) : null;
        const advs = glyphs ? glyphs.map((g) => g.adv * fx) : chars.map(() => cell);
        const total = advs.reduce((a, b) => a + b, 0);
        const width = glyphs ? total : (chars.length ? total - 0.5 * charW : 0);
        const du = -hz * width / 2, dv = -vt * charH / 2;
        endU = du + total; endV = lineV + dv;
        if (!chars.join('').trim()) continue;
        stats.texts++;
        if (o.textAsLines) {
          let gu = du;
          for (let j = 0; j < chars.length; j++) {
            const g = glyphs[j];
            const u0 = gu;
            gu += advs[j];
            for (const s of g.strokes) {
              const pts = [];
              for (let p = 0; p < s.length; p += 2) {
                const q = W(u0 + s[p] * fx, lineV + dv + (22 - s[p + 1]) * fy);
                pts.push(q[0], q[1]);
              }
              if (pts.length === 2) pts.push(pts[0] + 0.01, pts[1]); // ponto isolado
              if (o.textStyle === 'simple') emitPoly(pts, layer);
              else strokeShapes(pts, charH * Math.max(1, Math.min(40, +o.textWeight || 10)) / 100, layer);
            }
          }
        } else {
          const t = dxfText(chars.join(''));
          const ins = W(0, lineV), ip = [ins[0] * k, ins[1] * k];
          const a = W(du, lineV + dv);
          pseg(a[0], a[1], W(du + width, lineV + dv)[0], W(du + width, lineV + dv)[1]);
          ext(a[0] * k, a[1] * k);
          let e = '0\nTEXT\n8\n' + layer + '\n10\n' + fmt(ip[0]) + '\n20\n' + fmt(ip[1]) + '\n30\n0\n40\n' + fmt(charH * k) +
            '\n1\n' + t + '\n50\n' + fmt(dirAngle) + '\n';
          if (lo !== 1) {
            e += '72\n' + hz + '\n11\n' + fmt(ip[0]) + '\n21\n' + fmt(ip[1]) + '\n31\n0\n';
            if (vt) e += '73\n' + (vt + 1) + '\n';
          }
          w(e);
        }
      }
      // Posição da caneta após o texto (LO 1: fim do texto; outros: volta à origem)
      if (lo === 1) { const p = W(endU, endV); x = p[0]; y = p[1]; }
      else { x = x0; y = y0; }
    }

    // ---------- Estado do plotter ----------
    let x = 0, y = 0, down = false, abs = true, pen = 1;
    let poly = null, polyLayer = '';
    let P1 = [0, 0], P2 = [10000, 10000];
    let sc = null; // {xmin, ymin, sx, sy}
    let charH = 2.7 * upm, charW = 1.9 * upm, dirAngle = 0, labelTerm = 3, labelOrigin = 1;
    let charsetStd = 0, charsetAlt = 0;
    const unknownChars = new Set();

    function resetDefaults() {
      abs = true; sc = null; charH = 2.7 * upm; charW = 1.9 * upm; dirAngle = 0; labelTerm = 3; labelOrigin = 1; charsetStd = 0; charsetAlt = 0;
    }

    function flushPoly() {
      if (poly && poly.length >= 4) emitPoly(poly, polyLayer);
      poly = null;
    }

    function moveTo(px, py, draw) {
      if (draw) {
        if (!poly) { poly = [x, y]; polyLayer = layerName(); }
        const n = poly.length;
        if (poly[n - 2] !== px || poly[n - 1] !== py) { poly.push(px, py); stats.points++; }
      } else if (poly) {
        flushPoly();
      }
      x = px; y = py;
    }

    const sx = () => (sc ? sc.sx : 1);
    const sy = () => (sc ? sc.sy : 1);
    function absPt(ux, uy) {
      return sc ? [P1[0] + (ux - sc.xmin) * sc.sx, P1[1] + (uy - sc.ymin) * sc.sy] : [ux, uy];
    }
    function userPt(ux, uy, isAbs) {
      return isAbs ? absPt(ux, uy) : [x + ux * sx(), y + uy * sy()];
    }

    function move(ux, uy) {
      const p = userPt(ux, uy, abs);
      moveTo(p[0], p[1], down);
    }

    function arcCenter(cx, cy, ang) {
      const r = Math.hypot(x - cx, y - cy);
      const a0 = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
      const ae = (a0 + ang) * Math.PI / 180;
      const ex = cx + r * Math.cos(ae), ey = cy + r * Math.sin(ae);
      if (down) { flushPoly(); emitArc(cx, cy, r, a0, ang); }
      x = ex; y = ey;
    }

    function arc3(ix, iy, ex, ey) {
      const ax = x, ay = y;
      const d = 2 * (ax * (iy - ey) + ix * (ey - ay) + ex * (ay - iy));
      if (Math.abs(d) < 1e-9) { moveTo(ex, ey, down); return; }
      const a2 = ax * ax + ay * ay, i2 = ix * ix + iy * iy, e2 = ex * ex + ey * ey;
      const cx = (a2 * (iy - ey) + i2 * (ey - ay) + e2 * (ay - iy)) / d;
      const cy = (a2 * (ex - ix) + i2 * (ax - ex) + e2 * (ix - ax)) / d;
      const r = Math.hypot(ax - cx, ay - cy);
      const deg = (px, py) => Math.atan2(py - cy, px - cx) * 180 / Math.PI;
      const norm = (v) => ((v % 360) + 360) % 360;
      const a0 = deg(ax, ay);
      const s = norm(deg(ex, ey) - a0) || 360;
      const si = norm(deg(ix, iy) - a0);
      const sweep = si < s ? s : s - 360;
      if (down) { flushPoly(); emitArc(cx, cy, r, a0, sweep); }
      x = ex; y = ey;
    }

    function rect(cx, cy) {
      flushPoly();
      const pts = [x, y, cx, y, cx, cy, x, cy, x, y];
      emitPoly(pts, layerName());
    }

    function beginCmd(cmd) {
      stats.commands++;
      switch (cmd) {
        case 'PU': flushPoly(); down = false; break;
        case 'PD': down = true; break;
        case 'PA': abs = true; break;
        case 'PR': abs = false; break;
      }
    }

    function endCmd(cmd, n) {
      switch (cmd) {
        case 'PU': case 'PD': case 'PA': case 'PR': break;
        case 'IN': flushPoly(); down = false; resetDefaults(); P1 = [0, 0]; P2 = [10000, 10000]; break;
        case 'DF': resetDefaults(); break;
        case 'SP': flushPoly(); pen = n.length ? (n[0] | 0) : 0; break;
        case 'CI': if (n.length) emitCircle(x, y, Math.abs(n[0] * sx())); break;
        case 'AA': if (n.length >= 3) { const c = absPt(n[0], n[1]); arcCenter(c[0], c[1], n[2]); } break;
        case 'AR': if (n.length >= 3) arcCenter(x + n[0] * sx(), y + n[1] * sy(), n[2]); break;
        case 'AT': if (n.length >= 4) { const i = absPt(n[0], n[1]), e = absPt(n[2], n[3]); arc3(i[0], i[1], e[0], e[1]); } break;
        case 'RT': if (n.length >= 4) arc3(x + n[0] * sx(), y + n[1] * sy(), x + n[2] * sx(), y + n[3] * sy()); break;
        case 'EA': case 'RA': if (n.length >= 2) { const p = absPt(n[0], n[1]); rect(p[0], p[1]); } break;
        case 'ER': case 'RR': if (n.length >= 2) rect(x + n[0] * sx(), y + n[1] * sy()); break;
        case 'IP':
          if (n.length >= 4) { P1 = [n[0], n[1]]; P2 = [n[2], n[3]]; }
          else if (n.length >= 2) { const dx = P2[0] - P1[0], dy = P2[1] - P1[1]; P1 = [n[0], n[1]]; P2 = [n[0] + dx, n[1] + dy]; }
          else { P1 = [0, 0]; P2 = [10000, 10000]; }
          break;
        case 'SC': {
          if (n.length < 4) { sc = null; break; }
          const type = n.length >= 5 ? n[4] : 0;
          if (type === 2) { sc = { xmin: n[0], ymin: n[2], sx: n[1], sy: n[3] }; break; }
          let fx = (P2[0] - P1[0]) / ((n[1] - n[0]) || 1);
          let fy = (P2[1] - P1[1]) / ((n[3] - n[2]) || 1);
          if (type === 1) { const m = Math.min(Math.abs(fx), Math.abs(fy)); fx = Math.sign(fx) * m; fy = Math.sign(fy) * m; }
          sc = { xmin: n[0], ymin: n[2], sx: fx, sy: fy };
          break;
        }
        case 'SI':
          if (n.length >= 2) { charW = Math.abs(n[0]) * 10 * upm; charH = Math.abs(n[1]) * 10 * upm; }
          else { charW = 1.9 * upm; charH = 2.7 * upm; }
          break;
        case 'CS': charsetStd = n.length ? (n[0] | 0) : 0; break;
        case 'CA': charsetAlt = n.length ? (n[0] | 0) : 0; break;
        case 'LO': labelOrigin = n.length ? (n[0] | 0) : 1; break;
        case 'DI': case 'DR':
          dirAngle = n.length >= 2 ? Math.atan2(n[1], n[0]) * 180 / Math.PI : 0; break;
        default:
          if (!IGNORED.has(cmd)) unsupported.add(cmd);
      }
    }

    // ---------- PE (Polyline Encoded) ----------
    let pe = null;
    function peReset() {
      pe = { f: 1, seven: false, upNext: false, absNext: false, expPen: false, expFrac: false, val: 0, mult: 1, coords: [] };
    }
    function peNumber(v) {
      if (pe.expPen) { pe.expPen = false; flushPoly(); pen = v | 0; return; }
      if (pe.expFrac) { pe.expFrac = false; pe.f = Math.pow(2, v); return; }
      pe.coords.push(v / pe.f);
      if (pe.coords.length === 2) {
        const p = userPt(pe.coords[0], pe.coords[1], pe.absNext);
        down = !pe.upNext;
        moveTo(p[0], p[1], down);
        pe.coords.length = 0; pe.upNext = false; pe.absNext = false;
      }
    }
    function peChar(c) {
      if (c === 58) { pe.expPen = true; return; }        // :
      if (c === 60) { pe.upNext = true; return; }        // <
      if (c === 62) { pe.expFrac = true; return; }       // >
      if (c === 61) { pe.absNext = true; return; }       // =
      if (c === 55) { pe.seven = true; return; }         // 7
      const base = pe.seven ? 32 : 64;
      const ntMax = pe.seven ? 94 : 126;
      const tMin = pe.seven ? 95 : 191, tMax = pe.seven ? 126 : 254;
      if (c >= 63 && c <= ntMax) { pe.val += (c - 63) * pe.mult; pe.mult *= base; return; }
      if (c >= tMin && c <= tMax) {
        const v = pe.val + (c - tMin) * pe.mult;
        pe.val = 0; pe.mult = 1;
        peNumber(v % 2 ? -Math.floor(v / 2) : v / 2);
      }
    }

    // ---------- Tokenizador em streaming ----------
    // estados: 0 livre, 1 2ª letra, 2 parâmetros, 3 texto LB, 4 PE, 5 escape, 6 DT, 7 resto DT
    let st = 0, c1 = 0, cmd = '', numBuf = '', nums = [], isMove = false, lb = '', esc = 0;
    const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

    function finishNum() {
      if (numBuf.length) {
        const v = parseFloat(numBuf);
        numBuf = '';
        if (!isNaN(v)) {
          nums.push(v);
          if (isMove && nums.length === 2) { move(nums[0], nums[1]); nums.length = 0; }
        }
      }
    }

    function idle(c) {
      if (isLetter(c)) { c1 = c & ~32; st = 1; }
      else if (c === 27) { st = 5; esc = 0; }
    }

    function startCmd() {
      if (cmd === 'LB') { stats.commands++; st = 3; lb = ''; return; }
      if (cmd === 'PE') { stats.commands++; st = 4; peReset(); return; }
      if (cmd === 'DT') { stats.commands++; st = 6; return; }
      st = 2; numBuf = ''; nums = [];
      isMove = cmd === 'PU' || cmd === 'PD' || cmd === 'PA' || cmd === 'PR';
      beginCmd(cmd);
    }

    function feed(s) {
      for (let i = 0, L = s.length; i < L; i++) {
        const c = s.charCodeAt(i);
        switch (st) {
          case 0: idle(c); break;
          case 1:
            if (isLetter(c)) { cmd = String.fromCharCode(c1, c & ~32); startCmd(); }
            else { st = 0; idle(c); }
            break;
          case 2:
            if ((c >= 48 && c <= 57) || c === 46) numBuf += s[i];
            else if (c === 45 || c === 43) { finishNum(); numBuf = s[i]; }
            else if (isLetter(c)) { finishNum(); endCmd(cmd, nums); st = 0; idle(c); }
            else if (c === 59) { finishNum(); endCmd(cmd, nums); st = 0; }
            else if (c === 27) { finishNum(); endCmd(cmd, nums); st = 5; esc = 0; }
            else finishNum();
            break;
          case 3:
            if (c === labelTerm) { emitText(lb); st = 0; }
            else if (lb.length > 8192) { st = 0; }
            else lb += s[i];
            break;
          case 4:
            if (c === 59) st = 0;
            else if (c === 27) { st = 5; esc = 0; }
            else peChar(c);
            break;
          case 5: // sequências de escape (HP RTL / PCL / ESC.)
            if (esc === 0) {
              if (c === 46) esc = 1;                 // ESC .
              else if (c >= 33 && c <= 47) esc = 3;  // ESC % -1B, ESC & ..., etc.
              else st = 0;                           // ESC E e similares
            } else if (esc === 1) {
              esc = 2;
            } else if (esc === 2) {
              if (c === 58) st = 0;
              else if (!((c >= 48 && c <= 57) || c === 59 || c === 44 || c === 45 || c === 32)) { st = 0; idle(c); }
            } else {
              if (c >= 64 && c <= 90) st = 0;
            }
            break;
          case 6:
            if (c === 59) { labelTerm = 3; st = 0; }
            else { labelTerm = c; st = 7; }
            break;
          case 7:
            if (c === 59) st = 0;
            else if (isLetter(c)) { st = 0; idle(c); }
            break;
        }
      }
    }

    function finish() {
      if (st === 2) { finishNum(); endCmd(cmd, nums); }
      if (st === 3 && lb) emitText(lb);
      st = 0;
      flushPoly();
      if (cur.length) { pushChunk(cur.join('')); cur = []; }
      if (!isFinite(minX)) { minX = minY = maxX = maxY = 0; }
      if (!layers.size) layers.set('PEN1', 7);

      let h = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n';
      h += '9\n$INSUNITS\n70\n' + (o.outUnit === 'in' ? 1 : o.outUnit === 'mm' ? 4 : 0) + '\n';
      h += '9\n$MEASUREMENT\n70\n' + (o.outUnit === 'in' ? 0 : 1) + '\n';
      h += '9\n$EXTMIN\n10\n' + fmt(minX) + '\n20\n' + fmt(minY) + '\n30\n0\n';
      h += '9\n$EXTMAX\n10\n' + fmt(maxX) + '\n20\n' + fmt(maxY) + '\n30\n0\n';
      h += '0\nENDSEC\n';
      h += '0\nSECTION\n2\nTABLES\n';
      h += '0\nTABLE\n2\nLTYPE\n70\n1\n0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n0\nENDTAB\n';
      h += '0\nTABLE\n2\nLAYER\n70\n' + (layers.size + 1) + '\n';
      h += '0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n';
      for (const [name, color] of layers) h += '0\nLAYER\n2\n' + name + '\n70\n0\n62\n' + color + '\n6\nCONTINUOUS\n';
      h += '0\nENDTAB\n0\nENDSEC\n';
      h += '0\nSECTION\n2\nENTITIES\n';

      stats.unsupported = Array.from(unsupported);
      stats.layers = Array.from(layers.keys());
      stats.bounds = { minX, minY, maxX, maxY, unit: o.outUnit };
      stats.previewTruncated = prevTruncated;
      stats.textAsLines = !!o.textAsLines;
      stats.textStyle = o.textStyle;
      stats.unknownChars = Array.from(unknownChars).map((c) => (c < 256 ? '0x' : 'U+') + c.toString(16).toUpperCase().padStart(2, '0'));

      return {
        parts: [h].concat(chunks, ['0\nENDSEC\n0\nEOF\n']),
        stats,
        preview: new Float32Array(prev)
      };
    }

    return { feed, finish };
  }

  async function convertFile(file, opts, onProgress) {
    const conv = createConverter(opts);
    const dec = new TextDecoder('windows-1252');
    const CH = 4 * 1024 * 1024;
    const size = file.size;
    for (let off = 0; off < size; off += CH) {
      // Decodificador nativo (rápido); os bytes 0x80-0x9F são recuperados em decodeLabel
      const buf = await file.slice(off, off + CH).arrayBuffer();
      conv.feed(dec.decode(buf, { stream: true }));
      if (onProgress) onProgress(Math.min(1, (off + CH) / size));
    }
    conv.feed(dec.decode());
    const r = conv.finish();
    return { blob: new Blob(r.parts, { type: 'application/dxf' }), stats: r.stats, preview: r.preview };
  }

  root.PltDxf = { createConverter, convertFile };
})(typeof self !== 'undefined' ? self : globalThis);
