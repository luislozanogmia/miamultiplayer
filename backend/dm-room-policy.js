'use strict';

function canCreateDmRoom(members, options) {
  const list = Array.isArray(members) ? members : [];
  if (list.length >= 2) return true;
  return !!(options && options.allowSelfOnly) && list.length === 1 && list[0].kind === 'human';
}

module.exports = { canCreateDmRoom };
