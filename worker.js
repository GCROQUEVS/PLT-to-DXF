// Repassa a versão (?v=...) para os scripts, evitando arquivos antigos em cache
const V = self.location.search;
importScripts('font.js' + V, 'converter.js' + V, 'viewer-parse.js' + V);

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'view') {
      // Lê o DXF exportado para o visualizador
      const r = await self.DxfView.readDxf(e.data.blob, (p) => self.postMessage({ id, type: 'progress', p }));
      const transfer = r.transfer; delete r.transfer;
      self.postMessage({ id, type: 'view', data: r }, transfer);
      return;
    }
    const { file, options } = e.data;
    let last = 0;
    const res = await self.PltDxf.convertFile(file, options, (p) => {
      if (p - last >= 0.01 || p === 1) { last = p; self.postMessage({ id, type: 'progress', p }); }
    });
    self.postMessage(
      { id, type: 'done', blob: res.blob, stats: res.stats, preview: res.preview },
      [res.preview.buffer]
    );
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
