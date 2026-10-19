function getSetRankRoleIds(env = process.env) {
  const additionalRoleIds = String(env.SETRANK_ROLE_IDS ?? "").split(/[\s,]+/);
  return [...new Set([env.MOD_ROLE_ID, ...additionalRoleIds]
    .map(roleId => String(roleId ?? "").trim())
    .filter(roleId => /^[0-9]+$/.test(roleId)))];
}

function memberHasAnyRole(member, roleIds) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return false;
  const memberRoles = member?.roles;
  return roleIds.some(roleId => Array.isArray(memberRoles)
    ? memberRoles.includes(roleId)
    : Boolean(memberRoles?.cache?.has(roleId)));
}

module.exports = { getSetRankRoleIds, memberHasAnyRole };
