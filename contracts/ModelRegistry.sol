// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ModelRegistry
 * @notice Anchors the hash of each federated-learning global model round on-chain,
 *         giving the tokenization platform a tamper-evident, auditable record of the
 *         compliance-risk model used to gate KYC decisions, without storing any data
 *         off-chain participants hold privately.
 */
contract ModelRegistry is Ownable {
    struct Anchor {
        bytes32 modelHash;
        uint64 round;
        uint64 timestamp;
    }

    mapping(uint256 => Anchor) public anchors; // round => anchor
    uint256 public latestRound;

    event ModelAnchored(uint256 indexed round, bytes32 modelHash);

    constructor() Ownable(msg.sender) {}

    /// @notice Record the keccak/SHA digest of round `round`'s aggregated global model.
    function anchorModel(uint256 round, bytes32 modelHash) external onlyOwner {
        anchors[round] = Anchor(modelHash, uint64(round), uint64(block.timestamp));
        latestRound = round;
        emit ModelAnchored(round, modelHash);
    }
}
