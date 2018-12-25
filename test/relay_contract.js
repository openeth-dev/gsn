/* globals web3 artifacts contract it before assert */

const SampleRecipient = artifacts.require("./SampleRecipient.sol");

const testutils = require('./testutils')
const utils = require('../src/js/relayclient/utils')

const register_new_relay = testutils.register_new_relay;
const increaseTime = testutils.increaseTime;
const waitAllContractEventGet = utils.waitAllContractEventGet;
const getTransactionSignature = utils.getTransactionSignature;
const getTransactionHash = utils.getTransactionHash;
const rlp = require('rlp');

const ethJsTx = require('ethereumjs-tx');
const BigNumber = require('bignumber.js');

const message = "hello world";

contract('SampleRecipient', function (accounts) {
    // TODO: account with no ether
    var expected_real_sender = accounts[0];

    it("should emit message with msg_sender and real_sender", async function () {
        let sample = await SampleRecipient.deployed()
        let result = await sample.emitMessage(message);
        var log = result.logs[0];
        var args = log.args;
        assert.equal("SampleRecipientEmitted", log.event);
        assert.equal(args.message, message);
        assert.equal(accounts[0], args.msg_sender);
        assert.equal(expected_real_sender, args.real_sender);
    });
});

const RelayHub = artifacts.require("./RelayHub.sol");
contract("RelayHub", function (accounts) {

    let rhub;
    let sr;

    let transaction;
    let sig;
    let digest;

    before(async function () {
        rhub = await RelayHub.deployed();
        sr = await SampleRecipient.deployed()
        transaction = await getTransaction(sr);
        digest = await getTransactionHash(from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, rhub.address, accounts[0]);
        sig = await getTransactionSignature(accounts[0], digest)
        let deposit = 100000000000;
        await sr.deposit({value: deposit});
    });

    var real_sender = accounts[0];
    var one_ether = web3.toWei('1', 'ether');

    it("test_stake", async function () {
        let account = accounts[1];
        let zero_stake = await rhub.stakes(account)
        let z = zero_stake.valueOf()[0].toNumber();
        // assert.equal(0, z);

        let expected_stake = web3.toWei('1', 'ether');
        await rhub.stake(account, 7, {value: expected_stake, from:account})
        let stake = await rhub.stakes(account, {from:account})
        assert.equal(expected_stake, stake[0].toNumber()-z);
        assert.equal(7, stake[1]);
    });

    it("should allow owner to stake on behalf of the relay", async function () {
        let gasless_relay_address = "0x2Dd8C0665327A26D7655055B22c9b3bA596DfeD9"
        let balance_of_gasless_before = web3.eth.getBalance(gasless_relay_address);
        let balance_of_acc7_before = web3.eth.getBalance(accounts[7]);
        let expected_stake = web3.toWei('0.5', 'ether')
        let gasPrice = 1
        let res = await rhub.stake(gasless_relay_address, 7, {value: expected_stake, gasPrice: gasPrice, from: accounts[7]})
        let stake = await rhub.stakes(gasless_relay_address)
        let balance_of_gasless_after = web3.eth.getBalance(gasless_relay_address);
        let balance_of_acc7_after = web3.eth.getBalance(accounts[7]);
        let expected_balance_after = balance_of_acc7_before.minus(expected_stake).minus(res.receipt.gasUsed * gasPrice)
        assert.equal(balance_of_acc7_after.toString(), expected_balance_after.toString());
        assert.equal(balance_of_gasless_after.toString(), balance_of_gasless_before.toString());
        assert.equal(expected_stake, stake[0].toNumber());
    })

    it("test_register_relay", async function () {
        let res = await register_new_relay(rhub, one_ether, dayInSec, 120, "hello", accounts[0]);
        let log = res.logs[0]
        assert.equal("RelayAdded", log.event)
        // assert.equal(two_ether, log.args.stake) changes, depending on position in test list
    });

    async function getTransaction(testContract) {
        return testContract.contract.emitMessage.getData(message);
    }

    /**
     * If ganache is run without '-b' parameter, reverted transaction return
     * error message instantly. Otherwise, revert will only occur once 'evm_mine'
     * is executed, and the error will be generated by truffle.
     *
     * @param {*} error - returned by web3 from RPC call
     * @param {*} errorMessage - expected error message
     */
    function isErrorMessageCorrect(error, errorMessage) {
        let blocktime_mode_error = "does not trigger a Solidity `revert` statement"
        return error.message.includes(errorMessage) || error.message.includes(blocktime_mode_error)
    }

    let from = real_sender;
    let to = SampleRecipient.address;
    let transaction_fee = 10;
    let gas_price = 10;
    let gas_limit = 1000000;
    // Note: this is not a transaction nonce, this is a RelayHub nonce
    // Note!! Increment each time relay is performed and not reverted!
    let relay_nonce = 0;

    /**
     * Depends on 'test_register_relay'
     */
    it("test_can_relay", async function () {
        let relay = accounts[0];
        let can_relay = await rhub.can_relay.call(relay, from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, sig);
        assert.equal(0, can_relay.valueOf());
    });

    // TODO: gas_price change flow. As discussed, in case the Relay decides to ACCELERATE mining of tx he ALREADY signed,
    // Relay is allowed to retry the SAME tx with a higher gas_price without being Penalized.
    // Need to create test for such flow.
    it("test_perform_relay_send_message", async function () {
        let result = await rhub.relay(from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, sig, {
            gasPrice: gas_price,
            gasLimit: 100000000
        });
        relay_nonce++;
        var log_relayed = result.logs[0];
        var args_relayed = log_relayed.args;
        assert.equal("TransactionRelayed", log_relayed.event);
        assert.equal(true, args_relayed.ret)
        var logs_messages = await waitAllContractEventGet(sr.contract.SampleRecipientEmitted({}, {
            fromBlock: 0,
            toBlock: 'latest'
        }));
        assert.equal(1, logs_messages.length)
        let log_message = logs_messages[0];
        var args_message = log_message.args;
        assert.equal("SampleRecipientEmitted", log_message.event);
        assert.equal(message, args_message.message);
    });
    it("should not accept relay requests from unknown addresses", async function () {
        digest = await getTransactionHash(from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, rhub.address, accounts[0]);
        sig = await getTransactionSignature(accounts[0], digest)
        try {
            await rhub.relay(from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, sig, {
                from: accounts[6],
                gasPrice: gas_price,
                gasLimit: 100000000
            });
            assert.fail();
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "Unknown relay"))
        }
    });

    it("should not accept relay requests with gas price lower then user specified", async function () {
        try {
            await rhub.relay(from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, sig, {
                gasPrice: gas_price - 1,
                gasLimit: 100000000
            });
            assert.fail();
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "Invalid gas price"))
        }
    });

    it("should not accept relay requests if destination recepient doesn't approve it", async function () {
        let from = accounts[6];
        let relay_nonce = 0;
        let digest = await getTransactionHash(from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, rhub.address, accounts[0]);
        let sig = await getTransactionSignature(from, digest)
        try {
            await rhub.relay(from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, sig, {
                gasPrice: gas_price,
                gasLimit: 100000000
            });
            assert.fail("relay should fail");
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "can_relay failed"), "wrong error: "+error)
            let can_relay = await rhub.can_relay.call(accounts[0], from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, sig);
            assert.equal(3, can_relay.valueOf())
        }
    });

    it("should not accept relay requests if gas limit is too low for a relayed transaction", async function () {
        // Adding gas_reserve is not enough by a few wei as some gas is spent before gasleft().
        let gas_reserve = 99999;
        try {
            await rhub.relay(from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, sig, {
                gasPrice: gas_price,
                gas: gas_limit + gas_reserve
            });
            assert.fail();
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "Not enough gasleft"));
        }
    });

    it("should not accept relay requests if destination recepient doesn't have a balance to pay for it", async function () {
        await sr.withdraw();
        try {
            await rhub.relay(from, to, transaction, transaction_fee, gas_price, gas_limit, relay_nonce, sig, {
                gasPrice: gas_price,
                gasLimit: 100000000
            });
            assert.fail();
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "insufficient funds"))
        }
    });

    it("test_remove_relay_by_owner", async function () {
        try {
            await rhub.remove_relay_by_owner(0)
            assert.fail()
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "not owner"))
        }

        let res = await rhub.remove_relay_by_owner(accounts[0]);
        assert.equal("RelayRemoved", res.logs[0].event);
        assert.equal(accounts[0], res.logs[0].args.relay);
    });

    it("test_unstake", async function () {
        let stake = await rhub.stakes.call(accounts[0]);
        let can_unstake = await rhub.can_unstake.call(accounts[0]);
        assert.equal(false, can_unstake)
        await increaseTime(stake[1] / 2)
        can_unstake = await rhub.can_unstake.call(accounts[0]);
        assert.equal(false, can_unstake)
        await increaseTime(stake[1] / 2)
        can_unstake = await rhub.can_unstake.call(accounts[0]);
        assert.equal(true, can_unstake)
        let res = await rhub.unstake(accounts[0]);
        console.log()
    });

    let dayInSec = 24 * 60 * 60;

    it("test_remove_stale_relay", async function () {
        await register_new_relay(rhub, one_ether, dayInSec, 120, "hello", accounts[0]);
        try {
            await rhub.remove_stale_relay(0);
            assert.fail()
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "not a relay"))
        }

        try {
            await rhub.remove_stale_relay(accounts[0]);
            assert.fail()
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "not stale"))
        }

        await increaseTime(4 * dayInSec);
        try {
            await rhub.remove_stale_relay(accounts[0]);
            assert.fail()
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "not stale"))
        }

        await increaseTime(1 * dayInSec + 1);
        let res = await rhub.remove_stale_relay(accounts[0])
        assert.equal("RelayRemoved", res.logs[0].event)
        await increaseTime(dayInSec + 1);
        await rhub.unstake(accounts[0]);
        let stake = await rhub.stakes(accounts[0]);
        assert.equal(0, stake[0]);
    });

    let nonce_any_value = 4;
    let gas_price_any_value = 4;
    let gas_limit_any_value = 100000000;
    let tx_value_any_value = 0;
    let gasPricePenalize = 5;

    let snitching_account;
    let privKey = Buffer.from("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d", "hex");
    let data1;
    let data2;
    let transaction1;
    let transaction2;

    let unsignedTransaction1Encoded;
    let unsignedTransaction2Encoded;

    let sig1;
    let sig2;

    function encodeRLP(transaction) {
        return "0x" + rlp.encode(transaction.raw.slice(0, 6)).toString("hex")
    }

    function signatureHex(transaction) {
        return "0x" + Buffer.concat([transaction.v, transaction.r, transaction.s]).toString('hex');
    }

    it("should penalize relay for signing two distinct transactions with the same nonce", async function () {
        await register_new_relay(rhub, one_ether, dayInSec, 120, "hello", accounts[0]);
        let stake = await rhub.stakes(accounts[0]);
        assert.equal(one_ether, stake[0].toNumber());

        data1 = rhub.contract.relay.getData(1, 1, 1, 1, 1, 1, 1, 1);
        data2 = rhub.contract.relay.getData(2, 2, 2, 2, 2, 2, 2, 2);

        transaction1 = new ethJsTx({
            nonce: nonce_any_value,
            gasPrice: gas_price_any_value,
            gasLimit: gas_limit_any_value,
            to: sr.address,
            value: tx_value_any_value,
            data: data1
        })
        transaction2 = new ethJsTx({
            nonce: nonce_any_value,
            gasPrice: gas_price_any_value,
            gasLimit: gas_limit_any_value,
            to: sr.address,
            value: tx_value_any_value,
            data: data2
        })
        unsignedTransaction1Encoded = encodeRLP(transaction1)
        unsignedTransaction2Encoded = encodeRLP(transaction2)
        transaction1.sign(privKey);
        transaction2.sign(privKey);
        sig1 = signatureHex(transaction1);
        sig2 = signatureHex(transaction2);

        snitching_account = accounts[7];
        let snitching_account_initial_balance = web3.eth.getBalance(snitching_account);

        let res = await rhub.penalize_repeated_nonce(unsignedTransaction1Encoded, sig1, unsignedTransaction2Encoded, sig2, {
            from: snitching_account,
            gasPrice: gasPricePenalize,
            gasLimit: 100000000
        });
        assert.equal("Penalized", res.logs[0].event)
        assert.equal(accounts[0], res.logs[0].args.relay)
        assert.equal(snitching_account, res.logs[0].args.sender)
        increaseTime(dayInSec)
        let res2 = await rhub.unstake(accounts[0],{from:snitching_account, gasPrice: gasPricePenalize,gasLimit: 100000000})

        let balance_of_acc7 = web3.eth.getBalance(snitching_account);
        let expected_balance_after_penalize = snitching_account_initial_balance.plus(stake[0]).minus(res.receipt.gasUsed * gasPricePenalize).minus(res2.receipt.gasUsed * gasPricePenalize)
        assert.equal(expected_balance_after_penalize.toString(), balance_of_acc7.toString());
    });


    it("should revert an attempt to penalize relay with two identical transactions", async function () {
        await register_new_relay(rhub, one_ether, dayInSec, 120, "hello", accounts[0]);
        let stake = await rhub.stakes(accounts[0]);
        assert.equal(one_ether, stake[0].toNumber());

        try {
            await rhub.penalize_repeated_nonce(unsignedTransaction1Encoded, sig1, unsignedTransaction1Encoded, sig1, {
                from: snitching_account,
                gasPrice: gasPricePenalize,
                gasLimit: 100000000
            });
            assert.fail()
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "tx.data is equal"))
        }
    });

    it("should revert an attempt to penalize relay with two transactions with different nonce", async function () {
        let transaction2_nextNonce = new ethJsTx(transaction2);
        transaction2_nextNonce.nonce = nonce_any_value + 1;

        let unsignedTransaction2Encoded_nextNonce = encodeRLP(transaction2_nextNonce)
        transaction2_nextNonce.sign(privKey);
        let sig2_nextNonce = signatureHex(transaction2_nextNonce);
        try {
            await rhub.penalize_repeated_nonce(unsignedTransaction1Encoded, sig1, unsignedTransaction2Encoded_nextNonce, sig2_nextNonce, {
                from: snitching_account,
                gasPrice: gasPricePenalize,
                gasLimit: 100000000
            });
            assert.fail()
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "Different nonce"))
        }
    });

    it("should revert an attempt to penalize relay with two transactions from different relays", async function () {
        await register_new_relay(rhub, one_ether, dayInSec, 120, "hello", accounts[6]);
        let privKeySix = Buffer.from("e485d098507f54e7733a205420dfddbe58db035fa577fc294ebd14db90767a52", "hex");
        transaction2.sign(privKeySix);
        let sig2_fromAccountSix = signatureHex(transaction2);
        try {
            await rhub.penalize_repeated_nonce(unsignedTransaction1Encoded, sig1, unsignedTransaction2Encoded, sig2_fromAccountSix, {
                from: snitching_account,
                gasPrice: gasPricePenalize,
                gasLimit: 100000000
            });
            assert.fail()
        } catch (error) {
            assert.equal(true, isErrorMessageCorrect(error, "Different signer"))
        }
    });

    [0, 1, 3, 5, 10, 50, 100, 200].forEach(requested_fee => {
        it("should compensate relay with requested fee of " + requested_fee + "%", async function () {
            let relay_recepient_balance_before = await rhub.balances(sr.address)
            if (relay_recepient_balance_before.equals(0)){
                let deposit = 100000000;
                await sr.deposit({ value: deposit });
            }
            // This is required to initialize rhub's balances[acc[0]] value
            // If it is not set, the transacion will cost 15'000 gas more then expected by 'gas_overhead'
            await rhub.deposit({ value: 1 })
            relay_recepient_balance_before = await rhub.balances(sr.address)
            let relay_balance_before = web3.eth.getBalance(accounts[0]);
            let r = await rhub.relays(accounts[0])
            let owner = r[0]

            let relay_owner_hub_balance_before = await rhub.balances(owner)


            let digest = await getTransactionHash(from, to, transaction, requested_fee, gas_price, gas_limit, relay_nonce, rhub.address, accounts[0]);
            let sig = await getTransactionSignature(accounts[0], digest)
            let res = await rhub.relay(from, to, transaction, requested_fee, gas_price, gas_limit, relay_nonce, sig, {
                from: accounts[0],
                gasPrice: gas_price,
                gasLimit: 100000000
            });
            relay_nonce++;


            let relay_owner_hub_balance_after = await rhub.balances(owner)
            let relay_balance_after = web3.eth.getBalance(accounts[0])

            // What is the factor relay is expecting to get paid by. I.e. for 10% it is '1.1'; For 200% it is '3.0'
            let requested_coeff = new BigNumber(requested_fee).dividedBy(100).plus(1).toPrecision(3, BigNumber.ROUND_HALF_UP)

            // Calculate the actual factor. Rounding is expected. 
            let revenue = relay_owner_hub_balance_after.minus(relay_owner_hub_balance_before)
            let expenses = relay_balance_before.minus(relay_balance_after)
            let received_coeff = revenue.dividedBy(expenses)
            // I don't know how does rounding work for BigNumber, but it seems to be broken to me
            if (received_coeff.lessThan(1))
            {
                received_coeff = received_coeff.toPrecision(2, BigNumber.ROUND_HALF_UP)
            }
            else {
                received_coeff = received_coeff.toPrecision(3, BigNumber.ROUND_HALF_UP)
            }
            assert.equal(requested_coeff, received_coeff)

            // Check that relay did pay it's gas fee on itslef.
            let expected_balance_after = relay_balance_before.minus(res.receipt.gasUsed * gas_price)
            assert.equal(expected_balance_after.toString(), relay_balance_after.toString())

            // Check that relay's revenue is deducted from recepient's stake.
            let relay_recepient_balance_after = await rhub.balances(sr.address)
            let expected_recepient_balance = relay_recepient_balance_before.minus(revenue)
            assert.equal(expected_recepient_balance.toString(), relay_recepient_balance_after.toString())
        });
    })
});
