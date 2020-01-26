module.exports = [{ anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'relay', type: 'address' }, { indexed: true, internalType: 'address', name: 'from', type: 'address' }, { indexed: true, internalType: 'address', name: 'to', type: 'address' }, { indexed: false, internalType: 'bytes4', name: 'selector', type: 'bytes4' }, { indexed: false, internalType: 'uint256', name: 'reason', type: 'uint256' }], name: 'CanRelayFailed', type: 'event' }, { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'recipient', type: 'address' }, { indexed: true, internalType: 'address', name: 'from', type: 'address' }, { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'Deposited', type: 'event' }, { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'relay', type: 'address' }, { indexed: false, internalType: 'address', name: 'sender', type: 'address' }, { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'Penalized', type: 'event' }, { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'relay', type: 'address' }, { indexed: true, internalType: 'address', name: 'owner', type: 'address' }, { indexed: false, internalType: 'uint256', name: 'transactionFee', type: 'uint256' }, { indexed: false, internalType: 'uint256', name: 'stake', type: 'uint256' }, { indexed: false, internalType: 'uint256', name: 'unstakeDelay', type: 'uint256' }, { indexed: false, internalType: 'string', name: 'url', type: 'string' }], name: 'RelayAdded', type: 'event' }, { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'relay', type: 'address' }, { indexed: false, internalType: 'uint256', name: 'unstakeTime', type: 'uint256' }], name: 'RelayRemoved', type: 'event' }, { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'relay', type: 'address' }, { indexed: false, internalType: 'uint256', name: 'stake', type: 'uint256' }, { indexed: false, internalType: 'uint256', name: 'unstakeDelay', type: 'uint256' }], name: 'Staked', type: 'event' }, { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'relay', type: 'address' }, { indexed: true, internalType: 'address', name: 'from', type: 'address' }, { indexed: true, internalType: 'address', name: 'to', type: 'address' }, { indexed: false, internalType: 'bytes4', name: 'selector', type: 'bytes4' }, { indexed: false, internalType: 'enum IRelayHub.RelayCallStatus', name: 'status', type: 'uint8' }, { indexed: false, internalType: 'uint256', name: 'charge', type: 'uint256' }], name: 'TransactionRelayed', type: 'event' }, { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'relay', type: 'address' }, { indexed: false, internalType: 'uint256', name: 'stake', type: 'uint256' }], name: 'Unstaked', type: 'event' }, { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: 'account', type: 'address' }, { indexed: true, internalType: 'address', name: 'dest', type: 'address' }, { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' }], name: 'Withdrawn', type: 'event' }, { constant: true, inputs: [{ internalType: 'address', name: 'target', type: 'address' }], name: 'balanceOf', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], payable: false, stateMutability: 'view', type: 'function' }, { constant: true, inputs: [{ internalType: 'address', name: 'relay', type: 'address' }, { internalType: 'address', name: 'from', type: 'address' }, { internalType: 'address', name: 'to', type: 'address' }, { internalType: 'bytes', name: 'encodedFunction', type: 'bytes' }, { internalType: 'uint256', name: 'transactionFee', type: 'uint256' }, { internalType: 'uint256', name: 'gasPrice', type: 'uint256' }, { internalType: 'uint256', name: 'gasLimit', type: 'uint256' }, { internalType: 'uint256', name: 'nonce', type: 'uint256' }, { internalType: 'bytes', name: 'signature', type: 'bytes' }, { internalType: 'bytes', name: 'approvalData', type: 'bytes' }], name: 'canRelay', outputs: [{ internalType: 'uint256', name: 'status', type: 'uint256' }, { internalType: 'bytes', name: 'recipientContext', type: 'bytes' }], payable: false, stateMutability: 'view', type: 'function' }, { constant: false, inputs: [{ internalType: 'address', name: 'target', type: 'address' }], name: 'depositFor', outputs: [], payable: true, stateMutability: 'payable', type: 'function' }, { constant: true, inputs: [{ internalType: 'address', name: 'from', type: 'address' }], name: 'getNonce', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], payable: false, stateMutability: 'view', type: 'function' }, { constant: true, inputs: [{ internalType: 'address', name: 'relay', type: 'address' }], name: 'getRelay', outputs: [{ internalType: 'uint256', name: 'totalStake', type: 'uint256' }, { internalType: 'uint256', name: 'unstakeDelay', type: 'uint256' }, { internalType: 'uint256', name: 'unstakeTime', type: 'uint256' }, { internalType: 'address payable', name: 'owner', type: 'address' }, { internalType: 'enum IRelayHub.RelayState', name: 'state', type: 'uint8' }], payable: false, stateMutability: 'view', type: 'function' }, { constant: true, inputs: [{ internalType: 'uint256', name: 'relayedCallStipend', type: 'uint256' }, { internalType: 'uint256', name: 'gasPrice', type: 'uint256' }, { internalType: 'uint256', name: 'transactionFee', type: 'uint256' }], name: 'maxPossibleCharge', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], payable: false, stateMutability: 'view', type: 'function' }, { constant: false, inputs: [{ internalType: 'bytes', name: 'unsignedTx', type: 'bytes' }, { internalType: 'bytes', name: 'signature', type: 'bytes' }], name: 'penalizeIllegalTransaction', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' }, { constant: false, inputs: [{ internalType: 'bytes', name: 'unsignedTx1', type: 'bytes' }, { internalType: 'bytes', name: 'signature1', type: 'bytes' }, { internalType: 'bytes', name: 'unsignedTx2', type: 'bytes' }, { internalType: 'bytes', name: 'signature2', type: 'bytes' }], name: 'penalizeRepeatedNonce', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' }, { constant: false, inputs: [{ internalType: 'uint256', name: 'transactionFee', type: 'uint256' }, { internalType: 'string', name: 'url', type: 'string' }], name: 'registerRelay', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' }, { constant: false, inputs: [{ internalType: 'address', name: 'from', type: 'address' }, { internalType: 'address', name: 'to', type: 'address' }, { internalType: 'bytes', name: 'encodedFunction', type: 'bytes' }, { internalType: 'uint256', name: 'transactionFee', type: 'uint256' }, { internalType: 'uint256', name: 'gasPrice', type: 'uint256' }, { internalType: 'uint256', name: 'gasLimit', type: 'uint256' }, { internalType: 'uint256', name: 'nonce', type: 'uint256' }, { internalType: 'bytes', name: 'signature', type: 'bytes' }, { internalType: 'bytes', name: 'approvalData', type: 'bytes' }], name: 'relayCall', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' }, { constant: false, inputs: [{ internalType: 'address', name: 'relay', type: 'address' }], name: 'removeRelayByOwner', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' }, { constant: true, inputs: [{ internalType: 'uint256', name: 'relayedCallStipend', type: 'uint256' }], name: 'requiredGas', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], payable: false, stateMutability: 'view', type: 'function' }, { constant: false, inputs: [{ internalType: 'address', name: 'relayaddr', type: 'address' }, { internalType: 'uint256', name: 'unstakeDelay', type: 'uint256' }], name: 'stake', outputs: [], payable: true, stateMutability: 'payable', type: 'function' }, { constant: false, inputs: [{ internalType: 'address', name: 'relay', type: 'address' }], name: 'unstake', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' }, { constant: false, inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }, { internalType: 'address payable', name: 'dest', type: 'address' }], name: 'withdraw', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' }]
