import { requirePermission } from './authorization.mjs';

// Explicit projections: adding a database field must never make it public.
export function publicProfile(record) {
  return { id: record.id, nickname: record.nickname, avatar: record.avatar, bio: record.bio };
}

export function publicTeam(record) {
  return { id: record.id, name: record.name, bio: record.bio,
    members: record.members.map(member => ({ nickname: member.nickname })) };
}

export function selfProfile(principal, record) {
  requirePermission(principal, 'profile.readSelf', { ownerId: record.id });
  return { ...publicProfile(record), email: record.email };
}
