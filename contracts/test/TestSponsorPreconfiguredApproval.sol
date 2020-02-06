pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

import "./TestSponsorEverythingAccepted.sol";

contract TestSponsorPreconfiguredApproval is TestSponsorEverythingAccepted {

    bytes public expectedApprovalData;

    function setExpectedApprovalData(bytes memory val) public {
        expectedApprovalData = val;
    }

    function acceptRelayedCall(
        EIP712Sig.RelayRequest calldata relayRequest,
        bytes calldata approvalData,
        uint256 maxPossibleCharge
    )
    external
    view
    returns (uint256, bytes memory){
        if (keccak256(expectedApprovalData) != keccak256(approvalData)) {
            return (14,
            abi.encodePacked(
                "test: unexpected approvalData: '", approvalData, "' instead of '", expectedApprovalData, "'"));
        }
        return (0, "");
    }
}
