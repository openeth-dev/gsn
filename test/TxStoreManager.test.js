/* global artifacts BigInt describe */

const fs = require('fs')
const TxStoreManager = require('../src/js/relayserver/TxStoreManager').TxStoreManager
const TXSTORE_FILENAME = require('../src/js/relayserver/TxStoreManager').TXSTORE_FILENAME
const StoredTx = require('../src/js/relayserver/TxStoreManager').StoredTx

// NOTICE: this dir is removed in 'after', do not use this in any other test
const workdir = '/tmp/gsn/test/txstore_manager'

contract('TxStoreManager', function (accounts) {

  let txmanager, tx, tx2, tx3

  before('create txstore', async function () {
    assert.isFalse(fs.existsSync(workdir), 'test txstore dir should not exist yet')
    txmanager = new TxStoreManager({ workdir })
    await txmanager.clearAll()
    assert.ok(txmanager, 'txstore uninitialized' + txmanager)
    assert.isTrue(fs.existsSync(workdir), 'test txstore dir should exist already')
    tx = new StoredTx(
      {
        from: '0x',
        to: '0x',
        value: 0,
        gas: 0,
        gasPrice: 0,
        data: 0,
        nonce: 111,
        txId: '123456',
        attempts: 1
      })
    tx2 = new StoredTx(
      {
        from: '0x',
        to: '0x',
        value: 0,
        gas: 0,
        gasPrice: 0,
        data: 0,
        nonce: 112,
        txId: '1234567',
        attempts: 1
      })
    tx3 = new StoredTx(
      {
        from: '0x',
        to: '0x',
        value: 0,
        gas: 0,
        gasPrice: 0,
        data: 0,
        nonce: 113,
        txId: '12345678',
        attempts: 1
      })
  })

  it('should store and get tx by txId', async function () {
    assert.equal(null, await txmanager.getTxById({ txId: tx.txId }))
    await txmanager.putTx({ tx })
    const txById = await txmanager.getTxById({ txId: tx.txId })
    assert.equal(tx.txId, txById.txId)
    assert.equal(tx.attempts, txById.attempts)
  })

  it('should get tx by nonce', async function () {
    assert.equal(null, await txmanager.getTxByNonce({ nonce: tx.nonce + 1234 }))
    const txByNonce = await txmanager.getTxByNonce({ nonce: tx.nonce })
    assert.equal(tx.txId, txByNonce.txId)
  })

  it('should remove tx by nonce', async function () {
    let txByNonce = await txmanager.getTxByNonce({ nonce: tx.nonce })
    assert.equal(tx.txId, txByNonce.txId)
    assert.deepEqual(1, (await txmanager.getAll()).length)
    await txmanager.removeTxByNonce({ nonce: tx.nonce })
    txByNonce = await txmanager.getTxByNonce({ nonce: tx.nonce })
    assert.equal(null, txByNonce)
    assert.deepEqual([], await txmanager.getAll())
  })

  it('should remove txs until nonce', async function () {
    await txmanager.putTx({ tx })
    await txmanager.putTx({ tx: tx2 })
    await txmanager.putTx({ tx: tx3 })
    let txByNonce = await txmanager.getTxByNonce({ nonce: tx.nonce })
    assert.equal(tx.txId, txByNonce.txId)
    let tx2ByNonce = await txmanager.getTxByNonce({ nonce: tx2.nonce })
    assert.equal(tx2.txId, tx2ByNonce.txId)
    let tx3ByNonce = await txmanager.getTxByNonce({ nonce: tx3.nonce })
    assert.equal(tx3.txId, tx3ByNonce.txId)
    assert.deepEqual(3, (await txmanager.getAll()).length)
    await txmanager.removeTxsUntilNonce({ nonce: tx2.nonce })
    txByNonce = await txmanager.getTxByNonce({ nonce: tx.nonce })
    assert.equal(null, txByNonce)
    tx2ByNonce = await txmanager.getTxByNonce({ nonce: tx2.nonce })
    assert.equal(null, tx2ByNonce)
    tx3ByNonce = await txmanager.getTxByNonce({ nonce: tx3.nonce })
    assert.equal(tx3.txId, tx3ByNonce.txId)
    assert.deepEqual(1, (await txmanager.getAll()).length)
  })

  it('should clear txstore', async function () {
    await txmanager.putTx({ tx })
    await txmanager.putTx({ tx: tx2 })
    await txmanager.putTx({ tx: tx3 })
    await txmanager.clearAll()
    assert.deepEqual([], await txmanager.getAll())
  })

  it('should NOT store tx twice', async function () {
    await txmanager.putTx({ tx })
    await txmanager.putTx({ tx })
    assert.deepEqual(1, (await txmanager.getAll()).length)
  })

  after('remove txstore', async function () {
    fs.unlinkSync(`${workdir}/${TXSTORE_FILENAME}`)
    fs.rmdirSync(workdir)
  })

})
