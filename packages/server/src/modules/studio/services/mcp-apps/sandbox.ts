/** Only serves a sandbox bootstrap. No credentials, resources, or application data live here. */
export function sandboxOrigin(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || /[\s;'"\\]/.test(value)) {
    throw new Error('Invalid sandbox origin')
  }
  return url.origin
}

function sources(value: unknown, protocols: string[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid CSP domains')
  return [...new Set(value.map(source => {
    if (typeof source !== 'string' || /[\s;'"\\]/.test(source)) throw new Error('Invalid CSP source')
    const wildcard = source.match(/^(https?|wss?):\/\/\*\.([a-zA-Z0-9.-]+)(?::[0-9]+)?$/)
    if (wildcard && protocols.includes(`${wildcard[1]}:`) && wildcard[2].includes('.')) return source
    const url = new URL(source)
    if (!protocols.includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid CSP source')
    return url.origin
  }))]
}

export function createSandboxDocument(parent: string, metadata: unknown): { html: string; policy: string } {
  const parentOrigin = sandboxOrigin(parent)
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid CSP')
  const csp = metadata as Record<string, unknown>
  const resource = sources(csp.resourceDomains, ['http:', 'https:'])
  const connect = sources(csp.connectDomains, ['http:', 'https:', 'ws:', 'wss:'])
  const frames = sources(csp.frameDomains, ['http:', 'https:'])
  const bases = sources(csp.baseUriDomains, ['http:', 'https:'])
  const directive = (name: string, values: string[]) => `${name} ${values.length ? values.join(' ') : "'none'"}`
  const common = [
    "default-src 'none'",
    directive('script-src', ["'unsafe-inline'", ...resource]),
    directive('style-src', ["'unsafe-inline'", ...resource]),
    directive('img-src', ['data:', 'blob:', ...resource]),
    directive('font-src', resource),
    directive('media-src', ['data:', 'blob:', ...resource]),
    directive('connect-src', connect),
    directive('base-uri', bases),
    "object-src 'none'", "form-action 'none'",
  ]
  const viewPolicy = [...common, directive('frame-src', frames)].join('; ')
  const policy = [...common, directive('frame-src', ["'self'", ...frames]), `frame-ancestors ${parentOrigin}`].join('; ')
  const settings = JSON.stringify({ parentOrigin, viewPolicy }).replace(/</g, '\\u003c')
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head>
<body><script>
(() => {
  'use strict';
  const {parentOrigin, viewPolicy} = ${settings};
  if (window.parent === window || parentOrigin === location.origin) return;
  let view = null;
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (event.source === window.parent && event.origin === parentOrigin) {
      if (message.method === 'ui/notifications/sandbox-resource-ready') {
        if (view || typeof message.params?.html !== 'string' || message.params.html.length > 2097152) return;
        const doc = new DOMParser().parseFromString(message.params.html, 'text/html');
        doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach(node => node.remove());
        const policy = doc.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        policy.content = viewPolicy;
        doc.head.prepend(policy);
        view = document.createElement('iframe');
        view.title = 'Application content';
        view.setAttribute('sandbox', 'allow-scripts');
        view.setAttribute('referrerpolicy', 'no-referrer');
        view.srcdoc = '<!doctype html>\\n' + doc.documentElement.outerHTML;
        document.body.append(view);
      } else if (!String(message.method || '').startsWith('ui/notifications/sandbox-')) {
        view?.contentWindow?.postMessage(message, '*');
      }
    } else if (view && event.source === view.contentWindow
      && !String(message.method || '').startsWith('ui/notifications/sandbox-')) {
      window.parent.postMessage(message, parentOrigin);
    }
  });
  window.parent.postMessage({jsonrpc:'2.0', method:'ui/notifications/sandbox-proxy-ready', params:{}}, parentOrigin);
})();
</script></body></html>`
  return { html, policy }
}
