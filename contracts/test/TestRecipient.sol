pragma solidity ^0.5.5;

import "../utils/GsnUtils.sol";
import "../interfaces/IRelayHub.sol";
import "../BaseRelayRecipient.sol";
import "./TestSponsorConfigurableMisbehavior.sol";

contract TestRecipient is BaseRelayRecipient {

    function setHub(IRelayHub _relayHub) public {
        relayHub = _relayHub;
    }

    event Reverting(string message);

    function testRevert() public {
        require(address(this) == address(0), "always fail");
        emit Reverting("if you see this revert failed...");
    }

    address payable sponsor;

    function setWithdrawDuringRelayedCall(address payable _sponsor) public {
        sponsor = _sponsor;
    }

    function() external payable {}

    event SampleRecipientEmitted(string message, address realSender, address msgSender, address origin);

    function emitMessage(string memory message) public {
        if (sponsor != address(0)) {
            withdrawAllBalance();
        }

        emit SampleRecipientEmitted(message, getSender(), msg.sender, tx.origin);
    }

    function withdrawAllBalance() public {
        uint256 balance = relayHub.balanceOf(sponsor);
        TestSponsorConfigurableMisbehavior(sponsor).withdrawAllBalance();
    }

    function dontEmitMessage(string memory message) public {}

    function emitMessageNoParams() public {
        emit SampleRecipientEmitted("Method with no parameters", getSender(), msg.sender, tx.origin);
    }
}
