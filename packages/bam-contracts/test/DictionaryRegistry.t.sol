// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { DictionaryRegistry } from "../src/peripheral/DictionaryRegistry.sol";
import { IDictionaryRegistry } from "../src/interfaces/IDictionaryRegistry.sol";
import { SocialBlobsTypes } from "../src/libraries/SocialBlobsTypes.sol";

/// @title DictionaryRegistryTest
/// @notice Tests for DictionaryRegistry contract
contract DictionaryRegistryTest is Test {
    DictionaryRegistry public registry;

    address public owner = address(this);
    address public alice = address(0x1);

    bytes32 public constant DICT_HASH_1 = keccak256("dictionary-v1");
    bytes32 public constant DICT_HASH_2 = keccak256("dictionary-v2");
    string public constant IPFS_CID_1 = "QmTest1234567890abcdef";
    string public constant IPFS_CID_2 = "QmTest0987654321fedcba";

    function setUp() public {
        registry = new DictionaryRegistry(owner);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTRATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_register_success() public {
        vm.expectEmit(true, false, true, true);
        emit IDictionaryRegistry.DictionaryRegistered(DICT_HASH_1, IPFS_CID_1, alice);

        vm.prank(alice);
        registry.register(DICT_HASH_1, IPFS_CID_1);

        assertTrue(registry.isKnown(DICT_HASH_1));
        assertEq(registry.dictionaryCount(), 1);
    }

    function test_register_multiple() public {
        registry.register(DICT_HASH_1, IPFS_CID_1);
        registry.register(DICT_HASH_2, IPFS_CID_2);

        assertTrue(registry.isKnown(DICT_HASH_1));
        assertTrue(registry.isKnown(DICT_HASH_2));
        assertEq(registry.dictionaryCount(), 2);
    }

    function test_register_zeroHash() public {
        vm.expectRevert(IDictionaryRegistry.InvalidContentHash.selector);
        registry.register(bytes32(0), IPFS_CID_1);
    }

    function test_register_duplicate() public {
        registry.register(DICT_HASH_1, IPFS_CID_1);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDictionaryRegistry.DictionaryAlreadyRegistered.selector, DICT_HASH_1
            )
        );
        registry.register(DICT_HASH_1, IPFS_CID_2);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // DEACTIVATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_deactivate_success() public {
        registry.register(DICT_HASH_1, IPFS_CID_1);

        vm.expectEmit(true, true, false, true);
        emit IDictionaryRegistry.DictionaryDeactivated(DICT_HASH_1, owner);

        registry.deactivate(DICT_HASH_1);

        assertFalse(registry.isKnown(DICT_HASH_1));
    }

    function test_deactivate_notFound() public {
        vm.expectRevert(
            abi.encodeWithSelector(IDictionaryRegistry.DictionaryNotFound.selector, DICT_HASH_1)
        );
        registry.deactivate(DICT_HASH_1);
    }

    function test_deactivate_alreadyDeactivated() public {
        registry.register(DICT_HASH_1, IPFS_CID_1);
        registry.deactivate(DICT_HASH_1);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDictionaryRegistry.DictionaryAlreadyDeactivated.selector, DICT_HASH_1
            )
        );
        registry.deactivate(DICT_HASH_1);
    }

    function test_deactivate_onlyOwner() public {
        registry.register(DICT_HASH_1, IPFS_CID_1);

        vm.prank(alice);
        vm.expectRevert();
        registry.deactivate(DICT_HASH_1);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERY TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_isKnown_notRegistered() public view {
        assertFalse(registry.isKnown(DICT_HASH_1));
    }

    function test_isKnown_deactivated() public {
        registry.register(DICT_HASH_1, IPFS_CID_1);
        registry.deactivate(DICT_HASH_1);

        assertFalse(registry.isKnown(DICT_HASH_1));
    }

    function test_getDictionary_success() public {
        registry.register(DICT_HASH_1, IPFS_CID_1);

        SocialBlobsTypes.Dictionary memory dict = registry.getDictionary(DICT_HASH_1);

        assertEq(dict.contentHash, DICT_HASH_1);
        assertEq(dict.ipfsCid, IPFS_CID_1);
        assertTrue(dict.registeredAt > 0);
        assertTrue(dict.active);
    }

    function test_getDictionary_notFound() public {
        vm.expectRevert(
            abi.encodeWithSelector(IDictionaryRegistry.DictionaryNotFound.selector, DICT_HASH_1)
        );
        registry.getDictionary(DICT_HASH_1);
    }

    function test_getAllDictionaries() public {
        registry.register(DICT_HASH_1, IPFS_CID_1);
        registry.register(DICT_HASH_2, IPFS_CID_2);

        bytes32[] memory hashes = registry.getAllDictionaries();

        assertEq(hashes.length, 2);
        assertEq(hashes[0], DICT_HASH_1);
        assertEq(hashes[1], DICT_HASH_2);
    }

    function test_activeDictionaryCount() public {
        registry.register(DICT_HASH_1, IPFS_CID_1);
        registry.register(DICT_HASH_2, IPFS_CID_2);

        assertEq(registry.activeDictionaryCount(), 2);

        registry.deactivate(DICT_HASH_1);

        assertEq(registry.activeDictionaryCount(), 1);
    }
}
