import { readFileSync } from 'node:fs'

export const ROSTER = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'))

const ADDRESSES = new Set(Object.values(ROSTER).map(({ address }) => address.toLowerCase()))

export function isRosterAddress(address) {
  return ADDRESSES.has(String(address).toLowerCase())
}
