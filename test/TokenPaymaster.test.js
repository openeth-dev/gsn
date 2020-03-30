/* global contract artifacts before it */

const Environments = require('../src/js/relayclient/Environments')

const TokenPaymaster = artifacts.require('TokenPaymaster.sol')
const TokenGasCalculator = artifacts.require('TokenGasCalculator.sol')
const TestUniswap = artifacts.require('TestUniswap.sol')
const TestToken = artifacts.require('TestToken.sol')
const RelayHub = artifacts.require('RelayHub.sol')
const TrustedForwarder = artifacts.require('./TrustedForwarder.sol')
const TestProxy = artifacts.require('TestProxy')
const { getEip712Signature } = require('../src/js/relayclient/utils')

const RelayRequest = require('../src/js/relayclient/EIP712/RelayRequest')

async function revertReason (func) {
  try {
    await func
    return 'ok' // no revert
  } catch (e) {
    return e.message.replace(/.*revert /, '')
  }
}

contract('TokenPaymaster', ([from, relay, relayOwner]) => {
  let paymaster, uniswap, token, recipient, hub, forwarder
  let sharedRelayRequestData

  async function calculatePostGas (paymaster) {
    const testpaymaster = await TokenPaymaster.new(await paymaster.uniswap())
    const calc = await TokenGasCalculator.new({ gas: 10000000 })
    await testpaymaster.transferOwnership(calc.address)
    // put some tokens in paymaster so it can calculate postRelayedCall gas usage:
    await token.mint(1000)
    await token.transfer(calc.address, 1000)
    const ret = await calc.calculatePostGas.call(testpaymaster.address)
    await paymaster.setPostGasUsage(ret[0], ret[1])
  }

  before(async () => {
    // exchange rate 2 tokens per eth.
    uniswap = await TestUniswap.new(2, 1, { value: 5e18 })
    hub = await RelayHub.new(16)
    token = await TestToken.at(await uniswap.tokenAddress())

    paymaster = await TokenPaymaster.new(uniswap.address)
    await calculatePostGas(paymaster)
    await paymaster.setRelayHub(hub.address)

    forwarder = await TrustedForwarder.new()
    recipient = await TestProxy.new(forwarder.address)

    // approve uniswap to take our tokens.
    await token.approve(uniswap.address, -1)

    sharedRelayRequestData = {
      senderAddress: from,
      encodedFunction: recipient.contract.methods.test().encodeABI(),
      senderNonce: '1',
      target: recipient.address,
      pctRelayFee: '1',
      baseRelayFee: '0',
      gasPrice: await web3.eth.getGasPrice(),
      gasLimit: 1e6.toString(),
      relayAddress: from,
      paymaster: paymaster.address
    }
  })

  context('#acceptRelayedCall', async () => {
    it('should fail if not enough balance', async () => {
      const relayRequest = new RelayRequest({
        ...sharedRelayRequestData
      })
      assert.equal(await revertReason(paymaster.acceptRelayedCall(relayRequest, '0x', 1e6)), 'balance too low')
    })

    it('should fund recipient', async () => {
      await token.mint(5e18.toString())
      await token.transfer(recipient.address, 5e18.toString())
    })

    it('should fail if no approval', async () => {
      const relayRequest = new RelayRequest({
        ...sharedRelayRequestData
      })
      assert.include(await revertReason(paymaster.acceptRelayedCall(relayRequest, '0x', 1e6)), 'allowance too low')
    })

    it('should recipient.approve', async () => {
      await recipient.execute(token.address, token.contract.methods.approve(paymaster.address, -1).encodeABI())
    })

    it('should succeed acceptRelayedCall', async () => {
      const relayRequest = new RelayRequest({
        ...sharedRelayRequestData
      })
      await paymaster.acceptRelayedCall(relayRequest, '0x', 1e6)
    })
  })

  context('#relayedCall', () => {
    const paymasterDeposit = 1e18.toString()

    before(async () => {
      await hub.stake(relay, 7 * 24 * 3600, {
        from: relayOwner,
        value: 2e18
      })
      await hub.registerRelay(2e16.toString(), '10', 'url', { from: relay })
      await hub.depositFor(paymaster.address, { value: paymasterDeposit })
    })

    it('pay with token to make a call', async () => {
      const preTokens = await token.balanceOf(recipient.address)
      const prePaymasterTokens = await token.balanceOf(paymaster.address)
      // for simpler calculations: we don't take any fee, and gas price is '1', so actual charge
      // should be exactly gas usage. token is 2:1 to eth, so we expect to pay exactly twice the "charge"
      const relayRequest = new RelayRequest({
        ...sharedRelayRequestData,
        senderAddress: from,
        senderNonce: (await hub.getNonce(recipient.address, from)).toString(),
        gasPrice: '1',
        pctRelayFee: '0',
        baseRelayFee: '0'
      })

      const chainId = Environments.defEnv.chainId
      const { signature } = await getEip712Signature({
        web3,
        chainId,
        verifier: forwarder.address,
        relayRequest
      })
      const maxGas = 1e6
      const arcGasLimit = 1e6

      // not really required: verify there's no revert
      const canRelayRet = await hub.canRelay(relayRequest, maxGas, arcGasLimit, signature, '0x', {
        from: relay,
        gasPrice: 1
      })
      assert.equal(canRelayRet[0], true)

      const preBalance = await hub.balanceOf(paymaster.address)

      const ret = await hub.relayCall(relayRequest, signature, '0x', {
        from: relay,
        gasPrice: 1,
        gas: 1.516181e6
      })

      // console.log(getLogs(ret))
      const relayed = ret.logs.find(log => log.event === 'TransactionRelayed')
      const events = await paymaster.getPastEvents()
      // console.log(getLogs(events))
      const chargedEvent = events.find(e => e.event === 'TokensCharged')

      assert.equal(relayed.args.status, 0)
      const postTokens = await token.balanceOf(recipient.address)
      const usedTokens = preTokens - postTokens

      console.log('recipient tokens balance change (used tokens): ', usedTokens.toString())
      console.log('reported charged tokens: ', chargedEvent.args.tokenActualCharge.toString())
      const expectedTokenCharge = await uniswap.getTokenToEthOutputPrice(chargedEvent.args.ethActualCharge)
      assert.closeTo(usedTokens, expectedTokenCharge.toNumber(), 1000)
      const postBalance = await hub.balanceOf(paymaster.address)

      assert.ok(postBalance >= preBalance,
        `expected paymaster balance not to be reduced: pre=${preBalance} post=${postBalance}`)
      // TODO: add test for relayed.args.charge, once gasUsedWithoutPost parameter is fixed (currently, its too high, and Paymaster "charges" too much)
      const postPaymasterTokens = await token.balanceOf(paymaster.address)
      console.log('Paymaster "earned" tokens:', postPaymasterTokens - prePaymasterTokens)
      console.log('Paymaster "earned" deposit on RelayHub:', postBalance - preBalance)
    })
  })
})
