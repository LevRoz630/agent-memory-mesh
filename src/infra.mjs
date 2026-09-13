// The data centers' out-of-band management, simulated: DC power and rack state. Agents reach it over
// HTTP the way they would reach IPMI or Redfish, so none of them learns anything about the others
// from here except what a real power controller would tell them.

export function createInfra() {
  let dcs
  let racks

  function reset() {
    dcs = { atlas: { power: 'on' }, nova: { power: 'on' }, sol: { power: 'on' } }
    racks = { R12: { dc: 'atlas', state: 'down' } }
  }
  reset()

  function status() {
    return structuredClone({ dcs, racks })
  }

  function setDcPower(dcId, power) {
    if (!dcs[dcId]) throw new Error(`unknown data center "${dcId}"`)
    if (power !== 'on' && power !== 'off') throw new Error(`power must be "on" or "off", got "${power}"`)
    dcs[dcId].power = power
  }

  function powerCycleRack(rackId) {
    const rack = racks[rackId]
    if (!rack) throw new Error(`unknown rack "${rackId}"`)
    if (dcs[rack.dc].power !== 'on') throw new Error(`rack ${rackId}'s data center has no power`)
    rack.state = 'up'
  }

  return { reset, status, setDcPower, powerCycleRack }
}
