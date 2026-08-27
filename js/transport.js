'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, transport.

   Talking to the display: one HTTP transport shared by JSON-RPC and the
   SOAP endpoint, the retry rules for a method offered at another
   version, and the capability discovery that decides what this display
   can actually do.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── transport ─────────────────────────────────────────────────────── */

class RpcError extends Error {
  constructor(kind, code, message) {
    super(message);
    this.kind = kind;   // 'auth' | 'network' | 'api'
    this.code = code;   // JSON-RPC error code or HTTP status
  }
}

const isUnsupportedCode = (code) => code === 12 || code === 14 || code === 501;

/* Shared HTTP transport: base URL, timeout, and status→error mapping for
   both JSON-RPC and the SOAP IRCC endpoint. */
async function braviaFetch(path, headers, body) {
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    res = await fetch(apiBase() + path, {
      method: 'POST', headers, body, signal: ctrl.signal,
    });
  } catch (e) {
    throw new RpcError('network', 0, e.name === 'AbortError'
      ? 'Request timed out' : 'Network request failed');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 403) throw new RpcError('auth', 403, 'Authentication rejected (403)');
  if (res.status === 502) throw new RpcError('network', 502, 'Proxy could not reach the TV');
  if (!res.ok) throw new RpcError('api', res.status, 'HTTP ' + res.status);
  return res;
}

/* One JSON-RPC attempt at a specific version; no capability bookkeeping. */
async function rpcRaw(service, method, params, version) {
  const res = await braviaFetch('/sony/' + service,
    { 'X-Auth-PSK': getPsk(), 'Content-Type': 'application/json' },
    JSON.stringify({ method, params, version, id: rpcId++ }));
  const json = await res.json();
  if (json.error) {
    const [code, msg] = json.error;
    if (code === 403) throw new RpcError('auth', 403, msg || 'Forbidden');
    throw new RpcError('api', code, msg || ('API error ' + code));
  }
  return json.result !== undefined ? json.result : json.results;
}

function altVersions(service, method, tried) {
  const advertised = apiMap && apiMap[service] && apiMap[service][method];
  const pool = advertised && advertised.size ? [...advertised].sort() : ['1.0', '1.1'];
  return pool.filter(v => v !== tried).slice(0, 2);
}

async function rpc(service, method, params = [], version) {
  const key = service + '.' + method;
  version = versionOverride.get(key) || version || bestVersion(service, method) || '1.0';
  try {
    return await rpcRaw(service, method, params, version);
  } catch (e) {
    if (e.code === 14) {
      // Unsupported *version*, not a missing method: retry the alternatives
      // before writing the whole method off for the session.
      for (const alt of altVersions(service, method, version)) {
        try {
          const r = await rpcRaw(service, method, params, alt);
          versionOverride.set(key, alt);
          return r;
        } catch (e2) {
          if (e2.code !== 14) {
            if (isUnsupportedCode(e2.code)) unsupported.add(key);
            throw e2;
          }
        }
      }
      unsupported.add(key);
    } else if (isUnsupportedCode(e.code)) {
      unsupported.add(key);   // covers HTTP-level 501 as well as JSON-RPC errors
    }
    throw e;
  }
}

/* Sends an infrared-over-IP key code via the SOAP IRCC endpoint. */
async function sendIrcc(code) {
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1">' +
    '<IRCCCode>' + code + '</IRCCCode>' +
    '</u:X_SendIRCC></s:Body></s:Envelope>';
  await braviaFetch('/sony/ircc', {
    'X-Auth-PSK': getPsk(),
    'Content-Type': 'text/xml; charset=UTF-8',
    'SOAPAction': '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
  }, body);
}

/* ── capability discovery ──────────────────────────────────────────── */

const SERVICES = ['system', 'audio', 'avContent', 'appControl', 'video', 'videoScreen', 'guide'];

function supports(service, method) {
  if (unsupported.has(service + '.' + method)) return false;
  if (!apiMap) return true;                       // discovery failed → optimistic
  return !!(apiMap[service] && apiMap[service][method]);
}

function bestVersion(service, method, prefer) {
  const versions = apiMap && apiMap[service] && apiMap[service][method];
  if (!versions || !versions.size) return prefer;
  if (prefer && versions.has(prefer)) return prefer;
  return [...versions].sort().pop();
}

async function discoverApi() {
  apiMap = null;
  try {
    const r = await rpc('guide', 'getSupportedApiInfo', [{ services: SERVICES }], '1.0');
    const map = {};
    for (const svc of r[0]) {
      const methods = {};
      for (const m of svc.apis || []) {
        methods[m.name] = new Set((m.versions || []).map(v => v.version));
      }
      map[svc.service] = methods;
    }
    apiMap = map;
    return;
  } catch { /* fall through to per-service probing */ }

  const map = {};
  await Promise.all(SERVICES.map(async (service) => {
    try {
      const r = await rpc(service, 'getMethodTypes', [''], '1.0');
      const methods = {};
      for (const row of r) {
        const [name, , , version] = row;
        (methods[name] = methods[name] || new Set()).add(version);
      }
      map[service] = methods;
    } catch { /* service absent on this model */ }
  }));
  if (Object.keys(map).length) apiMap = map;
}
