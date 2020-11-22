import { HttpProvider } from 'web3-core'

import { LoggerInterface } from '../common/LoggerInterface'
import { constants } from '../common/Constants'
import { defaultEnvironment } from '../common/Environments'

import AccountManager from './AccountManager'
import ContractInteractor, { Web3Provider } from './ContractInteractor'
import HttpClient from './HttpClient'
import HttpWrapper from './HttpWrapper'
import KnownRelaysManager, { DefaultRelayScore, EmptyFilter, IKnownRelaysManager } from './KnownRelaysManager'
import RelayedTransactionValidator from './RelayedTransactionValidator'
import {
  Address,
  AsyncDataCallback,
  AsyncScoreCalculator,
  IntString,
  NpmLogLevel,
  PingFilter,
  RelayFilter
} from './types/Aliases'
import { EmptyDataCallback, GasPricePingFilter } from './RelayClient'
import { createClientLogger } from './ClientWinstonLogger'

const GAS_PRICE_PERCENT = 20
const MAX_RELAY_NONCE_GAP = 3
const DEFAULT_RELAY_TIMEOUT_GRACE_SEC = 1800
const DEFAULT_LOOKUP_WINDOW_BLOCKS = 60000

const defaultGsnConfig: GSNConfig = {
  skipRecipientForwarderValidation: false,
  preferredRelays: [],
  relayLookupWindowBlocks: DEFAULT_LOOKUP_WINDOW_BLOCKS,
  relayLookupWindowParts: 1,
  gasPriceFactorPercent: GAS_PRICE_PERCENT,
  gasPriceOracleUrl: '',
  gasPriceOraclePath: '',
  minGasPrice: 0,
  maxRelayNonceGap: MAX_RELAY_NONCE_GAP,
  sliceSize: 3,
  relayTimeoutGrace: DEFAULT_RELAY_TIMEOUT_GRACE_SEC,
  methodSuffix: '',
  jsonStringifyRequest: false,
  chainId: defaultEnvironment.chainId,
  relayHubAddress: constants.ZERO_ADDRESS,
  paymasterAddress: constants.ZERO_ADDRESS,
  forwarderAddress: constants.ZERO_ADDRESS,
  logLevel: 'debug',
  loggerUrl: '',
  loggerApplicationId: '',
  loggerUserIdOverride: '',
  clientId: '1'
}

/**
 * All classes in GSN must be configured correctly with non-null values.
 * Yet it is tedious to provide default values to all configuration fields on new instance creation.
 * This helper allows users to provide only the overrides and the remainder of values will be set automatically.
 */
export function configureGSN (partialConfig: Partial<GSNConfig>): GSNConfig {
  return Object.assign({}, defaultGsnConfig, partialConfig) as GSNConfig
}

/**
 * Same as {@link configureGSN} but also resolves the GSN deployment from Paymaster
 * @param provider - web3 provider needed to query blockchain
 * @param partialConfig
 */
export async function resolveConfigurationGSN (provider: Web3Provider, partialConfig: Partial<GSNConfig>): Promise<GSNConfig> {
  // @ts-ignore
  if (provider.send == null && provider.sendAsync == null) {
    throw new Error('First param is not a web3 provider')
  }

  if (partialConfig.paymasterAddress == null) {
    throw new Error('Cannot resolve GSN deployment without paymaster address')
  }

  const tmpConfig = Object.assign({}, partialConfig, defaultGsnConfig)
  const logger = createClientLogger(tmpConfig.logLevel, tmpConfig.loggerUrl, tmpConfig.loggerApplicationId, tmpConfig.loggerUserIdOverride)
  const contractInteractor = new ContractInteractor(provider, logger, defaultGsnConfig)
  const paymasterInstance = await contractInteractor._createPaymaster(partialConfig.paymasterAddress)

  const [
    chainId, relayHubAddress, forwarderAddress
  ] = await Promise.all([

    partialConfig.chainId ?? contractInteractor.getAsyncChainId(),
    // @ts-ignore
    partialConfig.relayHubAddress ?? paymasterInstance.getHubAddr().catch(e => { throw new Error(`Not a paymaster contract: ${(e as Error).message}`) }),
    // @ts-ignore
    partialConfig.forwarderAddress ?? paymasterInstance.trustedForwarder().catch(e => { throw new Error(`paymaster has no trustedForwarder(): ${(e as Error).message}`) }),
    paymasterInstance.versionPaymaster().catch((e: any) => { throw new Error('Not a paymaster contract') }).then((version: string) => contractInteractor._validateVersion(version))
      .catch(err => console.log('WARNING: beta ignore version compatibility', err))
  ])

  const isMetamask: boolean = (provider as any).isMetaMask

  // provide defaults valid for metamask (unless explicitly specified values)
  const methodSuffix = partialConfig.methodSuffix ?? (isMetamask ? '_v4' : defaultGsnConfig.methodSuffix)
  const jsonStringifyRequest = partialConfig.jsonStringifyRequest ?? (isMetamask ? true : defaultGsnConfig.jsonStringifyRequest)

  const resolvedConfig = {
    relayHubAddress,
    forwarderAddress,
    chainId,
    methodSuffix,
    jsonStringifyRequest
  }
  return {
    ...defaultGsnConfig,
    ...partialConfig,
    ...resolvedConfig
  }
}

/**
 * @field methodSuffix - allows use of versioned methods, i.e. 'eth_signTypedData_v4'. Should be '_v4' for Metamask
 * @field jsonStringifyRequest - should be 'true' for Metamask, false for ganache
 */
export interface GSNConfig {
  skipRecipientForwarderValidation: boolean
  preferredRelays: string[]
  relayLookupWindowBlocks: number
  relayLookupWindowParts: number
  methodSuffix: string
  jsonStringifyRequest: boolean
  requiredVersionRange?: string
  relayTimeoutGrace: number
  sliceSize: number
  logLevel: NpmLogLevel
  loggerUrl: string
  loggerApplicationId: string
  loggerUserIdOverride: string
  gasPriceFactorPercent: number
  gasPriceOracleUrl: string
  gasPriceOraclePath: string
  minGasPrice: number
  maxRelayNonceGap: number
  relayHubAddress: Address
  paymasterAddress: Address
  forwarderAddress: Address
  chainId: number
  clientId: IntString
}

export interface GSNDependencies {
  httpClient: HttpClient
  logger: LoggerInterface
  contractInteractor: ContractInteractor
  knownRelaysManager: IKnownRelaysManager
  accountManager: AccountManager
  transactionValidator: RelayedTransactionValidator
  pingFilter: PingFilter
  relayFilter: RelayFilter
  asyncApprovalData: AsyncDataCallback
  asyncPaymasterData: AsyncDataCallback
  scoreCalculator: AsyncScoreCalculator
}

export function getDependencies (config: GSNConfig, provider?: HttpProvider, overrideDependencies?: Partial<GSNDependencies>): GSNDependencies {
  const logger = overrideDependencies?.logger ?? createClientLogger(config.logLevel, config.loggerUrl, config.loggerApplicationId, config.loggerUserIdOverride)
  let contractInteractor = overrideDependencies?.contractInteractor

  if (contractInteractor == null) {
    if (provider != null) {
      contractInteractor = new ContractInteractor(provider, logger, config)
    } else {
      throw new Error('either contract interactor or web3 provider must be non-null')
    }
  }

  let accountManager = overrideDependencies?.accountManager
  if (accountManager == null) {
    if (provider != null) {
      accountManager = new AccountManager(provider, config.chainId ?? contractInteractor.getChainId(), config)
    } else {
      throw new Error('either account manager or web3 provider must be non-null')
    }
  }

  const httpClient = overrideDependencies?.httpClient ?? new HttpClient(new HttpWrapper(), logger, config)
  const pingFilter = overrideDependencies?.pingFilter ?? GasPricePingFilter
  const relayFilter = overrideDependencies?.relayFilter ?? EmptyFilter
  const asyncApprovalData = overrideDependencies?.asyncApprovalData ?? EmptyDataCallback
  const asyncPaymasterData = overrideDependencies?.asyncPaymasterData ?? EmptyDataCallback
  const scoreCalculator = overrideDependencies?.scoreCalculator ?? DefaultRelayScore
  const knownRelaysManager = overrideDependencies?.knownRelaysManager ?? new KnownRelaysManager(contractInteractor, logger, config, relayFilter)
  const transactionValidator = overrideDependencies?.transactionValidator ?? new RelayedTransactionValidator(contractInteractor, logger, config)

  const ret: GSNDependencies = {
    httpClient,
    contractInteractor,
    knownRelaysManager,
    accountManager,
    transactionValidator,
    pingFilter,
    relayFilter,
    asyncApprovalData,
    asyncPaymasterData,
    scoreCalculator,
    logger
  }

  // sanity check: overrides must not contain unknown fields.
  for (const key in overrideDependencies) {
    if ((ret as any)[key] == null) {
      throw new Error(`Unexpected override key ${key}`)
    }
  }

  return ret
}
