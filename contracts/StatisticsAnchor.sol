// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// Records integrity commitments only. No tokens, funds, betting or rewards.
contract StatisticsAnchor {
    address public owner;
    address public pendingOwner;
    struct Record { bytes32 root; uint64 count; uint64 timestamp; }
    mapping(bytes32 => Record) public records;
    event RootRecorded(bytes32 indexed dataset, bytes32 root, uint64 count);
    event OwnerProposed(address indexed nextOwner);
    event OwnerChanged(address indexed nextOwner);
    error Unauthorized();
    error InvalidRecord();

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert Unauthorized();
        owner = initialOwner;
    }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }

    function recordRoot(bytes32 dataset, bytes32 root, uint64 count) external onlyOwner {
        if (dataset == bytes32(0) || root == bytes32(0) || count == 0 || records[dataset].root != bytes32(0)) revert InvalidRecord();
        records[dataset] = Record(root, count, uint64(block.timestamp));
        emit RootRecorded(dataset, root, count);
    }
    function proposeOwner(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert Unauthorized();
        pendingOwner = nextOwner; emit OwnerProposed(nextOwner);
    }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        owner = pendingOwner; pendingOwner = address(0); emit OwnerChanged(owner);
    }
    /// Leaf = SHA256(0x00 || canonical JSON), node = SHA256(0x01 || left || right).
    function verifyLeaf(bytes32 dataset, bytes32 leaf, bytes32[] calldata siblings, bool[] calldata left) external view returns (bool) {
        if (siblings.length != left.length || siblings.length > 32 || records[dataset].root == bytes32(0)) return false;
        bytes32 value = leaf;
        for (uint256 i = 0; i < siblings.length; ++i) {
            value = left[i] ? sha256(abi.encodePacked(bytes1(0x01), siblings[i], value)) : sha256(abi.encodePacked(bytes1(0x01), value, siblings[i]));
        }
        return value == records[dataset].root;
    }
}
