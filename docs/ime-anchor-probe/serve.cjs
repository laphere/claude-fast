/** 探针用的静态服务（probe.bundle.mjs 走 ES module，file:// 下会被 CORS 拦掉，必须走 http）。
 *  用法：node docs/ime-anchor-probe/serve.cjs */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = 8791;

http
  .createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const file = path.join(ROOT, url === "/" ? "/probe.html" : url);
    let data = null;
    try {
      data = fs.readFileSync(file);
    } catch {
      /* 读不到 → 404 */
    }
    if (data === null) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/javascript" });
    res.end(data);
  })
  .listen(PORT, () => console.log(`probe server on http://localhost:${PORT}/probe.html`));
