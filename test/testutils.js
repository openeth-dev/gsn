 /* global web3 artifacts assert */

const child_process = require('child_process')
const HttpWrapper = require( "../src/js/relayclient/HttpWrapper")
const localhostOne = "http://localhost:8090"
const RelayHub = artifacts.require("RelayHub");
const ethUtils = require('ethereumjs-util');
const ethJsTx = require('ethereumjs-tx');
const addPastEvents = require( '../src/js/relayclient/addPastEvents' )
addPastEvents(RelayHub)

module.exports = {

    //start a background relay process.
    // rhub - relay hub contract
    //options:
    //  verbose: enable background process logging.
    //  stake, delay, txfee, url, relayOwner: parameters to pass to register_new_relay, to stake and register it.
    //  
    startRelay: async function (rhub, options) {
        let server = __dirname + "/../build/server/bin/RelayHttpServer"

        options = options || {}
        let args = []
        args.push( "-Workdir", "./build/server" )
        args.push( "-ShortSleep" )
        if ( rhub ) {
            args.push("-RelayHubAddress", rhub.address)
        }
        if (options.EthereumNodeUrl) {
            args.push("-EthereumNodeUrl", options.EthereumNodeUrl)
        }
        if (options.GasPricePercent) {
            args.push("-GasPricePercent", options.GasPricePercent)
        }
        let proc = child_process.spawn(server, args)

        let relaylog=function(){}
        if ( process.env.relaylog )
            relaylog = (msg)=> msg.split("\n").forEach(line=>console.log("relay-"+proc.pid+"> "+line))

        relaylog( "server started")

        await new Promise((resolve, reject) => {

            let lastresponse
            let listener = data => {
                let str = data.toString().replace(/\s+$/, "")
                lastresponse = str
                relaylog(str)
                if (str.indexOf("Listening on port") >= 0) {
                    proc.alreadystarted = 1
                    resolve(proc)
                }
            };
            proc.stdout.on('data', listener)
            proc.stderr.on('data', listener)
            let doaListener = (code) => {
                if (!this.alreadystarted) {
                    relaylog("died before init code="+code)
                    reject(lastresponse)
                }
            };
            proc.on('exit', doaListener.bind(proc))
        })

        let http = new HttpWrapper(web3)
        let res = await http.sendPromise(localhostOne+'/getaddr')
        let relayServerAddress = res.RelayServerAddress
        console.log("Relay Server Address",relayServerAddress)
        await web3.eth.sendTransaction({to:relayServerAddress, from:web3.eth.accounts[0], value:web3.toWei("2", "ether")})
        await rhub.stake(relayServerAddress, options.delay || 3600, {from: options.relayOwner, value: options.stake})

        res=""
        let count = 25
        while (count-- > 0) {
            res = await http.sendPromise(localhostOne+'/getaddr')
            if ( res.Ready ) break;
            await module.exports.sleep(1500)
        }
        assert.ok(res.Ready, "Timed out waiting for relay to get staked and registered")

        return proc

    },
    sleep: function (ms) {
     return new Promise(resolve => setTimeout(resolve, ms));
    },

    stopRelay: function (proc) {
        proc && proc.kill()
    },


    register_new_relay: async function (relayHub, stake, delay, txFee, url, account) {
        await relayHub.stake(account, delay, {from: account, value: stake})
        return await relayHub.register_relay(txFee, url, 0, {from: account})
    },

    register_new_relay_with_privkey: async function (relayHub, stake, delay, txFee, url, account, web3, privKey) {
        let address = "0x" + ethUtils.privateToAddress(privKey).toString('hex')
        await relayHub.stake(address, delay, {from: account, value: stake})
        await web3.eth.sendTransaction({to: address, from: account, value: web3.toWei("1", "ether")})
        let nonce = web3.eth.getTransactionCount(address)
        // let stake_data = relayHub.contract.stake.getData(account, delay)
        // , {from: account, value: stake})
        let register_data = relayHub.contract.register_relay.getData(txFee, url, 0)
        //  {from: account})
        let validTransaction = new ethJsTx({
            nonce: nonce,
            gasPrice: 1,
            gasLimit: 1000000,
            to: relayHub.address,
            value: 0,
            data: register_data,
        });
        validTransaction.sign(privKey)
        var raw_tx = '0x' + validTransaction.serialize().toString('hex');

        let promise = new Promise((resolve,reject) => {
            web3.eth.sendRawTransaction(raw_tx, (err, res) => {
                if (err) {
                    reject(err)
                }
                else {
                    resolve(res)
                }
            })
        })
        let res = await promise
        console.log(res)
    },

    increaseTime: function (time) {
        web3.currentProvider.sendAsync({
            jsonrpc: '2.0',
            method: 'evm_increaseTime',
            params: [time],
            id: new Date().getSeconds()
        }, (err) => {
            if (!err) {
                module.exports.evmMine()
            }
        });
    },
    evmMine: function () {
        web3.currentProvider.send({
            jsonrpc: '2.0',
            method: 'evm_mine',
            params: [],
            id: new Date().getSeconds()
        });
    }
}
