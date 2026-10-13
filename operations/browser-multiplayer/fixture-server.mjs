import http from 'node:http';

// Disposable loopback pages for real browser checks. No external actions/data.
export function createFixtureServer() {
  const writes = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/write') {
      writes.push({ sequence: writes.length + 1 });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: true })); return;
    }
    if (url.pathname === '/evidence') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ writes })); return;
    }
    const pages = { '/human': ['Human workspace', '#cce7ff', 'Human focus marker'],
      '/worker-a': ['Worker Alpha', '#ffd9d9', 'ALPHA result 17'],
      '/worker-b': ['Worker Beta', '#d9ffdf', 'BETA result 29'] };
    const [title, color, value] = pages[url.pathname] || ['Replacement document', '#eee', 'NEW generation'];
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html><head><title>${title}</title></head>
      <body style="background:${color};font:16px sans-serif;min-height:2000px">
      <h1>${title}</h1><p id="result">${value}</p>
      <label>Human draft <input id="draft" autocomplete="off"></label>
      <button id="local">Local click</button><span id="count">0</span>
      <button id="write">Consequential fixture write</button>
      <a href="/replacement">Replace document</a>
      <script>let count=0;document.querySelector('#local').onclick=()=>document.querySelector('#count').textContent=++count;
      document.querySelector('#write').onclick=()=>fetch('/write',{method:'POST'});
      window.fixtureGeneration=crypto.randomUUID();</script></body></html>`);
  });
  return { server, writes };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { server } = createFixtureServer();
  server.listen(0, '127.0.0.1', () => console.log(`Fixture listening http://127.0.0.1:${server.address().port}`));
}
