// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RealShareERC20
 * @notice ERC-20 baseline for the token-standard gas comparison. Fungible units are
 *         minted in a single call regardless of quantity, but a single ERC-20 contract
 *         represents only one asset and cannot model a catalogue of distinct properties.
 */
contract RealShareERC20 is ERC20, Ownable {
    mapping(address => bool) public kycApproved;

    constructor() ERC20("RealShare20", "RS20") Ownable(msg.sender) {}

    function approveKYC(address investor) external onlyOwner {
        kycApproved[investor] = true;
    }

    /// @notice Mint `amount` fungible units to a KYC-approved investor (single SSTORE path).
    function mintUnits(address to, uint256 amount) external onlyOwner {
        require(kycApproved[to], "RS20: recipient not KYC-approved");
        _mint(to, amount);
    }
}
