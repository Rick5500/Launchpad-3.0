// Default scan locations follow department names.
// Quality advances the Quality Control stage. Dispatch advances the Shipping stage.
// Finishing is a production stage, not a department, and is not a default scan location.
const DEFAULT_LOCATION_STAGES = 'Quality=Quality Control;Dispatch=Shipping';

const LEGACY_MIGRATION_SETTING = 'barcode_locations_legacy_departments';

// Rows inserted by the previous seed: a stage name, no department.
const LEGACY_STAGE_SEEDS = Object.freeze([
  {
    location: 'Quality Control',
    stage: 'Quality Control',
    department: 'Quality',
  },
  {
    location: 'Shipping',
    stage: 'Shipping',
    department: 'Dispatch',
  },
  {
    location: 'Finishing',
    stage: 'Finishing',
    department: null,
    deactivate: true,
  },
]);

function sameText(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function legacySeedFor(location) {
  return LEGACY_STAGE_SEEDS.find((seed) => sameText(seed.location, location)) || null;
}

function isOriginalLegacySeed(row, seed) {
  if (!row || !seed) return false;
  if (!sameText(row.location, seed.location)) return false;
  if (String(row.department_name || '').trim()) return false;
  if (!sameText(row.stage_name, seed.stage)) return false;
  if (Number(row.is_active) === 0) return false;
  return true;
}

// After the migration, Quality Control and Shipping stay in the table but are
// inactive when a department-named row already covers them. A scan of the old
// name still moves the department. An admin edit (different department or stage)
// does not match, and Finishing does not move a department.
function isLegacyInactiveAlias(row) {
  if (!row || Number(row.is_active) !== 0) return false;
  const seed = legacySeedFor(row.location);
  if (!seed || !seed.department || seed.deactivate) return false;
  if (!sameText(row.department_name, seed.department)) return false;
  if (!sameText(row.stage_name, seed.stage)) return false;
  return true;
}

module.exports = {
  DEFAULT_LOCATION_STAGES,
  LEGACY_MIGRATION_SETTING,
  LEGACY_STAGE_SEEDS,
  legacySeedFor,
  isOriginalLegacySeed,
  isLegacyInactiveAlias,
  sameText,
};
