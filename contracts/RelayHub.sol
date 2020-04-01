/* solhint-disable avoid-low-level-calls */
/* solhint-disable no-inline-assembly */
/* solhint-disable not-rely-on-time */
/* solhint-disable bracket-align */
pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

import "@0x/contracts-utils/contracts/src/LibBytes.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";

import "./utils/EIP712Sig.sol";
import "./utils/GSNTypes.sol";
import "./utils/GsnUtils.sol";
import "./utils/RLPReader.sol";
import "./interfaces/IRelayHub.sol";
import "./interfaces/IPaymaster.sol";
import "./StakeManager.sol";

contract RelayHub is IRelayHub {

    string constant public COMMIT_ID = "$Id$";

    using ECDSA for bytes32;

    // Minimum stake a relay can have. An attack to the network will never cost less than half this value.
    uint256 constant private MINIMUM_STAKE = 1 ether;

    // Minimum unstake delay blocks of a relay manager's stake on the StakeManager
    uint256 constant private MINIMUM_UNSTAKE_DELAY = 1000;

    // Minimum balance required for a relay to register or re-register. Prevents user error in registering a relay that
    // will not be able to immediatly start serving requests.
    uint256 constant private MINIMUM_RELAY_BALANCE = 0.1 ether;

    // Maximum funds that can be deposited at once. Prevents user error by disallowing large deposits.
    uint256 constant private MAXIMUM_RECIPIENT_DEPOSIT = 2 ether;

    /**
    * the total gas overhead of relayCall(), before the first gasleft() and after the last gasleft().
    * Assume that relay has non-zero balance (costs 15'000 more otherwise).
    */

    // Gas cost of all relayCall() instructions after actual 'calculateCharge()'
    uint256 constant private GAS_OVERHEAD = 36713 + 1328;

    function getHubOverhead() external view returns (uint256) {
        return GAS_OVERHEAD;
    }
    // Gas set aside for all relayCall() instructions to prevent unexpected out-of-gas exceptions
    uint256 constant private GAS_RESERVE = 100000;

    uint256 public gtxdatanonzero;
    uint256 constant public GTRANSACTION = 21000;

    // Nonces of senders, used to prevent replay attacks
    mapping(address => uint256) private nonces;

    enum AtomicRecipientCallsStatus {OK, CanRelayFailed, RelayedCallFailed, PreRelayedFailed, PostRelayedFailed}

    // maps relay worker's address to its manager's address
    mapping(address => address) private workerToManager;

    // maps relay managers to the number of their workers
    mapping(address => uint256) private workerCount;

    uint256 constant public MAX_WORKER_COUNT = 10;

    mapping(address => uint256) private balances;

    string public version = "1.0.0";

    EIP712Sig private eip712sig;
    StakeManager private stakeManager;

    constructor (uint256 _gtxdatanonzero, StakeManager _stakeManager) public {
        eip712sig = new EIP712Sig(address(this));
        stakeManager = _stakeManager;
        gtxdatanonzero = _gtxdatanonzero;
    }

    function calldatagascost() private view returns (uint256) {
        return GTRANSACTION + msg.data.length * gtxdatanonzero;
    }

    function registerRelayServer(uint256 baseRelayFee, uint256 pctRelayFee, string calldata url) external {
        address relayManager = msg.sender;
        require(
            stakeManager.isRelayManagerStaked(relayManager, MINIMUM_STAKE, MINIMUM_UNSTAKE_DELAY),
            "relay manager not staked"
        );
        require(workerCount[relayManager] > 0, "no relay workers");
        emit RelayServerRegistered(relayManager, baseRelayFee, pctRelayFee, url);
    }

    function addRelayWorkers(address[] calldata newRelayWorkers) external {
        address relayManager = msg.sender;
        workerCount[relayManager] = workerCount[relayManager] + newRelayWorkers.length;
        require(workerCount[relayManager] <= MAX_WORKER_COUNT, "too many workers");

        require(
            stakeManager.isRelayManagerStaked(relayManager, MINIMUM_STAKE, MINIMUM_UNSTAKE_DELAY),
            "relay manager not staked"
        );

        for (uint256 i = 0; i < newRelayWorkers.length; i++) {
            require(workerToManager[newRelayWorkers[i]] == address(0), "this worker has a manager");
            workerToManager[newRelayWorkers[i]] = relayManager;
        }

        emit RelayWorkersAdded(relayManager, newRelayWorkers, workerCount[relayManager]);
    }

    function depositFor(address target) public payable {
        uint256 amount = msg.value;
        require(amount <= MAXIMUM_RECIPIENT_DEPOSIT, "deposit too big");

        balances[target] = SafeMath.add(balances[target], amount);

        emit Deposited(target, msg.sender, amount);
    }

    function balanceOf(address target) external view returns (uint256) {
        return balances[target];
    }

    function withdraw(uint256 amount, address payable dest) public {
        address payable account = msg.sender;
        require(balances[account] >= amount, "insufficient funds");

        balances[account] -= amount;
        dest.transfer(amount);

        emit Withdrawn(account, dest, amount);
    }

    function getNonce(address from) external view returns (uint256) {
        return nonces[from];
    }

    function canRelay(
        GSNTypes.RelayRequest memory relayRequest,
        uint256 maxPossibleGas,
        uint256 acceptRelayedCallGasLimit,
        bytes memory signature,
        bytes memory approvalData
    )
    public
    view
    returns (uint256 status, bytes memory recipientContext)
    {
        // Verify the sender's signature on the transaction - note that approvalData is *not* signed
        if (!eip712sig.verify(relayRequest, signature)) {
            return (uint256(CanRelayStatus.WrongSignature), "");
        }

        // Verify the transaction is not being replayed
        if (nonces[relayRequest.relayData.senderAddress] != relayRequest.relayData.senderNonce) {
            return (uint256(CanRelayStatus.WrongNonce), "");
        }

        bytes memory encodedTx = abi.encodeWithSelector(IPaymaster(address(0)).acceptRelayedCall.selector,
            relayRequest, approvalData, maxPossibleGas
        );

        (bool success, bytes memory returndata) =
        relayRequest.relayData.paymaster.staticcall.gas(acceptRelayedCallGasLimit)(encodedTx);

        if (!success) {
            return (uint256(CanRelayStatus.AcceptRelayedCallReverted), "");
        } else {
            (status, recipientContext) = abi.decode(returndata, (uint256, bytes));

            // This can be either CanRelayStatus.OK or a custom error code
            if ((status == 0) || (status > 10)) {
                return (status, recipientContext);
            } else {
                // Error codes [1-10] are reserved to RelayHub
                return (uint256(CanRelayStatus.InvalidRecipientStatusCode), "");
            }
        }
    }

    function getAndValidateGasLimits(GSNTypes.GasData memory gasData, address paymaster)
    private
    view
    returns (uint256 maxPossibleGas, GSNTypes.GasLimits memory gasLimits)
    {
        gasLimits =
        IPaymaster(paymaster).getGasLimits();
        uint256 requiredGas =
            GAS_OVERHEAD +
            gasLimits.acceptRelayedCallGasLimit +
            gasLimits.preRelayedCallGasLimit +
            gasLimits.postRelayedCallGasLimit +
            gasData.gasLimit;

        // This transaction must have enough gas to forward the call to the recipient with the requested amount, and not
        // run out of gas later in this function.
        require(
            gasleft() >= GAS_RESERVE + requiredGas,
            "Not enough gas left for recipientCallsAtomic to complete");

        // The maximum possible charge is the cost of transaction assuming all bytes of calldata are non-zero and
        // all paymaster and recipient calls consume entire available gas limit
        maxPossibleGas = calldatagascost() + requiredGas;
        uint256 maxPossibleCharge = calculateCharge(
            maxPossibleGas,
            gasData
        );

        // We don't yet know how much gas will be used by the recipient, so we make sure there are enough funds to pay
        // for the maximum possible charge.
        require(maxPossibleCharge <= balances[paymaster],
            "Paymaster balance too low");
        return (maxPossibleGas, gasLimits);
    }

    /**
     * @notice Relay a transaction.
     *
     */
    function relayCall(
    // TODO: msg.sender used to be treated as 'relay' (now passed in a struct),
    //  make sure this does not have security impl
        GSNTypes.RelayRequest calldata relayRequest,
        bytes calldata signature,
        bytes calldata approvalData
    )
    external
    {
        uint256 initialGas = gasleft();
        bytes4 functionSelector = LibBytes.readBytes4(relayRequest.encodedFunction, 0);
        // Initial soundness checks - the relay must make sure these pass, or it will pay for a reverted transaction.
        // The worker must be controlled by a manager with a locked stake
        require(workerToManager[msg.sender] != address(0), "Unknown relay worker");
        require(
            stakeManager.isRelayManagerStaked(workerToManager[msg.sender], MINIMUM_STAKE, MINIMUM_UNSTAKE_DELAY),
            "relay manager not staked"
        );
        // A relay may use a higher gas price than the one requested by the signer (to e.g. get the transaction in a
        // block faster), but it must not be lower. The recipient will be charged for the requested gas price, not the
        // one used in the transaction.
        require(relayRequest.gasData.gasPrice <= tx.gasprice, "Invalid gas price");
        bytes memory recipientContext;
        GSNTypes.GasLimits memory gasLimits;
        {
            uint256 maxPossibleGas;
            (maxPossibleGas, gasLimits) = getAndValidateGasLimits(relayRequest.gasData, relayRequest.relayData.paymaster);

            // We now verify the legitimacy of the transaction (it must be signed by the sender, and not be replayed),
            // and that the paymaster will agree to be charged for it.
            uint256 canRelayStatus;
            (canRelayStatus, recipientContext) =
            // TODO: this new RelayRequest is needed because solc doesn't implement calldata to memory conversion yet
            canRelay(
                GSNTypes.RelayRequest(
                    relayRequest.target,
                    relayRequest.encodedFunction,
                    relayRequest.gasData,
                    relayRequest.relayData),
                maxPossibleGas, gasLimits.acceptRelayedCallGasLimit, signature, approvalData);

            if (canRelayStatus != uint256(CanRelayStatus.OK)) {
                emit CanRelayFailed(
                    workerToManager[msg.sender],
                    msg.sender,
                    relayRequest.relayData.senderAddress,
                    relayRequest.target,
                    relayRequest.relayData.paymaster,
                    functionSelector,
                    canRelayStatus);
                return;
            }
        }

        // From this point on, this transaction will not revert nor run out of gas, and the recipient will be charged
        // for the gas spent.

        // The sender's nonce is advanced to prevent transaction replays.
        nonces[relayRequest.relayData.senderAddress]++;

        // Calls to the recipient are performed atomically inside an inner transaction which may revert in case of
        // errors in the recipient. In either case (revert or regular execution) the return data encodes the
        // RelayCallStatus value.
        RelayCallStatus status;
        {
            bytes memory data =
            abi.encodeWithSelector(this.recipientCallsAtomic.selector, relayRequest, gasLimits, initialGas, calldatagascost(), recipientContext);
            (, bytes memory relayCallStatus) = address(this).call(data);
            status = abi.decode(relayCallStatus, (RelayCallStatus));
        }

        // We now perform the actual charge calculation, based on the measured gas used
        uint256 charge = calculateCharge(
            calldatagascost() +
            (initialGas - gasleft()) +
            GAS_OVERHEAD,
            relayRequest.gasData
        );

        // We've already checked that the recipient has enough balance to pay for the relayed transaction, this is only
        // a sanity check to prevent overflows in case of bugs.
        require(balances[relayRequest.relayData.paymaster] >= charge, "Should not get here");
        balances[relayRequest.relayData.paymaster] -= charge;
        balances[workerToManager[msg.sender]] += charge;

        emit TransactionRelayed(
            workerToManager[msg.sender],
            msg.sender,
            relayRequest.relayData.senderAddress,
            relayRequest.target,
            relayRequest.relayData.paymaster,
            functionSelector,
            status,
            charge);
    }

    struct AtomicData {
        uint256 balanceBefore;
        bytes32 preReturnValue;
        bool relayedCallSuccess;
        bytes data;
    }

    function recipientCallsAtomic(
        GSNTypes.RelayRequest calldata relayRequest,
        GSNTypes.GasLimits calldata gasLimits,
        uint256 totalInitialGas,
        uint256 calldataGas,
        bytes calldata recipientContext
    )
    external
    returns (RelayCallStatus)
    {
        AtomicData memory atomicData;
        // A new gas measurement is performed inside recipientCallsAtomic, since
        // due to EIP150 available gas amounts cannot be directly compared across external calls

        // This external function can only be called by RelayHub itself, creating an internal transaction. Calls to the
        // recipient (preRelayedCall, the relayedCall, and postRelayedCall) are called from inside this transaction.
        require(msg.sender == address(this), "Only RelayHub should call this function");

        // If either pre or post reverts, the whole internal transaction will be reverted, reverting all side effects on
        // the recipient. The recipient will still be charged for the used gas by the relay.

        // The recipient is no allowed to withdraw balance from RelayHub during a relayed transaction. We check pre and
        // post state to ensure this doesn't happen.
        atomicData.balanceBefore = balances[relayRequest.relayData.paymaster];

        // First preRelayedCall is executed.
        // Note: we open a new block to avoid growing the stack too much.
        atomicData.data = abi.encodeWithSelector(
            IPaymaster(address(0)).preRelayedCall.selector, recipientContext
        );
        bytes memory retData;
        {
            bool success;
            // preRelayedCall may revert, but the recipient will still be charged: it should ensure in
            // acceptRelayedCall that this will not happen.
            (success, retData) = relayRequest.relayData.paymaster.call.gas(gasLimits.preRelayedCallGasLimit)(atomicData.data);
            if (!success) {
                revertWithStatus(RelayCallStatus.PreRelayedFailed);
            }
        }
        atomicData.preReturnValue = abi.decode(retData, (bytes32));

        // The actual relayed call is now executed. The sender's address is appended at the end of the transaction data
        (atomicData.relayedCallSuccess,) =
        relayRequest.target.call.gas(relayRequest.gasData.gasLimit)
        (abi.encodePacked(relayRequest.encodedFunction, relayRequest.relayData.senderAddress));

        // Finally, postRelayedCall is executed, with the relayedCall execution's status and a charge estimate
        // We now determine how much the recipient will be charged, to pass this value to postRelayedCall for accurate
        // accounting.
        atomicData.data = abi.encodeWithSelector(
            IPaymaster(address(0)).postRelayedCall.selector,
            recipientContext,
            atomicData.relayedCallSuccess,
            atomicData.preReturnValue,
            totalInitialGas - gasleft() + GAS_OVERHEAD + calldataGas,
            relayRequest.gasData
        );

        (bool successPost,) = relayRequest.relayData.paymaster.call.gas(gasLimits.postRelayedCallGasLimit)(atomicData.data);

        if (!successPost) {
            revertWithStatus(RelayCallStatus.PostRelayedFailed);
        }

        if (balances[relayRequest.relayData.paymaster] < atomicData.balanceBefore) {
            revertWithStatus(RelayCallStatus.RecipientBalanceChanged);
        }

        return atomicData.relayedCallSuccess ? RelayCallStatus.OK : RelayCallStatus.RelayedCallFailed;
    }

    /**
     * @dev Reverts the transaction with return data set to the ABI encoding of the status argument.
     */
    function revertWithStatus(RelayCallStatus status) private pure {
        bytes memory data = abi.encode(status);

        assembly {
            let dataSize := mload(data)
            let dataPtr := add(data, 32)

            revert(dataPtr, dataSize)
        }
    }

    function calculateCharge(uint256 gasUsed, GSNTypes.GasData memory gasData) public view returns (uint256) {
        return gasData.baseRelayFee + (gasUsed * gasData.gasPrice * (100 + gasData.pctRelayFee)) / 100;
    }

    struct Transaction {
        uint256 nonce;
        uint256 gasPrice;
        uint256 gasLimit;
        address to;
        uint256 value;
        bytes data;
    }

    function decodeTransaction(bytes memory rawTransaction) private pure returns (Transaction memory transaction) {
        (transaction.nonce,
        transaction.gasPrice,
        transaction.gasLimit,
        transaction.to,
        transaction.value,
        transaction.data) = RLPReader.decodeTransaction(rawTransaction);
        return transaction;

    }

    function penalizeRepeatedNonce(
        bytes memory unsignedTx1,
        bytes memory signature1,
        bytes memory unsignedTx2,
        bytes memory signature2)
    public
    {
        // Can be called by anyone.
        // If a relay attacked the system by signing multiple transactions with the same nonce
        // (so only one is accepted), anyone can grab both transactions from the blockchain and submit them here.
        // Check whether unsignedTx1 != unsignedTx2, that both are signed by the same address,
        // and that unsignedTx1.nonce == unsignedTx2.nonce.
        // If all conditions are met, relay is considered an "offending relay".
        // The offending relay will be unregistered immediately, its stake will be forfeited and given
        // to the address who reported it (msg.sender), thus incentivizing anyone to report offending relays.
        // If reported via a relay, the forfeited stake is split between
        // msg.sender (the relay used for reporting) and the address that reported it.

        address addr1 = keccak256(abi.encodePacked(unsignedTx1)).recover(signature1);
        address addr2 = keccak256(abi.encodePacked(unsignedTx2)).recover(signature2);

        require(addr1 == addr2, "Different signer");
        require(addr1 != address(0), "ecrecover failed");

        Transaction memory decodedTx1 = decodeTransaction(unsignedTx1);
        Transaction memory decodedTx2 = decodeTransaction(unsignedTx2);

        // checking that the same nonce is used in both transaction, with both signed by the same address
        // and the actual data is different
        // note: we compare the hash of the tx to save gas over iterating both byte arrays
        require(decodedTx1.nonce == decodedTx2.nonce, "Different nonce");

        bytes memory dataToCheck1 =
        abi.encodePacked(decodedTx1.data, decodedTx1.gasLimit, decodedTx1.to, decodedTx1.value);

        bytes memory dataToCheck2 =
        abi.encodePacked(decodedTx2.data, decodedTx2.gasLimit, decodedTx2.to, decodedTx2.value);

        require(keccak256(dataToCheck1) != keccak256(dataToCheck2), "tx is equal");

        penalize(addr1);
    }

    function penalizeIllegalTransaction(bytes memory unsignedTx, bytes memory signature) public {
        Transaction memory decodedTx = decodeTransaction(unsignedTx);
        if (decodedTx.to == address(this)) {
            bytes4 selector = GsnUtils.getMethodSig(decodedTx.data);
            require(
                selector != this.relayCall.selector,
                "Legal relay transaction");
        }

        address relay = keccak256(abi.encodePacked(unsignedTx)).recover(signature);
        require(relay != address(0), "ecrecover failed");

        penalize(relay);
    }

    function penalize(address relayWorker) private {
        address relayManager = workerToManager[relayWorker];
        // The worker must be controlled by a manager with a locked stake
        require(relayManager != address(0), "Unknown relay worker");
        require(
            stakeManager.isRelayManagerStaked(relayManager, MINIMUM_STAKE, MINIMUM_UNSTAKE_DELAY),
            "relay manager not staked"
        );
        (uint256 totalStake, , , ) = stakeManager.stakes(relayManager);
        stakeManager.penalizeRelayManager(relayManager, msg.sender, totalStake);
    }
}
