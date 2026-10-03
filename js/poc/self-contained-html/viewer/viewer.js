// The viewer: reads the JAZMIN files embedded in this page, asks for the key if they are
// encrypted, decrypts them in memory and hands the template and data to a sandboxed iframe.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const embedded = (id) => JazminBrowser.base64ToBytes($(id).textContent);
  const setStatus = (status, text) => {
    document.documentElement.dataset.status = status;
    if (text !== undefined) $('jz-status').textContent = text;
  };

  const assetsBytes = embedded('jzm-assets');
  const dataBytes = embedded('jzm-data');
  const bootstrap = $('jzm-bootstrap').textContent;
  const encrypted = (assetsBytes[6] & 1) !== 0; // preamble flag: ENCRYPTED

  // Same rules as the viewer page; srcdoc frames also inherit the viewer's own policy.
  const POLICY = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; "
    + 'img-src blob: data:; font-src blob: data:; media-src blob: data:; object-src blob:; frame-src blob:; '
    + 'worker-src blob:; connect-src blob: data:';

  async function load(credentials) {
    setStatus('opening', encrypted ? 'Decrypting…' : 'Opening…');
    const started = performance.now();
    const assets = await JazminBrowser.open(assetsBytes, credentials);
    const data = await JazminBrowser.open(dataBytes, credentials);
    const files = (await assets.rows()).map((r) => ({ path: r.path, type: r.mime, blob: new Blob([r.content], { type: r.mime }) }));
    const rows = await data.rows();
    setStatus('rendering');
    render({
      entry: assets.metadata.entry || 'index.html',
      files,
      data: { columns: data.columns, metadata: data.metadata, rows },
    }, Math.round(performance.now() - started));
  }

  function render(pkg, openMs) {
    const frame = document.createElement('iframe');
    frame.id = 'jz-frame';
    frame.title = 'Document';
    frame.setAttribute('sandbox', 'allow-scripts allow-modals allow-downloads');
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"></head>`
      + `<body><script>${bootstrap}<\/script></body></html>`;
    addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow || !e.data) return;
      document.documentElement.dataset.lastMessage = e.data.type;
      if (e.data.type === 'jazmin:bootstrap') frame.contentWindow.postMessage(Object.assign({ type: 'jazmin:package' }, pkg), '*');
      else if (e.data.type === 'jazmin:title') document.title = e.data.title;
      else if (e.data.type === 'jazmin:ready') {
        document.documentElement.dataset.ready = JSON.stringify(Object.assign({ page: e.data.page, openMs }, e.data.info));
        setStatus('ready');
      } else if (e.data.type === 'jazmin:error') {
        frame.remove();
        $('jz-form-inner').hidden = true;
        $('jz-unlock').hidden = false;
        setStatus('error', 'The document could not be shown: ' + e.data.message);
      }
    });
    $('jz-unlock').hidden = true;
    document.body.appendChild(frame);
  }

  function fail(error) {
    setStatus('error', error.message || String(error));
    $('jz-unlock').hidden = false;
    $('jz-key').focus();
  }

  $('jz-unlock').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('jz-key').value.trim();
    $('jz-key').value = ''; // do not keep the key in the page
    load(value.startsWith('jzk1-') ? { key: value } : { password: value }).catch(fail);
  });

  if (window.JAZMIN_TEST_KEY) load({ key: window.JAZMIN_TEST_KEY }).catch(fail); // test builds only
  else if (encrypted) {
    setStatus('locked', '');
    $('jz-unlock').hidden = false;
    $('jz-key').focus();
  } else load({}).catch(fail);
})();
