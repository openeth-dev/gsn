const utils = require('./utils')
const promisify = utils.promisify
const IRelayHub = require('../relayclient/IRelayHub')
const IRelayRecipient = require('../relayclient/IRelayRecipient')

const RelayHub = web3.eth.contract(IRelayHub)
const RelayRecipient = web3.eth.contract(IRelayRecipient)

class ContractManager {
  constructor () {
    utils.checkNetwork(web3)
  }

  log () {
    utils.log(Array.prototype.slice.call(arguments).join(' '))
  }

  saveForm (form) {
    utils.saveForm(form, 'contractmanager')
  }

  loadForm (form) {
    utils.loadForm(form, 'contractmanager')
  }

  async getRelayHub (addr) {
    const recipient = RelayRecipient.at(addr)

    const hubaddr = await promisify(recipient.getHubAddr)()

    if (!hubaddr || hubaddr === '0x') { return undefined }

    return RelayHub.at(hubaddr)
  }

  async checkBalance (addr) {
    console.log('addr=', addr)

    const hub = await this.getRelayHub(addr)

    if (!hub) {
      this.log('ERROR: no hub (address not a RelayRecipient?)')
      return
    }

    const r = await promisify(hub.balanceOf)(addr)
    this.log('Balance of contract on Relay Hub: ' + addr + ' = ' + (r / 1e18) + ' eth')
    this.log('hub addr=', hub.address)
    return r
  }

  async depositFor (addr, ethAmount) {
    const hub = await this.getRelayHub(addr)
    console.log('hub=', hub)
    hub.depositFor(addr, { from: web3.eth.accounts[0], value: ethAmount * 1e18 }, (e) => {
      if (e) {
        this.log('failed deposit: ' + e)
        return false
      } else {
        this.log('deposited ' + ethAmount + ' to ' + addr + '. wait for confirmation..')
        return true
      }
    })
  }
}

module.exports = ContractManager
