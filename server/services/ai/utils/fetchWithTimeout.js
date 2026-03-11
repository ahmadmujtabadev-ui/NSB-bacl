import https from 'https';
import http  from 'http';

/**
 * HTTP/HTTPS request helper that works reliably on all platforms including Windows.
 *
 * Node's built-in fetch() has SSL/TLS issues on Windows with certain hosts (notably api.bfl.ml).
 * Using the native https module avoids this entirely.
 *
 * Returns a fetch-compatible Response-like object:
 *   { ok, status, statusText, headers, text(), json() }
 *
 * @param {string} url
 * @param {{ method?, headers?, body? }} [options]
 * @param {number} [timeoutMs]
 */
export function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const bodyStr = options.body ? String(options.body) : null;

    const reqOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  {
        ...(options.headers || {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    let settled = false;
    const done  = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const timer = setTimeout(() => {
      nodeReq.destroy();
      done(reject, Object.assign(new Error(`Request timed out after ${timeoutMs}ms: ${url}`), { code: 'TIMEOUT' }));
    }, timeoutMs);

    const nodeReq = lib.request(reqOptions, (res) => {
      clearTimeout(timer);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const status  = res.statusCode;
        const headers = res.headers;

        const responseObj = {
          ok:         status >= 200 && status < 300,
          status,
          statusText: res.statusMessage || '',
          headers:    { get: k => headers[k.toLowerCase()] },
          text:       () => Promise.resolve(rawBody),
          json:       () => {
            try   { return Promise.resolve(JSON.parse(rawBody)); }
            catch (e) { return Promise.reject(new Error(`JSON parse failed: ${e.message}\nBody: ${rawBody.slice(0, 200)}`)); }
          },
        };
        done(resolve, responseObj);
      });
      res.on('error', err => { clearTimeout(timer); done(reject, err); });
    });

    nodeReq.on('error', err => {
      clearTimeout(timer);
      // Enrich error message for easier debugging
      const enriched = Object.assign(
        new Error(`${options.method || 'GET'} ${url} → ${err.message} (code: ${err.code || 'unknown'})`),
        { originalError: err, code: err.code }
      );
      done(reject, enriched);
    });

    if (bodyStr) nodeReq.write(bodyStr);
    nodeReq.end();
  });
}
