// In-memory shop values that delivery rules read synchronously.
// null means "use the environment default".

let dueSoonHoursOverride = null;

function getDueSoonHoursOverride() {
  return dueSoonHoursOverride;
}

function setDueSoonHoursOverride(value) {
  dueSoonHoursOverride = value == null ? null : value;
}

module.exports = {
  getDueSoonHoursOverride,
  setDueSoonHoursOverride,
};
