import { PrefixedHexString, Transaction } from 'ethereumjs-tx'
import { HttpProvider, TransactionReceipt } from 'web3-core'
import { constants } from '../common/Constants'

import RelayRequest from '../common/EIP712/RelayRequest'
import RelayTransactionRequest from './types/RelayTransactionRequest'
import GsnTransactionDetails from './types/GsnTransactionDetails'
import { Address, AsyncDataCallback, PingFilter } from './types/Aliases'
import HttpClient from './HttpClient'
import ContractInteractor from './ContractInteractor'
import RelaySelectionManager from './RelaySelectionManager'
import { IKnownRelaysManager } from './KnownRelaysManager'
import AccountManager from './AccountManager'
import RelayedTransactionValidator from './RelayedTransactionValidator'
import { configureGSN, getDependencies, GSNConfig, GSNDependencies } from './GSNConfigurator'
import { RelayInfo } from './types/RelayInfo'
import { decodeRevertReason } from '../common/Utils'

// generate "approvalData" and "paymasterData" for a request.
// both are bytes arrays. paymasterData is part of the client request.
// approvalData is created after request is filled and signed.
export const EmptyDataCallback: AsyncDataCallback = async (): Promise<PrefixedHexString> => {
  return await Promise.resolve('0x')
}

export const GasPricePingFilter: PingFilter = (pingResponse, gsnTransactionDetails) => {
  if (
    gsnTransactionDetails.gasPrice != null &&
    parseInt(pingResponse.MinGasPrice) > parseInt(gsnTransactionDetails.gasPrice)
  ) {
    throw new Error(`Proposed gas price: ${gsnTransactionDetails.gasPrice}; relay's MinGasPrice: ${pingResponse.MinGasPrice}`)
  }
}

interface RelayingAttempt {
  transaction?: Transaction
  error?: Error
}

export interface RelayingResult {
  transaction?: Transaction
  pingErrors: Map<string, Error>
  relayingErrors: Map<string, Error>
}

export class RelayClient {
  readonly config: GSNConfig
  private readonly httpClient: HttpClient
  protected contractInteractor: ContractInteractor
  protected knownRelaysManager: IKnownRelaysManager
  private readonly asyncApprovalData: AsyncDataCallback
  private readonly asyncPaymasterData: AsyncDataCallback
  private readonly transactionValidator: RelayedTransactionValidator
  private readonly pingFilter: PingFilter

  public readonly accountManager: AccountManager
  private initialized = false

  /**
   * create a RelayClient library object, to force contracts to go through a relay.
   */
  constructor (
    provider: HttpProvider,
    configOverride: Partial<GSNConfig>,
    overrideDependencies?: Partial<GSNDependencies>
  ) {
    const config = configureGSN(configOverride)
    const dependencies = getDependencies(config, provider, overrideDependencies)

    this.config = dependencies.config
    this.httpClient = dependencies.httpClient
    this.contractInteractor = dependencies.contractInteractor
    this.knownRelaysManager = dependencies.knownRelaysManager
    this.transactionValidator = dependencies.transactionValidator
    this.accountManager = dependencies.accountManager
    this.pingFilter = dependencies.pingFilter
    this.asyncApprovalData = dependencies.asyncApprovalData
    this.asyncPaymasterData = dependencies.asyncPaymasterData
  }

  /**
   * In case Relay Server does not broadcast the signed transaction to the network,
   * client also broadcasts the same transaction. If the transaction fails with nonce
   * error, it indicates Relay may have signed multiple transactions with same nonce,
   * causing a DoS attack.
   *
   * @param {*} transaction - actual Ethereum transaction, signed by a relay
   */
  async _broadcastRawTx (transaction: Transaction): Promise<{ receipt?: TransactionReceipt, broadcastError?: Error, wrongNonce?: boolean }> {
    const rawTx = '0x' + transaction.serialize().toString('hex')
    const txHash = '0x' + transaction.hash(true).toString('hex')
    if (this.config.verbose) {
      console.log('txHash= ' + txHash)
    }
    try {
      const receipt = await this.contractInteractor.sendSignedTransaction(rawTx)
      return { receipt }
    } catch (broadcastError) {
      // don't display error for the known-good cases
      if (broadcastError?.message.match(/the tx doesn't have the correct nonce|known transaction/) != null) {
        return {
          wrongNonce: true,
          broadcastError
        }
      }
      return { broadcastError }
    }
  }

  async _init (): Promise<void> {
    await this.contractInteractor.init()
    this.initialized = true
  }

  async relayTransaction (gsnTransactionDetails: GsnTransactionDetails): Promise<RelayingResult> {
    if (!this.initialized) {
      await this._init()
    }
    // TODO: should have a better strategy to decide how often to refresh known relays
    await this.knownRelaysManager.refresh()
    gsnTransactionDetails.gasPrice = gsnTransactionDetails.forceGasPrice ?? await this._calculateGasPrice()
    if (gsnTransactionDetails.gas == null) {
      const estimated = await this.contractInteractor.estimateGas(gsnTransactionDetails)
      gsnTransactionDetails.gas = `0x${estimated.toString(16)}`
    }
    const relaySelectionManager = new RelaySelectionManager(gsnTransactionDetails, this.knownRelaysManager, this.httpClient, this.pingFilter, this.config)
    const relayingErrors = new Map<string, Error>()
    while (true) {
      let relayingAttempt: RelayingAttempt | undefined
      const activeRelay = await relaySelectionManager.selectNextRelay(gsnTransactionDetails)
      if (activeRelay != null) {
        relayingAttempt = await this._attemptRelay(activeRelay, gsnTransactionDetails)
          .catch(error => ({ error }))
        if (relayingAttempt.transaction == null) {
          relayingErrors.set(activeRelay.relayInfo.relayUrl, relayingAttempt.error ?? new Error('No error reason was given'))
          continue
        }
      }
      return {
        transaction: relayingAttempt?.transaction,
        relayingErrors,
        pingErrors: relaySelectionManager.errors
      }
    }
  }

  async _calculateGasPrice (): Promise<PrefixedHexString> {
    const pct = this.config.gasPriceFactorPercent
    const networkGasPrice = await this.contractInteractor.getGasPrice()
    let gasPrice = Math.round(parseInt(networkGasPrice) * (pct + 100) / 100)
    if (this.config.minGasPrice != null && gasPrice < this.config.minGasPrice) {
      gasPrice = this.config.minGasPrice
    }
    return `0x${gasPrice.toString(16)}`
  }

  async _attemptRelay (
    relayInfo: RelayInfo,
    gsnTransactionDetails: GsnTransactionDetails
  ): Promise<RelayingAttempt> {
    if (this.config.verbose) {
      console.log(`attempting relay: ${JSON.stringify(relayInfo)} transaction: ${JSON.stringify(gsnTransactionDetails)}`)
    }
    const { relayRequest, approvalData, signature, httpRequest, maxAcceptanceBudget } =
      await this._prepareRelayHttpRequest(relayInfo, gsnTransactionDetails)
    const acceptRelayCallResult = await this.contractInteractor.validateAcceptRelayCall(maxAcceptanceBudget, relayRequest, signature, approvalData)
    if (!acceptRelayCallResult.paymasterAccepted) {
      let message: string
      if (acceptRelayCallResult.reverted) {
        message = 'local view call to \'relayCall()\' reverted'
      } else {
        message = 'paymaster rejected in local view call to \'relayCall()\' '
      }
      return { error: new Error(`${message}: ${decodeRevertReason(acceptRelayCallResult.returnValue)}`) }
    }
    let hexTransaction: PrefixedHexString
    try {
      hexTransaction = await this.httpClient.relayTransaction(relayInfo.relayInfo.relayUrl, httpRequest)
    } catch (error) {
      if (error?.message == null || error.message.indexOf('timeout') !== -1) {
        this.knownRelaysManager.saveRelayFailure(new Date().getTime(), relayInfo.relayInfo.relayManager, relayInfo.relayInfo.relayUrl)
      }
      if (this.config.verbose) {
        console.log('relayTransaction: ', JSON.stringify(httpRequest))
      }
      return { error }
    }
    const transaction = new Transaction(hexTransaction, this.contractInteractor.getRawTxOptions())
    if (!this.transactionValidator.validateRelayResponse(httpRequest, maxAcceptanceBudget, hexTransaction)) {
      this.knownRelaysManager.saveRelayFailure(new Date().getTime(), relayInfo.relayInfo.relayManager, relayInfo.relayInfo.relayUrl)
      return { error: new Error('Returned transaction did not pass validation') }
    }
    await this._broadcastRawTx(transaction)
    return {
      transaction
    }
  }

  async _prepareRelayHttpRequest (
    relayInfo: RelayInfo,
    gsnTransactionDetails: GsnTransactionDetails
  ): Promise<{ relayRequest: RelayRequest, relayMaxNonce: number, maxAcceptanceBudget: number, approvalData: PrefixedHexString, signature: PrefixedHexString, httpRequest: RelayTransactionRequest }> {
    const forwarderAddress = await this.resolveForwarder(gsnTransactionDetails)
    const paymaster = gsnTransactionDetails.paymaster ?? this.config.paymasterAddress

    const senderNonce = await this.contractInteractor.getSenderNonce(gsnTransactionDetails.from, forwarderAddress)
    const relayWorker = relayInfo.pingResponse.RelayServerAddress
    const gasPriceHex = gsnTransactionDetails.gasPrice
    const gasLimitHex = gsnTransactionDetails.gas
    if (gasPriceHex == null || gasLimitHex == null) {
      throw new Error('RelayClient internal exception. Gas price or gas limit still not calculated. Cannot happen.')
    }
    if (gasPriceHex.indexOf('0x') !== 0) {
      throw new Error(`Invalid gasPrice hex string: ${gasPriceHex}`)
    }
    if (gasLimitHex.indexOf('0x') !== 0) {
      throw new Error(`Invalid gasLimit hex string: ${gasLimitHex}`)
    }
    const gasLimit = parseInt(gasLimitHex, 16).toString()
    const gasPrice = parseInt(gasPriceHex, 16).toString()
    const value = gsnTransactionDetails.value ?? '0'
    const relayRequest: RelayRequest = {
      request: {
        to: gsnTransactionDetails.to,
        data: gsnTransactionDetails.data,
        from: gsnTransactionDetails.from,
        value: value,
        nonce: senderNonce,
        gas: gasLimit
      },
      relayData: {
        pctRelayFee: relayInfo.relayInfo.pctRelayFee,
        baseRelayFee: relayInfo.relayInfo.baseRelayFee,
        gasPrice,
        paymaster,
        paymasterData: '', // temp value. filled in by asyncPaymasterData, below.
        clientId: this.config.clientId,
        forwarder: forwarderAddress,
        relayWorker
      }
    }
    const paymasterData = await this.asyncPaymasterData(relayRequest)

    // put paymasterData into struct before signing
    relayRequest.relayData.paymasterData = paymasterData
    const signature = await this.accountManager.sign(relayRequest)
    const approvalData = await this.asyncApprovalData(relayRequest)
    // max nonce is not signed, as contracts cannot access addresses' nonces.
    const transactionCount = await this.contractInteractor.getTransactionCount(relayWorker)
    const relayMaxNonce = transactionCount + this.config.maxRelayNonceGap
    // TODO: the server accepts a flat object, and that is why this code looks like shit.
    //  Must teach server to accept correct types
    const httpRequest: RelayTransactionRequest = {
      relayWorker: relayInfo.pingResponse.RelayServerAddress,
      data: gsnTransactionDetails.data,
      senderNonce: relayRequest.request.nonce,
      from: gsnTransactionDetails.from,
      to: gsnTransactionDetails.to,
      pctRelayFee: relayInfo.relayInfo.pctRelayFee,
      baseRelayFee: relayInfo.relayInfo.baseRelayFee,
      value,
      gasPrice,
      gasLimit,
      paymaster: paymaster,
      paymasterData,
      clientId: this.config.clientId,
      forwarder: forwarderAddress,
      signature,
      approvalData,
      relayHubAddress: this.config.relayHubAddress,
      relayMaxNonce
    }
    if (this.config.verbose) {
      console.log(`Created HTTP relay request: ${JSON.stringify(httpRequest)}`)
    }
    const maxAcceptanceBudget = parseInt(relayInfo.pingResponse.MaxAcceptanceBudget)

    return {
      relayRequest,
      relayMaxNonce,
      maxAcceptanceBudget,
      approvalData,
      signature,
      httpRequest
    }
  }

  async resolveForwarder (gsnTransactionDetails: GsnTransactionDetails): Promise<Address> {
    let forwarderAddress = gsnTransactionDetails.forwarder ?? this.config.forwarderAddress
    if (forwarderAddress !== constants.ZERO_ADDRESS) {
      const isRecipientDeployed = await this.contractInteractor.isContractDeployed(gsnTransactionDetails.to)
      if (!isRecipientDeployed) {
        console.warn(`No IRelayRecipient code at ${gsnTransactionDetails.to}, proceeding without validating 'isTrustedForwarder'!
        Unless you are using some counterfactual contract deployment technique the transaction will fail!`)
      } else {
        const isTrusted = await this.contractInteractor.isTrustedForwarder(gsnTransactionDetails.to, forwarderAddress)
        if (!isTrusted) {
          throw new Error('The Forwarder address configured but is not trusted by the Recipient contract')
        }
      }
    } else {
      try {
        if (this.config.verbose) {
          console.log(`will attempt to get trusted forwarder from: ${gsnTransactionDetails.to}`)
        }
        forwarderAddress = await this.contractInteractor.getForwarder(gsnTransactionDetails.to)
        if (this.config.verbose) {
          console.log(`on-chain forwarder for: ${gsnTransactionDetails.to} is ${forwarderAddress}`)
        }
      } catch (e) {
        throw new Error('No forwarder address configured and no getTrustedForwarder in target contract (fetching from Recipient failed)')
      }
    }

    return forwarderAddress
  }
}
