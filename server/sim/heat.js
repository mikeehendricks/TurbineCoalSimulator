/**
 * heat.js — boiler heat-transfer calibration constants.
 *
 * These are the empirical coefficients of the boiler thermal model.  They were
 * fitted so that the model reproduces the plant heat balance at the MCR design
 * point (see tools/calib.js) and they are kept in one place so the model can be
 * re-calibrated for a different boiler without touching the physics code.
 */
'use strict';

module.exports = {
  // Furnace radiant conductances, MW / K^4  (Q = K * (T_f^4 - T_sink^4))
  K_WW: 5.514e-11,      // water walls (evaporation)
  K_SH: 3.000e-11,      // radiant platen superheater

  // Convective-pass overall conductances at the design gas flow, kW / K
  UA_SH: 166,           // convective (pendant / final) superheater
  UA_RH: 627,           // reheater
  UA_EC: 426,          // economiser
  UA_APH: 494,          // air preheater

  // Reference flows for the UA scaling, kg/s (gas) and t/h (fluids)
  GAS_REF: 346,
  FLOW_SH: 1010,
  FLOW_RH: 886,
  FLOW_FW: 1010,
  FLOW_AIR: 1220,
  // Exponent of the gas-flow correction (UA ~ m^0.65)
  GAS_EXP: 0.65,

  // Adiabatic flame temperature: fraction of the ideal rise that is actually
  // reached once CO2/H2O dissociation at flame temperature is allowed for.
  DISSOCIATION: 0.85,

  // Superheater outlet temperature is limited by the local gas temperature
  SH_GAS_LIMIT: true,
};
