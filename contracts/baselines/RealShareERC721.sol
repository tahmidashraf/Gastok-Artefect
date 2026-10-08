// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RealShareERC721
 * @notice ERC-721 baseline for the token-standard gas comparison. Each fractional
 *         unit is a distinct NFT, so batch issuance is an O(n) mint loop — the
 *         cost characteristic the paper contrasts against ERC-1155.
 */
contract RealShareERC721 is ERC721, Ownable {
    uint256 public nextTokenId;
    mapping(address => bool) public kycApproved;

    constructor() ERC721("RealShare721", "RS721") Ownable(msg.sender) {}

    function approveKYC(address investor) external onlyOwner {
        kycApproved[investor] = true;
    }

    /// @notice Mint `n` distinct NFTs to a KYC-approved investor (loop-based, O(n)).
    function batchMint(address to, uint256 n) external onlyOwner {
        require(kycApproved[to], "RS721: recipient not KYC-approved");
        for (uint256 i = 0; i < n; i++) {
            _mint(to, nextTokenId);
            nextTokenId++;
        }
    }
}
