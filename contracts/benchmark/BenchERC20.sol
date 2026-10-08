// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BenchERC20
 * @notice One ERC-20 contract represents ONE property. Fractions are fungible units.
 *         A catalogue of P properties therefore requires P deployed contracts, which is
 *         the architectural cost the multi-property benchmark measures against a single
 *         ERC-1155 contract.
 */
contract BenchERC20 is ERC20, Ownable {
    constructor(string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {}

    /// @notice Single balance credit to one holder.
    function mintTo(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Distribute this property's units to many investors in ONE transaction:
    ///         N recipients => N balance slots.
    function distributeToMany(address[] calldata to, uint256[] calldata amounts)
        external
        onlyOwner
    {
        require(to.length == amounts.length, "len");
        for (uint256 i = 0; i < to.length; i++) {
            _mint(to[i], amounts[i]);
        }
    }
}
