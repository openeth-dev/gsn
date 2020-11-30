import { PrefixedHexString, Transaction } from 'ethereumjs-tx'
import { bufferToHex } from 'ethereumjs-util'

import { isSameAddress } from '../common/Utils'

import ContractInteractor from '../common/ContractInteractor'
import { RelayTransactionRequest } from '../common/types/RelayTransactionRequest'
import { GSNConfig } from './GSNConfigurator'
import { LoggerInterface } from '../common/LoggerInterface'

export default class RelayedTransactionValidator {
  private readonly contractInteractor: ContractInteractor
  private readonly config: GSNConfig
  private readonly logger: LoggerInterface

  constructor (contractInteractor: ContractInteractor, logger: LoggerInterface, config: GSNConfig) {
    this.contractInteractor = contractInteractor
    this.config = config
    this.logger = logger
  }

  /**
   * Decode the signed transaction returned from the Relay Server, compare it to the
   * requested transaction and validate its signature.
   * @returns a signed {@link Transaction} instance for broadcasting, or null if returned
   * transaction is not valid.
   */
  validateRelayResponse (
    request: RelayTransactionRequest,
    maxAcceptanceBudget: number,
    returnedTx: PrefixedHexString
  ): boolean {
    const transaction = new Transaction(returnedTx, this.contractInteractor.getRawTxOptions())

    this.logger.info(`returnedTx:
    v:        ${bufferToHex(transaction.v)}
    r:        ${bufferToHex(transaction.r)}
    s:        ${bufferToHex(transaction.s)}
    to:       ${bufferToHex(transaction.to)}
    data:     ${bufferToHex(transaction.data)}
    gasLimit: ${bufferToHex(transaction.gasLimit)}
    gasPrice: ${bufferToHex(transaction.gasPrice)}
    value:    ${bufferToHex(transaction.value)}
    `)

    const signer = bufferToHex(transaction.getSenderAddress())

    const externalGasLimit = bufferToHex(transaction.gasLimit)
    const relayRequestAbiEncode = this.contractInteractor.encodeABI(maxAcceptanceBudget, request.relayRequest, request.metadata.signature, request.metadata.approvalData, externalGasLimit)

    const relayHubAddress = this.contractInteractor.getDeployment().relayHubAddress
    if (relayHubAddress == null) {
      throw new Error('no hub address')
    }

    if (
      isSameAddress(bufferToHex(transaction.to), relayHubAddress) &&
      relayRequestAbiEncode === bufferToHex(transaction.data) &&
      isSameAddress(request.relayRequest.relayData.relayWorker, signer)
    ) {
      this.logger.info('validateRelayResponse - valid transaction response')

      // TODO: the relayServer encoder returns zero-length buffer for nonce=0.`
      const receivedNonce = transaction.nonce.length === 0 ? 0 : transaction.nonce.readUIntBE(0, transaction.nonce.byteLength)
      if (receivedNonce > request.metadata.relayMaxNonce) {
        // TODO: need to validate that client retries the same request and doesn't double-spend.
        // Note that this transaction is totally valid from the EVM's point of view

        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`Relay used a tx nonce higher than requested. Requested ${request.metadata.relayMaxNonce} got ${receivedNonce}`)
      }

      return true
    } else {
      console.error('validateRelayResponse: req', relayRequestAbiEncode, relayHubAddress, request.relayRequest.relayData.relayWorker)
      console.error('validateRelayResponse: rsp', bufferToHex(transaction.data), bufferToHex(transaction.to), signer)
      return false
    }
  }
}
