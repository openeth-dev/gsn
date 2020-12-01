import Web3 from 'web3'
import { BlockTransactionString } from 'web3-eth'
import { EventData, PastEventOptions } from 'web3-eth-contract'
import { PrefixedHexString, TransactionOptions } from 'ethereumjs-tx'
import { toBN, toHex } from 'web3-utils'
import {
  BlockNumber,
  Transaction,
  TransactionReceipt
} from 'web3-core'

import abi from 'web3-eth-abi'
import RelayRequest from './EIP712/RelayRequest'
import paymasterAbi from './interfaces/IPaymaster.json'
import relayHubAbi from './interfaces/IRelayHub.json'
import forwarderAbi from './interfaces/IForwarder.json'
import stakeManagerAbi from './interfaces/IStakeManager.json'
import penalizerAbi from './interfaces/IPenalizer.json'
import gsnRecipientAbi from './interfaces/IRelayRecipient.json'
import knowForwarderAddressAbi from './interfaces/IKnowForwarderAddress.json'

import VersionsManager from './VersionsManager'
import replaceErrors from './ErrorReplacerJSON'
import { LoggerInterface } from './LoggerInterface'
import { decodeRevertReason, event2topic } from './Utils'
import {
  BaseRelayRecipientInstance,
  IForwarderInstance,
  IKnowForwarderAddressInstance,
  IPaymasterInstance,
  IPenalizerInstance,
  IRelayHubInstance,
  IRelayRecipientInstance,
  IStakeManagerInstance
} from '../../types/truffle-contracts'

import { Address, IntString, Web3ProviderBaseInterface } from './types/Aliases'
import GsnTransactionDetails from './types/GsnTransactionDetails'

import { Contract, TruffleContract } from '../relayclient/LightTruffleContract'
import { gsnRuntimeVersion } from './Version'
import Common from 'ethereumjs-common'
import { GSNContractsDeployment } from './GSNContractsDeployment'
import TransactionDetails = Truffle.TransactionDetails

require('source-map-support').install({ errorFormatterForce: true })

type EventName = string

export const RelayServerRegistered: EventName = 'RelayServerRegistered'
export const RelayWorkersAdded: EventName = 'RelayWorkersAdded'
export const TransactionRelayed: EventName = 'TransactionRelayed'
export const TransactionRejectedByPaymaster: EventName = 'TransactionRejectedByPaymaster'

const ActiveManagerEvents = [RelayServerRegistered, RelayWorkersAdded, TransactionRelayed, TransactionRejectedByPaymaster]

export const HubAuthorized: EventName = 'HubAuthorized'
export const HubUnauthorized: EventName = 'HubUnauthorized'
export const StakeAdded: EventName = 'StakeAdded'
export const StakeUnlocked: EventName = 'StakeUnlocked'
export const StakeWithdrawn: EventName = 'StakeWithdrawn'
export const StakePenalized: EventName = 'StakePenalized'

export interface ConstructorParams {
  provider: Web3ProviderBaseInterface
  logger: LoggerInterface
  versionManager?: VersionsManager
  deployment?: GSNContractsDeployment
}

export default class ContractInteractor {
  private readonly IPaymasterContract: Contract<IPaymasterInstance>
  private readonly IRelayHubContract: Contract<IRelayHubInstance>
  private readonly IForwarderContract: Contract<IForwarderInstance>
  private readonly IStakeManager: Contract<IStakeManagerInstance>
  private readonly IPenalizer: Contract<IPenalizerInstance>
  private readonly IRelayRecipient: Contract<BaseRelayRecipientInstance>
  private readonly IKnowForwarderAddress: Contract<IKnowForwarderAddressInstance>

  private paymasterInstance!: IPaymasterInstance
  relayHubInstance!: IRelayHubInstance
  private forwarderInstance!: IForwarderInstance
  private stakeManagerInstance!: IStakeManagerInstance
  penalizerInstance!: IPenalizerInstance
  private relayRecipientInstance?: BaseRelayRecipientInstance
  private knowForwarderAddressInstance?: IKnowForwarderAddressInstance
  private readonly relayCallMethod: any

  readonly web3: Web3
  private readonly provider: Web3ProviderBaseInterface
  private deployment: GSNContractsDeployment
  private readonly versionManager: VersionsManager
  private readonly logger: LoggerInterface

  private rawTxOptions?: TransactionOptions
  chainId!: number
  private networkId?: number
  private networkType?: string

  constructor (
    {
      provider,
      versionManager,
      logger,
      deployment = {}
    }: ConstructorParams) {
    this.logger = logger
    this.versionManager = versionManager ?? new VersionsManager(gsnRuntimeVersion)
    this.web3 = new Web3(provider as any)
    this.deployment = deployment
    this.provider = provider
    // @ts-ignore
    this.IPaymasterContract = TruffleContract({
      contractName: 'IPaymaster',
      abi: paymasterAbi
    })
    // @ts-ignore
    this.IRelayHubContract = TruffleContract({
      contractName: 'IRelayHub',
      abi: relayHubAbi
    })
    // @ts-ignore
    this.IForwarderContract = TruffleContract({
      contractName: 'IForwarder',
      abi: forwarderAbi
    })
    // @ts-ignore
    this.IStakeManager = TruffleContract({
      contractName: 'IStakeManager',
      abi: stakeManagerAbi
    })
    // @ts-ignore
    this.IPenalizer = TruffleContract({
      contractName: 'IPenalizer',
      abi: penalizerAbi
    })
    // @ts-ignore
    this.IRelayRecipient = TruffleContract({
      contractName: 'IRelayRecipient',
      abi: gsnRecipientAbi
    })
    // @ts-ignore
    this.IKnowForwarderAddress = TruffleContract({
      contractName: 'IKnowForwarderAddress',
      abi: knowForwarderAddressAbi
    })
    this.IStakeManager.setProvider(this.provider, undefined)
    this.IRelayHubContract.setProvider(this.provider, undefined)
    this.IPaymasterContract.setProvider(this.provider, undefined)
    this.IForwarderContract.setProvider(this.provider, undefined)
    this.IPenalizer.setProvider(this.provider, undefined)
    this.IRelayRecipient.setProvider(this.provider, undefined)
    this.IKnowForwarderAddress.setProvider(this.provider, undefined)

    this.relayCallMethod = this.IRelayHubContract.createContract('').methods.relayCall
  }

  async init (): Promise<ContractInteractor> {
    if (this.rawTxOptions != null) {
      throw new Error('_init was already called')
    }
    await this._resolveDeployment()
    await this._initializeContracts()
    await this._validateCompatibility().catch(err => console.log('WARNING: beta ignore version compatibility', err.message))
    const chain = await this.web3.eth.net.getNetworkType()
    this.chainId = await this.web3.eth.getChainId()
    this.networkId = await this.web3.eth.net.getId()
    this.networkType = await this.web3.eth.net.getNetworkType()
    // chain === 'private' means we're on ganache, and ethereumjs-tx.Transaction doesn't support that chain type
    this.rawTxOptions = getRawTxOptions(this.chainId, this.networkId, chain)
    return this
  }

  async _resolveDeployment (): Promise<void> {
    if (this.deployment.paymasterAddress != null && this.deployment.relayHubAddress != null) {
      this.logger.warn('Already resolved!')
      return
    }

    if (this.deployment.paymasterAddress != null) {
      await this._resolveDeploymentFromPaymaster(this.deployment.paymasterAddress)
    } else if (this.deployment.relayHubAddress != null) {
      await this._resolveDeploymentFromRelayHub(this.deployment.relayHubAddress)
    } else {
      this.logger.info(`Contract interactor cannot resolve a full deployment from the following input: ${JSON.stringify(this.deployment)}`)
    }
  }

  async _resolveDeploymentFromPaymaster (paymasterAddress: Address): Promise<void> {
    this.paymasterInstance = await this._createPaymaster(paymasterAddress)
    const [
      relayHubAddress, forwarderAddress, paymasterVersion
    ] = await Promise.all([
      this.paymasterInstance.getHubAddr().catch((e: Error) => { throw new Error(`Not a paymaster contract: ${e.message}`) }),
      this.paymasterInstance.trustedForwarder().catch((e: Error) => { throw new Error(`paymaster has no trustedForwarder(): ${e.message}`) }),
      this.paymasterInstance.versionPaymaster().catch((e: Error) => { throw new Error(`Not a paymaster contract: ${e.message}`) }).then((version: string) => {
        this._validateVersion(version)
        return version
      })
    ])
    this.deployment.relayHubAddress = relayHubAddress
    this.deployment.forwarderAddress = forwarderAddress
    this.deployment.paymasterVersion = paymasterVersion
    await this._resolveDeploymentFromRelayHub(relayHubAddress)
  }

  async _resolveDeploymentFromRelayHub (relayHubAddress: Address): Promise<void> {
    this.relayHubInstance = await this._createRelayHub(relayHubAddress)
    const [stakeManagerAddress, penalizerAddress] = await Promise.all([
      this.relayHubInstance.stakeManager(),
      this.relayHubInstance.penalizer()
    ])
    this.deployment.relayHubAddress = relayHubAddress
    this.deployment.stakeManagerAddress = stakeManagerAddress
    this.deployment.penalizerAddress = penalizerAddress
  }

  async _validateCompatibility (): Promise<void> {
    if (this.deployment == null) {
      return
    }
    const hub = this.relayHubInstance
    const version = await hub.versionHub()
    this._validateVersion(version)
  }

  _validateVersion (version: string): void {
    const versionSatisfied = this.versionManager.isRequiredVersionSatisfied(version)
    if (!versionSatisfied) {
      throw new Error(`Provided Hub version(${version}) does not satisfy the requirement(${this.versionManager.requiredVersionRange})`)
    }
  }

  async _initializeContracts (): Promise<void> {
    if (this.relayHubInstance == null && this.deployment.relayHubAddress != null) {
      this.relayHubInstance = await this._createRelayHub(this.deployment.relayHubAddress)
    }
    if (this.paymasterInstance == null && this.deployment.paymasterAddress != null) {
      this.paymasterInstance = await this._createPaymaster(this.deployment.paymasterAddress)
    }
    if (this.deployment.forwarderAddress != null) {
      this.forwarderInstance = await this._createForwarder(this.deployment.forwarderAddress)
    }
    if (this.deployment.stakeManagerAddress != null) {
      this.stakeManagerInstance = await this._createStakeManager(this.deployment.stakeManagerAddress)
    }
    if (this.deployment.penalizerAddress != null) {
      this.penalizerInstance = await this._createPenalizer(this.deployment.penalizerAddress)
    }
  }

  // must use these options when creating Transaction object
  getRawTxOptions (): TransactionOptions {
    if (this.rawTxOptions == null) {
      throw new Error('_init not called')
    }
    return this.rawTxOptions
  }

  async _createKnowsForwarder (address: Address): Promise<IKnowForwarderAddressInstance> {
    if (this.knowForwarderAddressInstance != null && this.knowForwarderAddressInstance.address.toLowerCase() === address.toLowerCase()) {
      return this.knowForwarderAddressInstance
    }
    this.knowForwarderAddressInstance = await this.IKnowForwarderAddress.at(address)
    return this.knowForwarderAddressInstance
  }

  async _createRecipient (address: Address): Promise<IRelayRecipientInstance> {
    if (this.relayRecipientInstance != null && this.relayRecipientInstance.address.toLowerCase() === address.toLowerCase()) {
      return this.relayRecipientInstance
    }
    this.relayRecipientInstance = await this.IRelayRecipient.at(address)
    return this.relayRecipientInstance
  }

  async _createPaymaster (address: Address): Promise<IPaymasterInstance> {
    return await this.IPaymasterContract.at(address)
  }

  async _createRelayHub (address: Address): Promise<IRelayHubInstance> {
    return await this.IRelayHubContract.at(address)
  }

  async _createForwarder (address: Address): Promise<IForwarderInstance> {
    return await this.IForwarderContract.at(address)
  }

  async _createStakeManager (address: Address): Promise<IStakeManagerInstance> {
    return await this.IStakeManager.at(address)
  }

  async _createPenalizer (address: Address): Promise<IPenalizerInstance> {
    return await this.IPenalizer.at(address)
  }

  async getForwarder (recipientAddress: Address): Promise<Address> {
    const recipient = await this._createKnowsForwarder(recipientAddress)
    return await recipient.getTrustedForwarder()
  }

  async isTrustedForwarder (recipientAddress: Address, forwarder: Address): Promise<boolean> {
    const recipient = await this._createRecipient(recipientAddress)
    return await recipient.isTrustedForwarder(forwarder)
  }

  async getSenderNonce (sender: Address, forwarderAddress: Address): Promise<IntString> {
    const forwarder = await this._createForwarder(forwarderAddress)
    const nonce = await forwarder.getNonce(sender)
    return nonce.toString()
  }

  async _getBlockGasLimit (): Promise<number> {
    const latestBlock = await this.web3.eth.getBlock('latest')
    return latestBlock.gasLimit
  }

  /**
   * make a view call to relayCall(), just like the way it will be called by the relayer.
   * returns:
   * - paymasterAccepted - true if accepted
   * - reverted - true if relayCall was reverted.
   * - returnValue - if either reverted or paymaster NOT accepted, then this is the reason string.
   */
  async validateRelayCall (
    paymasterMaxAcceptanceBudget: number,
    relayRequest: RelayRequest,
    signature: PrefixedHexString,
    approvalData: PrefixedHexString): Promise<{ paymasterAccepted: boolean, returnValue: string, reverted: boolean }> {
    const relayHub = this.relayHubInstance
    try {
      const externalGasLimit = await this._getBlockGasLimit()
      const encodedRelayCall = relayHub.contract.methods.relayCall(
        paymasterMaxAcceptanceBudget,
        relayRequest,
        signature,
        approvalData,
        externalGasLimit
      ).encodeABI()
      const res: string = await new Promise((resolve, reject) => {
        // @ts-ignore
        this.web3.currentProvider.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [
            {
              from: relayRequest.relayData.relayWorker,
              to: relayHub.address,
              gasPrice: toHex(relayRequest.relayData.gasPrice),
              gas: toHex(externalGasLimit),
              data: encodedRelayCall
            },
            'latest'
          ]
        }, (err: any, res: { result: string }) => {
          const revertMsg = this._decodeRevertFromResponse(err, res)
          if (revertMsg != null) {
            reject(new Error(revertMsg))
          }
          if (err !== null) {
            reject(err)
          } else {
            resolve(res.result)
          }
        })
      })
      this.logger.debug('relayCall res=' + res)

      // @ts-ignore
      const decoded = abi.decodeParameters(['bool', 'bytes'], res)
      const paymasterAccepted: boolean = decoded[0]
      let returnValue: string
      if (paymasterAccepted) {
        returnValue = decoded[1]
      } else {
        returnValue = this._decodeRevertFromResponse({}, { result: decoded[1] }) ?? decoded[1]
      }
      return {
        returnValue: returnValue,
        paymasterAccepted: paymasterAccepted,
        reverted: false
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e, replaceErrors)
      return {
        paymasterAccepted: false,
        reverted: true,
        returnValue: `view call to 'relayCall' reverted in client: ${message}`
      }
    }
  }

  /**
   * decode revert from rpc response.
   * called from the callback of the provider "eth_call" call.
   * check if response is revert, and extract revert reason from it.
   * support kovan, geth, ganache error formats..
   * @param err - provider err value
   * @param res - provider res value
   */
  // decode revert from rpc response.
  //
  _decodeRevertFromResponse (err?: { message?: string, data?: any }, res?: { error?: any, result?: string }): string | null {
    const matchGanache = res?.error?.message?.match(/: revert (.*)/)
    if (matchGanache != null) {
      return matchGanache[1]
    }
    const m = err?.data?.match(/(0x08c379a0\S*)/)
    if (m != null) {
      return decodeRevertReason(m[1])
    }

    const result = res?.result ?? ''
    if (result.startsWith('0x08c379a0')) {
      return decodeRevertReason(result)
    }
    return null
  }

  encodeABI (paymasterMaxAcceptanceBudget: number, relayRequest: RelayRequest, sig: PrefixedHexString, approvalData: PrefixedHexString, externalGasLimit: IntString): PrefixedHexString {
    return this.relayCallMethod(paymasterMaxAcceptanceBudget, relayRequest, sig, approvalData, externalGasLimit).encodeABI()
  }

  async getPastEventsForHub (extraTopics: string[], options: PastEventOptions, names: EventName[] = ActiveManagerEvents): Promise<EventData[]> {
    return await this._getPastEvents(this.relayHubInstance.contract, names, extraTopics, options)
  }

  async getPastEventsForStakeManager (names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const stakeManager = await this.stakeManagerInstance
    return await this._getPastEvents(stakeManager.contract, names, extraTopics, options)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _getPastEvents (contract: any, names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const topics: string[][] = []
    const eventTopic = event2topic(contract, names)
    topics.push(eventTopic)
    if (extraTopics.length > 0) {
      topics.push(extraTopics)
    }
    return contract.getPastEvents('allEvents', Object.assign({}, options, { topics }))
  }

  async getBalance (address: Address, defaultBlock: BlockNumber = 'latest'): Promise<string> {
    return await this.web3.eth.getBalance(address, defaultBlock)
  }

  async getBlockNumber (): Promise<number> {
    return await this.web3.eth.getBlockNumber()
  }

  async sendSignedTransaction (rawTx: string): Promise<TransactionReceipt> {
    // noinspection ES6RedundantAwait - PromiEvent makes lint less happy about this line
    return await this.web3.eth.sendSignedTransaction(rawTx)
  }

  async estimateGas (gsnTransactionDetails: GsnTransactionDetails): Promise<number> {
    return await this.web3.eth.estimateGas(gsnTransactionDetails)
  }

  // TODO: cache response for some time to optimize. It doesn't make sense to optimize these requests in calling code.
  async getGasPrice (): Promise<string> {
    return await this.web3.eth.getGasPrice()
  }

  async getTransactionCount (address: string, defaultBlock?: BlockNumber): Promise<number> {
    // @ts-ignore (web3 does not define 'defaultBlock' as optional)
    return await this.web3.eth.getTransactionCount(address, defaultBlock)
  }

  async getTransaction (transactionHash: string): Promise<Transaction> {
    return await this.web3.eth.getTransaction(transactionHash)
  }

  async getBlock (blockHashOrBlockNumber: BlockNumber): Promise<BlockTransactionString> {
    return await this.web3.eth.getBlock(blockHashOrBlockNumber)
  }

  validateAddress (address: string, exceptionTitle = 'invalid address:'): void {
    if (!this.web3.utils.isAddress(address)) { throw new Error(exceptionTitle + ' ' + address) }
  }

  async getCode (address: string): Promise<string> {
    return await this.web3.eth.getCode(address)
  }

  getNetworkId (): number {
    if (this.networkId == null) {
      throw new Error('_init not called')
    }
    return this.networkId
  }

  getNetworkType (): string {
    if (this.networkType == null) {
      throw new Error('_init not called')
    }
    return this.networkType
  }

  async isContractDeployed (address: Address): Promise<boolean> {
    const code = await this.web3.eth.getCode(address)
    return code !== '0x'
  }

  async getStakeInfo (managerAddress: Address): Promise<{
    stake: string
    unstakeDelay: string
    withdrawBlock: string
    owner: string
  }> {
    const stakeManager = await this.stakeManagerInstance
    return await stakeManager.getStakeInfo(managerAddress)
  }

  /**
   * Gets balance of an address on the current RelayHub.
   * @param address - can be a Paymaster or a Relay Manger
   */
  async hubBalanceOf (address: Address): Promise<BN> {
    return await this.relayHubInstance.balanceOf(address)
  }

  async initDeployment (deployment: GSNContractsDeployment): Promise<void> {
    this.deployment = deployment
    await this._initializeContracts()
  }

  getDeployment (): GSNContractsDeployment {
    if (this.deployment == null) {
      throw new Error('Contracts deployment is not initialized for Contract Interactor!')
    }
    return this.deployment
  }

  async withdrawHubBalanceEstimateGas (amount: BN, destination: Address, managerAddress: Address, gasPrice: IntString): Promise<{
    gasCost: BN
    gasLimit: number
    method: any
  }> {
    const hub = this.relayHubInstance
    const method = hub.contract.methods.withdraw(amount.toString(), destination)
    const withdrawTxGasLimit = await method.estimateGas(
      {
        from: managerAddress
      })
    const gasCost = toBN(withdrawTxGasLimit).mul(toBN(gasPrice))
    return {
      gasLimit: parseInt(withdrawTxGasLimit),
      gasCost,
      method
    }
  }

  // TODO: a way to make a relay hub transaction with a specified nonce without exposing the 'method' abstraction
  async getRegisterRelayMethod (baseRelayFee: IntString, pctRelayFee: number, url: string): Promise<any> {
    const hub = this.relayHubInstance
    return hub.contract.methods.registerRelayServer(baseRelayFee, pctRelayFee, url)
  }

  async getAddRelayWorkersMethod (workers: Address[]): Promise<any> {
    const hub = this.relayHubInstance
    return hub.contract.methods.addRelayWorkers(workers)
  }

  /**
   * Web3.js as of 1.2.6 (see web3-core-method::_confirmTransaction) does not allow
   * broadcasting of a transaction without waiting for it to be mined.
   * This method sends the RPC call directly
   * @param signedTransaction - the raw signed transaction to broadcast
   */
  async broadcastTransaction (signedTransaction: PrefixedHexString): Promise<PrefixedHexString> {
    return await new Promise((resolve, reject) => {
      if (this.provider == null) {
        throw new Error('provider is not set')
      }
      this.provider.send({
        jsonrpc: '2.0',
        method: 'eth_sendRawTransaction',
        params: [
          signedTransaction
        ],
        id: Date.now()
      }, (e: Error | null, r: any) => {
        if (e != null) {
          reject(e)
        } else if (r.error != null) {
          reject(r.error)
        } else {
          resolve(r.result)
        }
      })
    })
  }

  async hubDepositFor (paymaster: Address, transactionDetails: TransactionDetails): Promise<any> {
    return await this.relayHubInstance.depositFor(paymaster, transactionDetails)
  }
}

/**
 * Ganache does not seem to enforce EIP-155 signature. Buidler does, though.
 * This is how {@link Transaction} constructor allows support for custom and private network.
 * @param chainId
 * @param networkId
 * @param chain
 * @return {{common: Common}}
 */
export function getRawTxOptions (chainId: number, networkId: number, chain?: string): TransactionOptions {
  if (chain == null || chain === 'main' || chain === 'private') {
    chain = 'mainnet'
  }
  return {
    common: Common.forCustomChain(
      chain,
      {
        chainId,
        networkId
      }, 'istanbul')
  }
}
