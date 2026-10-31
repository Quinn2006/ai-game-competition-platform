import { allowed } from './authorization.mjs';
import { AppError } from '../../platform/errors.mjs';

// No HTTP adapter until T-02 is decided. All dependencies are trusted server adapters.
// verifyRevalidation must verify an unexpired, action/actor/resource-bound proof;
// its implementation and lifetime are intentionally blocked on T-02.
export function createAccessGuard({ audit, verifyRevalidation = async () => false }) {
  return async function authorize({ principal, action, resource, requestId, proof, confirmed = false }) {
    let granted = allowed(principal, action, resource);
    if (granted && ['admin.sensitive', 'admin.dangerous'].includes(action)) {
      try {
        granted = (action !== 'admin.dangerous' || confirmed === true) &&
          await verifyRevalidation({ actorId: principal.id, action, resourceId: resource?.id, proof,
            requirePassword: action === 'admin.dangerous' }) === true;
      } catch {
        granted = false;
      }
    }
    // Never execute the protected operation before this promise resolves.
    // An audit failure also denies access; it must not silently become log-only.
    await audit({ action: granted ? 'access.granted' : 'access.denied', requestId,
      actorId: principal?.id ?? null, outcome: granted ? 'success' : 'failure',
      permission: action, resourceId: resource?.id ?? null });
    if (!granted) throw new AppError(principal ? 'FORBIDDEN' : 'AUTHENTICATION_REQUIRED', principal ? 403 : 401, '无权执行此操作');
  };
}
