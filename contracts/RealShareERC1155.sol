// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RealShareERC1155
 * @notice Fractional real-estate tokenization. Each property is an ERC-1155 token id;
 *         fractions are token amounts. Transfers and mints are gated by KYC approval.
 * @dev Built for thesis experiments (gas / latency measurement on EVM testnets).
 */
contract RealShareERC1155 is ERC1155, Ownable {
    struct Property {
        bool listed;
        bool active;
        uint256 totalFractions;
        uint256 mintedFractions;
        string metadataURI;
    }

    mapping(uint256 => Property) public properties;
    mapping(address => bool) public kycApproved;

    event PropertyListed(uint256 indexed propertyId, uint256 totalFractions, string metadataURI);
    event PropertyDeactivated(uint256 indexed propertyId);
    event KYCApproved(address indexed investor);
    event KYCRevoked(address indexed investor);
    event FractionsMinted(uint256 indexed propertyId, address indexed to, uint256 amount);

    constructor() ERC1155("https://realshare.example/api/token/{id}.json") Ownable(msg.sender) {}

    /// @notice Owner lists a new property with a fixed fraction supply cap.
    function listProperty(uint256 propertyId, uint256 totalFractions, string calldata metadataURI)
        external
        onlyOwner
    {
        require(!properties[propertyId].listed, "RealShare: already listed");
        require(totalFractions > 0, "RealShare: zero supply");
        properties[propertyId] = Property({
            listed: true,
            active: true,
            totalFractions: totalFractions,
            mintedFractions: 0,
            metadataURI: metadataURI
        });
        emit PropertyListed(propertyId, totalFractions, metadataURI);
    }

    /// @notice Owner deactivates a property (no further mints/transfers of it).
    function deactivateProperty(uint256 propertyId) external onlyOwner {
        require(properties[propertyId].listed, "RealShare: not listed");
        properties[propertyId].active = false;
        emit PropertyDeactivated(propertyId);
    }

    /// @notice Owner approves an investor's KYC.
    function approveKYC(address investor) external onlyOwner {
        kycApproved[investor] = true;
        emit KYCApproved(investor);
    }

    /// @notice Owner revokes an investor's KYC.
    function revokeKYC(address investor) external onlyOwner {
        kycApproved[investor] = false;
        emit KYCRevoked(investor);
    }

    /// @notice Mint fractions of a listed, active property to a KYC-approved investor.
    function mintFractions(uint256 propertyId, address to, uint256 amount) external onlyOwner {
        Property storage p = properties[propertyId];
        require(p.listed && p.active, "RealShare: property unavailable");
        require(kycApproved[to], "RealShare: recipient not KYC-approved");
        require(p.mintedFractions + amount <= p.totalFractions, "RealShare: exceeds supply");
        p.mintedFractions += amount;
        _mint(to, propertyId, amount, "");
        emit FractionsMinted(propertyId, to, amount);
    }

    /// @notice Batch-mint fractions of several listed properties to one KYC-approved investor
    ///         in a single transaction (native ERC-1155 batch path).
    function batchMintFractions(uint256[] calldata propertyIds, address to, uint256[] calldata amounts)
        external
        onlyOwner
    {
        require(propertyIds.length == amounts.length, "RealShare: length mismatch");
        require(kycApproved[to], "RealShare: recipient not KYC-approved");
        for (uint256 i = 0; i < propertyIds.length; i++) {
            Property storage p = properties[propertyIds[i]];
            require(p.listed && p.active, "RealShare: property unavailable");
            require(p.mintedFractions + amounts[i] <= p.totalFractions, "RealShare: exceeds supply");
            p.mintedFractions += amounts[i];
            emit FractionsMinted(propertyIds[i], to, amounts[i]);
        }
        _mintBatch(to, propertyIds, amounts, "");
    }

    /// @dev KYC gate on all transfers (mint = from 0x0, burn = to 0x0 are allowed).
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        if (from != address(0) && to != address(0)) {
            require(kycApproved[from], "RealShare: sender not KYC-approved");
            require(kycApproved[to], "RealShare: recipient not KYC-approved");
            for (uint256 i = 0; i < ids.length; i++) {
                require(properties[ids[i]].active, "RealShare: property inactive");
            }
        }
        super._update(from, to, ids, values);
    }
}
