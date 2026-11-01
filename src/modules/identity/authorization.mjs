import { AppError } from '../../platform/errors.mjs';

// Internal input only: principal and resource facts must be loaded by the server.
// Role names supplied in HTTP bodies/headers are never an authentication source.
export function allowed(principal, action, resource = {}) {
  if (action === 'public.read') return resource.published === true;
  if (!principal || typeof principal.id !== 'string' || !principal.id || principal.status !== 'active') return false;
  const roles = Array.isArray(principal.roles) ? principal.roles : [];
  const admin = roles.includes('admin');
  const own = typeof resource.ownerId === 'string' && resource.ownerId === principal.id;
  const captain = resource.captainId === principal.id;
  const member = Array.isArray(resource.memberIds) && resource.memberIds.includes(principal.id);
  switch (action) {
    case 'interaction.create': return true; // Rate limits/moderation remain with their owning module.
    case 'profile.readSelf': return own;
    case 'profile.updateSelf': return own;
    case 'work.manage':
    case 'work.submit':
      return resource.kind === 'personal' ? own : resource.kind === 'team' && captain;
    case 'team.read': return captain || member;
    case 'team.manage': return captain;
    case 'review.score':
      return roles.includes('judge') && resource.technicalStatus === 'approved' &&
        Array.isArray(resource.assignedJudgeIds) && resource.assignedJudgeIds.includes(principal.id) && resource.submitted === false &&
        !own && !captain && !member;
    case 'admin.access':
    case 'admin.sensitive':
    case 'admin.dangerous': return admin;
    default: return false;
  }
}

export function requirePermission(principal, action, resource) {
  if (!allowed(principal, action, resource)) {
    throw new AppError(principal ? 'FORBIDDEN' : 'AUTHENTICATION_REQUIRED', principal ? 403 : 401, '无权执行此操作');
  }
}
