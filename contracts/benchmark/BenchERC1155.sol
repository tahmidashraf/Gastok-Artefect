// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BenchERC1155
 * @notice Token-standard benchmark contract: one contract represents MANY properties,
 *         each property is a token id, each fraction is a unit of balance under that id.
 *         Exposes single, multi-recipient, and native-batch paths so the ERC-1155 workload
 *         can be compared on a semantically equivalent basis with ERC-20-per-property and
 *         ERC-721-per-fraction. KYC/access gating is intentionally excluded here so the
 *         measurement isolates token-standard mechanics; the KYC gate cost is identical
 *         across all three standards and is measured separately in the deployed contract.
 */
contract BenchERC1155 is ERC1155, Ownable {
    constructor() ERC1155("ipfs://bench/{id}.json") Ownable(msg.sender) {}

    /// @notice Single balance credit: `amount` units of property `id` to one holder.
    function mintSingle(uint256 id, address to, uint256 amount) external onlyOwner {
        _mint(to, id, amount, "");
    }

    /// @notice Distribute one property `id` to many investors in ONE transaction:
    ///         N recipients => N balance slots (loop of _mint). This is the honest
    ///         ERC-1155 multi-investor distribution primitive.
    function mintToMany(uint256 id, address[] calldata to, uint256[] calldata amounts)
        external
        onlyOwner
    {
        require(to.length == amounts.length, "len");
        for (uint256 i = 0; i < to.length; i++) {
            _mint(to[i], id, amounts[i], "");
        }
    }

    /// @notice Native ERC-1155 batch: many properties (ids) to ONE recipient in one call.
    function mintBatchOneRecipient(address to, uint256[] calldata ids, uint256[] calldata amounts)
        external
        onlyOwner
    {
        _mintBatch(to, ids, amounts, "");
    }

    /// @notice Distribute MANY properties across MANY investors (one _mint per (id,investor)).
    function mintGrid(uint256[] calldata ids, address[] calldata to, uint256[] calldata amounts)
        external
        onlyOwner
    {
        require(ids.length == to.length && to.length == amounts.length, "len");
        for (uint256 i = 0; i < ids.length; i++) {
            _mint(to[i], ids[i], amounts[i], "");
        }
    }
}
