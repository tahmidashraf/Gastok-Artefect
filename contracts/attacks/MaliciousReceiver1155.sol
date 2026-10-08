// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IRealShare {
    function mintFractions(uint256 propertyId, address to, uint256 amount) external;
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}

/**
 * @title MaliciousReceiver1155
 * @notice An ERC-1155 receiver that ATTEMPTS genuine re-entry from inside the
 *         onERC1155Received / onERC1155BatchReceived callbacks. Modes let a test
 *         drive each attack vector and assert that the target contract's guards
 *         (onlyOwner, KYC gate, checks-effects-interactions) defeat the attempt.
 *
 *         attempts counts how many re-entry calls the receiver tried; reentered
 *         records whether any re-entrant call actually SUCCEEDED (it must stay false).
 */
contract MaliciousReceiver1155 is IERC1155Receiver {
    enum Mode { NONE, REENTER_TRANSFER, REENTER_MINT, RECURSE, FORCE_REVERT, BAD_SELECTOR, GAS_BOMB }

    IRealShare public target;
    Mode public mode;
    uint256 public attempts;
    bool public reentered;
    uint256 public recursionDepth;

    function configure(address target_, Mode mode_) external {
        target = IRealShare(target_);
        mode = mode_;
        attempts = 0;
        reentered = false;
        recursionDepth = 0;
    }

    function _attack(uint256 id, uint256 amount) internal {
        if (mode == Mode.NONE) return;

        if (mode == Mode.FORCE_REVERT) {
            revert("malicious: forced revert");
        }
        if (mode == Mode.GAS_BOMB) {
            // Attempt to burn gas; the caller forwards limited gas, so this either
            // reverts inside the callback or is bounded by the 63/64 rule.
            uint256 x = 0;
            for (uint256 i = 0; i < 100000; i++) { x += i; }
            return;
        }
        if (mode == Mode.REENTER_TRANSFER) {
            attempts++;
            // try to re-enter and move tokens back out during the receive hook
            try target.safeTransferFrom(address(this), address(0xBEEF), id, amount, "") {
                reentered = true; // MUST NOT happen
            } catch {}
            return;
        }
        if (mode == Mode.REENTER_MINT) {
            attempts++;
            // try to mint more to ourselves during the receive hook
            try target.mintFractions(id, address(this), amount) {
                reentered = true; // MUST NOT happen (onlyOwner)
            } catch {}
            return;
        }
        if (mode == Mode.RECURSE) {
            attempts++;
            if (recursionDepth < 5) {
                recursionDepth++;
                try target.safeTransferFrom(address(this), address(this), id, amount, "") {
                    reentered = true;
                } catch {}
            }
            return;
        }
    }

    function onERC1155Received(address, address, uint256 id, uint256 value, bytes calldata)
        external
        returns (bytes4)
    {
        _attack(id, value);
        if (mode == Mode.BAD_SELECTOR) {
            return 0xdeadbeef; // invalid selector -> OZ _mint should reject the transfer
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata ids, uint256[] calldata values, bytes calldata)
        external
        returns (bytes4)
    {
        if (ids.length > 0) _attack(ids[0], values[0]);
        if (mode == Mode.BAD_SELECTOR) {
            return 0xdeadbeef;
        }
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
