// @ts-ignore
import io from 'console-read-write'
import BN from 'bn.js'
import HDWalletProvider from '@truffle/hdwallet-provider'
import Web3 from 'web3'
import { Contract, SendOptions } from 'web3-eth-contract'
import { HttpProvider, TransactionReceipt } from 'web3-core'
import { fromWei, toBN } from 'web3-utils'
import { merge } from 'lodash'

import { ether, isSameAddress, sleep } from '../common/Utils'

// compiled folder populated by "prepublish"
import StakeManager from './compiled/StakeManager.json'
import RelayHub from './compiled/RelayHub.json'
import Penalizer from './compiled/Penalizer.json'
import Paymaster from './compiled/TestPaymasterEverythingAccepted.json'
import Forwarder from './compiled/Forwarder.json'
import VersionRegistryAbi from './compiled/VersionRegistry.json'
import { Address } from '../common/types/Aliases'
import ContractInteractor from '../common/ContractInteractor'
import HttpClient from '../relayclient/HttpClient'
import { constants } from '../common/Constants'
import { RelayHubConfiguration } from '../common/types/RelayHubConfiguration'
import { string32 } from '../common/VersionRegistry'
import { registerForwarderForGsn } from '../common/EIP712/ForwarderUtil'
import { LoggerInterface } from '../common/LoggerInterface'
import HttpWrapper from '../relayclient/HttpWrapper'
import { GSNContractsDeployment } from '../common/GSNContractsDeployment'

require('source-map-support').install({ errorFormatterForce: true })

export interface RegisterOptions {
  from: Address
  gasPrice: string | BN
  stake: string | BN
  funds: string | BN
  relayUrl: string
  unstakeDelay: string
}

interface DeployOptions {
  from: Address
  gasPrice: string
  deployPaymaster?: boolean
  forwarderAddress?: string
  relayHubAddress?: string
  stakeManagerAddress?: string
  penalizerAddress?: string
  registryAddress?: string
  registryHubId?: string
  verbose?: boolean
  skipConfirmation?: boolean
  relayHubConfiguration: RelayHubConfiguration
}

interface RegistrationResult {
  success: boolean
  transactions?: string[]
  error?: string
}

export default class CommandsLogic {
  private readonly contractInteractor: ContractInteractor
  private readonly httpClient: HttpClient
  private readonly web3: Web3

  private deployment?: GSNContractsDeployment

  constructor (
    host: string,
    logger: LoggerInterface,
    deployment: GSNContractsDeployment,
    mnemonic?: string
  ) {
    let provider: HttpProvider | HDWalletProvider = new Web3.providers.HttpProvider(host)
    if (mnemonic != null) {
      // web3 defines provider type quite narrowly
      provider = new HDWalletProvider(mnemonic, provider) as unknown as HttpProvider
    }
    this.httpClient = new HttpClient(new HttpWrapper(), logger)
    this.contractInteractor = new ContractInteractor({ provider, logger, deployment })
    this.deployment = deployment
    this.web3 = new Web3(provider)
  }

  async init (): Promise<void> {
    await this.contractInteractor.init()
  }

  async findWealthyAccount (requiredBalance = ether('2')): Promise<string> {
    let accounts: string[] = []
    try {
      accounts = await this.web3.eth.getAccounts()
      for (const account of accounts) {
        const balance = new BN(await this.web3.eth.getBalance(account))
        if (balance.gte(requiredBalance)) {
          console.log(`Found funded account ${account}`)
          return account
        }
      }
    } catch (error) {
      console.error('Failed to retrieve accounts and balances:', error)
    }
    throw new Error(`could not find unlocked account with sufficient balance; all accounts:\n - ${accounts.join('\n - ')}`)
  }

  async isRelayReady (relayUrl: string): Promise<boolean> {
    const response = await this.httpClient.getPingResponse(relayUrl)
    return response.ready
  }

  async waitForRelay (relayUrl: string, timeout = 60): Promise<void> {
    console.error(`Will wait up to ${timeout}s for the relay to be ready`)

    const endTime = Date.now() + timeout * 1000
    while (Date.now() < endTime) {
      let isReady = false
      try {
        isReady = await this.isRelayReady(relayUrl)
      } catch (e) {
        console.log(e.message)
      }
      if (isReady) {
        return
      }
      await sleep(3000)
    }
    throw Error(`Relay not ready after ${timeout}s`)
  }

  async getPaymasterBalance (paymaster: Address): Promise<BN> {
    if (this.deployment == null) {
      throw new Error('Deployment is not initialized!')
    }
    return await this.contractInteractor.hubBalanceOf(paymaster)
  }

  /**
   * Send enough ether from the {@param from} to the RelayHub to make {@param paymaster}'s gas deposit exactly {@param amount}.
   * Does nothing if current paymaster balance exceeds amount.
   * @param from
   * @param paymaster
   * @param amount
   * @return deposit of the paymaster after
   */
  async fundPaymaster (
    from: Address, paymaster: Address, amount: string | BN
  ): Promise<BN> {
    if (this.deployment == null) {
      throw new Error('Deployment is not initialized!')
    }
    const currentBalance = await this.contractInteractor.hubBalanceOf(paymaster)
    const targetAmount = new BN(amount)
    if (currentBalance.lt(targetAmount)) {
      const value = targetAmount.sub(currentBalance)
      await this.contractInteractor.hubDepositFor(paymaster, {
        value,
        from
      })
      return targetAmount
    } else {
      return currentBalance
    }
  }

  async registerRelay (options: RegisterOptions): Promise<RegistrationResult> {
    const transactions: string[] = []
    try {
      console.log(`Registering GSN relayer at ${options.relayUrl}`)

      const response = await this.httpClient.getPingResponse(options.relayUrl)
        .catch(() => { throw new Error('could contact not relayer, is it running?') })
      if (response.ready) {
        return {
          success: false,
          error: 'Nothing to do. Relayer already registered'
        }
      }
      const chainId = this.contractInteractor.chainId
      if (response.chainId !== chainId.toString()) {
        throw new Error(`wrong chain-id: Relayer on (${response.chainId}) but our provider is on (${chainId})`)
      }
      const relayAddress = response.relayManagerAddress
      const relayHubAddress = response.relayHubAddress

      const relayHub = await this.contractInteractor._createRelayHub(relayHubAddress)
      const stakeManagerAddress = await relayHub.stakeManager()
      const stakeManager = await this.contractInteractor._createStakeManager(stakeManagerAddress)
      const { stake, unstakeDelay, owner } = await stakeManager.getStakeInfo(relayAddress)

      console.log('current stake=', fromWei(stake, 'ether'))

      if (owner !== constants.ZERO_ADDRESS && !isSameAddress(owner, options.from)) {
        throw new Error(`Already owned by ${owner}, our account=${options.from}`)
      }

      if (toBN(unstakeDelay).gte(toBN(options.unstakeDelay)) &&
        toBN(stake).gte(toBN(options.stake.toString()))
      ) {
        console.log('Relayer already staked')
      } else {
        const stakeValue = toBN(options.stake.toString()).sub(toBN(stake))
        console.log(`Staking relayer ${fromWei(stakeValue, 'ether')} eth`,
          stake === '0' ? '' : ` (already has ${fromWei(stake, 'ether')} eth)`)

        const stakeTx = await stakeManager
          .stakeForAddress(relayAddress, options.unstakeDelay.toString(), {
            value: stakeValue,
            from: options.from,
            gas: 1e6,
            gasPrice: options.gasPrice
          })
        transactions.push(stakeTx.tx)
      }

      if (isSameAddress(owner, options.from)) {
        console.log('Relayer already authorized')
      } else {
        console.log('Authorizing relayer for hub')
        const authorizeTx = await stakeManager
          .authorizeHubByOwner(relayAddress, relayHubAddress, {
            from: options.from,
            gas: 1e6,
            gasPrice: options.gasPrice
          })
        transactions.push(authorizeTx.tx)
      }

      const bal = await this.contractInteractor.getBalance(relayAddress)
      if (toBN(bal).gt(toBN(options.funds.toString()))) {
        console.log('Relayer already funded')
      } else {
        console.log('Funding relayer')

        const _fundTx = await this.web3.eth.sendTransaction({
          from: options.from,
          to: relayAddress,
          value: options.funds,
          gas: 1e6,
          gasPrice: options.gasPrice
        })
        const fundTx = _fundTx as TransactionReceipt
        if (fundTx.transactionHash == null) {
          return {
            success: false,
            error: `Fund transaction reverted: ${JSON.stringify(_fundTx)}`
          }
        }
        transactions.push(fundTx.transactionHash)
      }

      await this.waitForRelay(options.relayUrl)
      return {
        success: true,
        transactions
      }
    } catch (error) {
      return {
        success: false,
        transactions,
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: error.message
      }
    }
  }

  contract (file: any, address?: string): Contract {
    return new this.web3.eth.Contract(file.abi, address, { data: file.bytecode })
  }

  async deployGsnContracts (deployOptions: DeployOptions): Promise<GSNContractsDeployment> {
    const options: Required<SendOptions> = {
      from: deployOptions.from,
      gas: 0, // gas limit will be filled in at deployment
      value: 0,
      gasPrice: deployOptions.gasPrice ?? (1e9).toString()
    }

    const sInstance = await this.getContractInstance(StakeManager, {}, deployOptions.stakeManagerAddress, Object.assign({}, options), deployOptions.skipConfirmation)
    const pInstance = await this.getContractInstance(Penalizer, {}, deployOptions.penalizerAddress, Object.assign({}, options), deployOptions.skipConfirmation)
    const fInstance = await this.getContractInstance(Forwarder, {}, deployOptions.forwarderAddress, Object.assign({}, options), deployOptions.skipConfirmation)
    const rInstance = await this.getContractInstance(RelayHub, {
      arguments: [
        sInstance.options.address,
        pInstance.options.address,
        deployOptions.relayHubConfiguration.maxWorkerCount,
        deployOptions.relayHubConfiguration.gasReserve,
        deployOptions.relayHubConfiguration.postOverhead,
        deployOptions.relayHubConfiguration.gasOverhead,
        deployOptions.relayHubConfiguration.maximumRecipientDeposit,
        deployOptions.relayHubConfiguration.minimumUnstakeDelay,
        deployOptions.relayHubConfiguration.minimumStake]
    }, deployOptions.relayHubAddress, merge({}, options, { gas: 5e6 }), deployOptions.skipConfirmation)

    const regInstance = await this.getContractInstance(VersionRegistryAbi, {}, deployOptions.registryAddress, Object.assign({}, options), deployOptions.skipConfirmation)
    if (deployOptions.registryHubId != null) {
      await regInstance.methods.addVersion(string32(deployOptions.registryHubId), string32('1'), rInstance.options.address).send({ from: deployOptions.from })
      console.log(`== Saved RelayHub address at HubId:"${deployOptions.registryHubId}" to VersionRegistry`)
    }

    let pmInstance: Contract | undefined
    let paymasterVersion = ''
    if (deployOptions.deployPaymaster === true) {
      pmInstance = await this.deployPaymaster(Object.assign({}, options), rInstance.options.address, deployOptions.from, fInstance, deployOptions.skipConfirmation)
      paymasterVersion = await pmInstance.methods.versionPaymaster()
    }

    await registerForwarderForGsn(fInstance, options)

    this.deployment = {
      paymasterVersion,
      relayHubAddress: rInstance.options.address,
      stakeManagerAddress: sInstance.options.address,
      penalizerAddress: pInstance.options.address,
      forwarderAddress: fInstance.options.address,
      versionRegistryAddress: regInstance.options.address,
      paymasterAddress: pmInstance?.options.address ?? constants.ZERO_ADDRESS
    }

    await this.contractInteractor.initDeployment(this.deployment)
    return this.deployment
  }

  private async getContractInstance (json: any, constructorArgs: any, address: Address | undefined, options: Required<SendOptions>, skipConfirmation: boolean = false): Promise<Contract> {
    const contractName: string = json.contractName
    let contractInstance
    if (address == null) {
      const sendMethod = this
        .contract(json)
        .deploy(constructorArgs)
      options.gas = await sendMethod.estimateGas()
      const maxCost = new BN(options.gasPrice).muln(options.gas)
      const oneEther = ether('1')
      console.log(`Deploying ${contractName} contract with gas limit of ${options.gas.toLocaleString()} and maximum cost of ~ ${maxCost.toNumber() / parseFloat(oneEther.toString())} ETH`)
      if (!skipConfirmation) {
        await this.confirm()
      }
      const deployPromise = sendMethod.send(merge(options, { gas: 5e6 }))
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      deployPromise.on('transactionHash', function (hash) {
        console.log(`Transaction broadcast: ${hash}`)
      })
      contractInstance = await deployPromise
      console.log(`Deployed ${contractName} at address ${contractInstance.options.address}\n\n`)
    } else {
      console.log(`Using ${contractName} at given address ${address}\n\n`)
      contractInstance = this.contract(json, address)
    }
    return contractInstance
  }

  async deployPaymaster (options: Required<SendOptions>, hub: Address, from: string, fInstance: Contract, skipConfirmation: boolean | undefined): Promise<Contract> {
    const pmInstance = await this.getContractInstance(Paymaster, {}, undefined, Object.assign({}, options), skipConfirmation)
    await pmInstance.methods.setRelayHub(hub).send(options)
    await pmInstance.methods.setTrustedForwarder(fInstance.options.address).send(options)
    return pmInstance
  }

  async confirm (): Promise<void> {
    let input
    while (true) {
      console.log('Confirm (yes/no)?')
      input = await io.read()
      if (input === 'yes') {
        return
      } else if (input === 'no') {
        throw new Error('User rejected')
      }
    }
  }
}
