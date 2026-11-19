importScripts('converter.js');

self.onmessage = async (e) => {
  const { id, file, options } = e.data;
  try {
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
