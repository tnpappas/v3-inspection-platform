// Day 1 stub. Day 2 wires:
//   - catalog.ts: imports PERMISSIONS_SEED, PERMISSION_GROUPS_SEED, GROUP_MEMBERS_SEED,
//     DEFAULT_ROLE_PERMISSIONS_SEED, ROLE_IMPLICIT_DENIES from
//     projects/isn-replacement/specs/shared/schemas/permissions-seed.ts
//   - resolver.ts: effectivePermissions(user, business) per security spec S11
//   - implicit-denies.ts: applyImplicitDeniesOnUserCreate(userId, role, businessId)
//   - middleware.ts: requires.all([...]) / requires.any([...]) Express middleware factory

export {};
