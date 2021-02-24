import { IntString } from './Aliases'

export interface RelayHubConfiguration {
  gasOverhead: number
  postOverhead: number
  gasReserve: number
  maxWorkerCount: number
  minimumUnstakeDelay: number
  minimumStake: IntString
  maximumRecipientDeposit: IntString
  dataGasCostPerByte: number
  relayCallDataOverhead: number
}
