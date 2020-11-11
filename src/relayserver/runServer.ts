// TODO: convert to 'commander' format
import fs from 'fs'
import Web3 from 'web3'
import { HttpServer } from './HttpServer'
import { RelayServer } from './RelayServer'
import { KeyManager } from './KeyManager'
import { TxStoreManager, TXSTORE_FILENAME } from './TxStoreManager'
import ContractInteractor from '../relayclient/ContractInteractor'
import { configureGSN } from '../relayclient/GSNConfigurator'
import { parseServerConfig, resolveServerConfig, ServerConfigParams, ServerDependencies } from './ServerConfigParams'
import { createServerLogger } from './ServerWinstonLogger'
import { GasPriceFetcher } from '../relayclient/GasPriceFetcher'

function error (err: string): never {
  console.error(err)
  process.exit(1)
}

async function run (): Promise<void> {
  let config: ServerConfigParams
  let web3provider
  console.log('Starting GSN Relay Server process...\n')
  try {
    const conf = await parseServerConfig(process.argv.slice(2), process.env)
    if (conf.ethereumNodeUrl == null) {
      error('missing ethereumNodeUrl')
    }
    web3provider = new Web3.providers.HttpProvider(conf.ethereumNodeUrl)
    config = await resolveServerConfig(conf, web3provider) as ServerConfigParams
  } catch (e) {
    error(e.message)
  }
  const { devMode, workdir } = config
  if (devMode) {
    if (fs.existsSync(`${workdir}/${TXSTORE_FILENAME}`)) {
      fs.unlinkSync(`${workdir}/${TXSTORE_FILENAME}`)
    }
  }

  const logger = createServerLogger(config.logLevel, config.loggerUrl, config.loggerUserId)
  const managerKeyManager = new KeyManager(1, workdir + '/manager')
  const workersKeyManager = new KeyManager(1, workdir + '/workers')
  const txStoreManager = new TxStoreManager({ workdir }, logger)
  const contractInteractor = new ContractInteractor(web3provider, logger, configureGSN({ relayHubAddress: config.relayHubAddress }))
  await contractInteractor.init()
  const gasPriceFetcher = new GasPriceFetcher(config.gasPriceOracleUrl, config.gasPriceOraclePath, contractInteractor, logger)

  const dependencies: ServerDependencies = {
    logger,
    txStoreManager,
    managerKeyManager,
    workersKeyManager,
    contractInteractor,
    gasPriceFetcher
  }

  const relay = new RelayServer(config, dependencies)
  await relay.init()
  const httpServer = new HttpServer(config.port, relay, logger)
  httpServer.start()
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
run()
