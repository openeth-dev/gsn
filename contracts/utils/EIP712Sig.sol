pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;

import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";

// https://github.com/ethereum/EIPs/blob/master/assets/eip-712/Example.sol
contract EIP712Sig {

    using ECDSA for bytes32;

    struct EIP712Domain {
        string name;
        string version;
//        uint256 chainId;
        address verifyingContract;
    }

    struct CallData {
        address target;
        uint256 gasLimit;
        uint256 gasPrice;
        bytes encodedFunction;
    }

    struct RelayData {
        address senderAccount;
        uint256 senderNonce;
        address relayAddress;
        uint256 pctRelayFee;
        address gasSponsor;
    }

    struct RelayRequest {
        CallData callData;
        RelayData relayData;
    }

    bytes32 constant EIP712DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,address verifyingContract)"
    );

    bytes32 public constant RELAY_REQUEST_TYPEHASH = keccak256("RelayRequest(CallData callData,RelayData relayData)CallData(address target,uint256 gasLimit,uint256 gasPrice,bytes encodedFunction)RelayData(address senderAccount,uint256 senderNonce,address relayAddress,uint256 pctRelayFee)");

    bytes32 public constant CALLDATA_TYPEHASH = keccak256("CallData(address target,uint256 gasLimit,uint256 gasPrice,bytes encodedFunction)");

    bytes32 public constant RELAYDATA_TYPEHASH = keccak256("RelayData(address senderAccount,uint256 senderNonce,address relayAddress,uint256 pctRelayFee)");

    bytes32 public DOMAIN_SEPARATOR; //not constant - based on chainId

    constructor (address verifier) public {
        DOMAIN_SEPARATOR = hash(EIP712Domain({
            name : 'GSN Relayed Transaction',
            version : '1',
//            chainId : getChainID(),
            verifyingContract : verifier
            }));
    }

    function hash(EIP712Domain memory eip712Domain) internal pure returns (bytes32) {
        return keccak256(abi.encode(
                EIP712DOMAIN_TYPEHASH,
                keccak256(bytes(eip712Domain.name)),
                keccak256(bytes(eip712Domain.version)),
//                eip712Domain.chainId,
                eip712Domain.verifyingContract
            ));
    }

    function hash(RelayRequest memory req) internal pure returns (bytes32) {
        return keccak256(abi.encode(
                RELAY_REQUEST_TYPEHASH,
                    hash(req.callData),
                    hash(req.relayData)
            ));
    }

    function hash(CallData memory req) internal pure returns (bytes32) {
        return keccak256(abi.encode(
                CALLDATA_TYPEHASH,
                req.target,
                req.gasLimit,
                req.gasPrice,
                keccak256(req.encodedFunction)
            ));
    }

    function hash(RelayData memory req) internal pure returns (bytes32) {
        return keccak256(abi.encode(
                RELAYDATA_TYPEHASH,
                req.senderAccount,
                req.senderNonce,
                req.relayAddress,
                req.pctRelayFee
            ));
    }

    function verify(RelayRequest memory req, bytes memory signature) public view returns (bool) {
        bytes32 digest = keccak256(abi.encodePacked(
                "\x19\x01", DOMAIN_SEPARATOR,
                hash(req)
            ));
        return digest.recover(signature) == req.relayData.senderAccount;
    }

    function getChainID() internal pure returns (uint256) {
//        uint256 id;
//        assembly {
//            id := chainid()
//        }
        return 7;
    }
}
