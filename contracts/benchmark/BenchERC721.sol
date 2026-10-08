// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BenchERC721
 * @notice Each fraction is a distinct NFT (token id). Issuing X fractions therefore creates
 *         X ownership records through an O(X) mint loop, and distributing to N investors
 *         creates a separate token id per fraction per investor. This is the cost
 *         characteristic contrasted against ERC-1155's balance model.
 */
contract BenchERC721 is ERC721, Ownable {
    uint256 public nextTokenId;

    constructor() ERC721("BenchRS721", "BRS721") Ownable(msg.sender) {}

    /// @notice Mint `n` distinct NFTs (fractions) to one holder (O(n) loop).
    function mintN(address to, uint256 n) external onlyOwner {
        uint256 id = nextTokenId;
        for (uint256 i = 0; i < n; i++) {
            _mint(to, id);
            id++;
        }
        nextTokenId = id;
    }

    /// @notice Distribute fractions to many investors: `counts[i]` NFTs to `to[i]`.
    function distributeToMany(address[] calldata to, uint256[] calldata counts)
        external
        onlyOwner
    {
        require(to.length == counts.length, "len");
        uint256 id = nextTokenId;
        for (uint256 i = 0; i < to.length; i++) {
            for (uint256 j = 0; j < counts[i]; j++) {
                _mint(to[i], id);
                id++;
            }
        }
        nextTokenId = id;
    }

    /// @notice Transfer `n` consecutive owned fractions to one recipient (O(n)).
    function transferN(address from, address to, uint256 startId, uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            safeTransferFrom(from, to, startId + i);
        }
    }
}
