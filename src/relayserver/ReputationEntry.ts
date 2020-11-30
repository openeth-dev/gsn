import { Address } from '../common/types/Aliases'

export interface ReputationChange {
  timestamp: number
  change: number
}

export interface ReputationEntry {
  paymaster: Address
  reputation: number
  lastAcceptedRelayRequestTs: number
  abuseStartedTs: number
  changes: ReputationChange[]
}
