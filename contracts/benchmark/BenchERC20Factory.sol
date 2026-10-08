// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BenchERC20.sol";

/**
 * @title BenchERC20Factory
 * @notice Deploys one BenchERC20 contract per property, modelling the "ERC-20-per-property"
 *         architecture. The factory records the per-property deployment cost that a single
 *         multi-property ERC-1155 contract does not incur.
 */
contract BenchERC20Factory {
    address[] public properties;
    event PropertyDeployed(uint256 indexed index, address token);

    function deployProperty(string calldata name_, string calldata symbol_)
        external
        returns (address token)
    {
        BenchERC20 t = new BenchERC20(name_, symbol_);
        t.transferOwnership(msg.sender);
        token = address(t);
        properties.push(token);
        emit PropertyDeployed(properties.length - 1, token);
    }

    function count() external view returns (uint256) {
        return properties.length;
    }
}
