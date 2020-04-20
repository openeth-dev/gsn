var RelayHub = artifacts.require('./RelayHub.sol')
var StakeManager = artifacts.require('./StakeManager.sol')
var Penalizer = artifacts.require('./Penalizer.sol')

module.exports = async function (deployer) {
  await deployer.deploy(StakeManager)
  await deployer.deploy(Penalizer)
  await deployer.deploy(RelayHub, 16, StakeManager.address, Penalizer.address)
}
