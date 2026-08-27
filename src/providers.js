/**
 * Provider mounts isolate identical upstream paths. A client configured with
 * http://mock-pos:8080/providers/acmepay can still call /payment/auth without
 * colliding with iyzico's root-compatible endpoint.
 */
export const providers = Object.freeze({
  paytr: { id: 'paytr', mountPath: '/providers/paytr' },
  iyzico: { id: 'iyzico', mountPath: '/providers/iyzico' },
  lidio: { id: 'lidio', mountPath: '/providers/lidio' }
});

export function scopedProvider(pathname) {
  const match = pathname.match(/^\/providers\/([a-z0-9-]+)(\/.*)?$/);
  if (!match) return null;
  const provider = providers[match[1]];
  if (!provider) return { id: match[1], pathname: match[2] || '/' };
  return { ...provider, pathname: match[2] || '/' };
}
