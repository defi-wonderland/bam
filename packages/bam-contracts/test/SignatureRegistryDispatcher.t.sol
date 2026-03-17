// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { SignatureRegistryDispatcher } from "../src/core/SignatureRegistryDispatcher.sol";
import { ISignatureRegistry } from "../src/interfaces/ISignatureRegistry.sol";

/// @title MockBLSRegistry
/// @notice Mock BLS signature registry for testing
contract MockBLSRegistry is ISignatureRegistry {
    mapping(address => bytes) private _keys;

    function schemeId() external pure override returns (uint8) {
        return 0x02; // BLS
    }

    function schemeName() external pure override returns (string memory) {
        return "BLS12-381";
    }

    function pubKeySize() external pure override returns (uint256) {
        return 48;
    }

    function signatureSize() external pure override returns (uint256) {
        return 96;
    }

    function register(bytes calldata pubKey, bytes calldata) external override returns (uint256) {
        _keys[msg.sender] = pubKey;
        return 1;
    }

    function getKey(address owner) external view override returns (bytes memory) {
        return _keys[owner];
    }

    function isRegistered(address owner) external view override returns (bool) {
        return _keys[owner].length > 0;
    }

    function verify(bytes calldata, bytes32, bytes calldata) external pure override returns (bool) {
        return true;
    }

    function verifyWithRegisteredKey(address, bytes32, bytes calldata)
        external
        pure
        override
        returns (bool)
    {
        return true;
    }

    function supportsAggregation() external pure override returns (bool) {
        return true;
    }

    function verifyAggregated(bytes[] calldata, bytes32[] calldata, bytes calldata)
        external
        pure
        override
        returns (bool)
    {
        return true;
    }
}

/// @title MockECDSARegistry
/// @notice Mock ECDSA signature registry for testing
contract MockECDSARegistry is ISignatureRegistry {
    mapping(address => bytes) private _keys;

    function schemeId() external pure override returns (uint8) {
        return 0x01; // ECDSA
    }

    function schemeName() external pure override returns (string memory) {
        return "ECDSA-secp256k1";
    }

    function pubKeySize() external pure override returns (uint256) {
        return 0; // Recovered from signature
    }

    function signatureSize() external pure override returns (uint256) {
        return 65;
    }

    function register(bytes calldata pubKey, bytes calldata) external override returns (uint256) {
        _keys[msg.sender] = pubKey;
        return 1;
    }

    function getKey(address owner) external view override returns (bytes memory) {
        return _keys[owner];
    }

    function isRegistered(address owner) external view override returns (bool) {
        return _keys[owner].length > 0;
    }

    function verify(bytes calldata, bytes32, bytes calldata) external pure override returns (bool) {
        return true;
    }

    function verifyWithRegisteredKey(address, bytes32, bytes calldata)
        external
        pure
        override
        returns (bool)
    {
        return true;
    }

    function supportsAggregation() external pure override returns (bool) {
        return false;
    }

    function verifyAggregated(bytes[] calldata, bytes32[] calldata, bytes calldata)
        external
        pure
        override
        returns (bool)
    {
        revert("ECDSA does not support aggregation");
    }
}

/// @title SignatureRegistryDispatcherTest
/// @notice Tests for SignatureRegistryDispatcher contract
/// @dev Updated for permissionless design - no owner, no removeScheme
/// @custom:spec specs/009-core-refactor
contract SignatureRegistryDispatcherTest is Test {
    SignatureRegistryDispatcher public dispatcher;
    MockBLSRegistry public blsRegistry;
    MockECDSARegistry public ecdsaRegistry;

    address public alice = address(0x1);
    address public bob = address(0x2);

    uint8 constant BLS_SCHEME_ID = 0x02;
    uint8 constant ECDSA_SCHEME_ID = 0x01;

    function setUp() public {
        // Dispatcher no longer takes constructor arguments (permissionless)
        dispatcher = new SignatureRegistryDispatcher();
        blsRegistry = new MockBLSRegistry();
        ecdsaRegistry = new MockECDSARegistry();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SCHEME REGISTRATION TESTS (Permissionless)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_registerScheme_success() public {
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);

        assertTrue(dispatcher.isSchemeRegistered(BLS_SCHEME_ID));
        assertEq(address(dispatcher.registries(BLS_SCHEME_ID)), address(blsRegistry));
    }

    function test_registerScheme_emitEvent() public {
        vm.expectEmit(true, true, false, true);
        emit SignatureRegistryDispatcher.SchemeRegistered(
            BLS_SCHEME_ID, address(blsRegistry), "BLS12-381", address(this)
        );

        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);
    }

    function test_registerScheme_alreadyRegistered() public {
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);

        vm.expectRevert(
            abi.encodeWithSelector(
                SignatureRegistryDispatcher.SchemeAlreadyRegistered.selector, BLS_SCHEME_ID
            )
        );
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);
    }

    function test_registerScheme_schemeIdMismatch() public {
        // Try to register BLS registry under ECDSA scheme ID
        vm.expectRevert(
            abi.encodeWithSelector(
                SignatureRegistryDispatcher.SchemeIdMismatch.selector,
                ECDSA_SCHEME_ID,
                BLS_SCHEME_ID
            )
        );
        dispatcher.registerScheme(ECDSA_SCHEME_ID, blsRegistry);
    }

    function test_registerScheme_invalidRegistry() public {
        vm.expectRevert(
            abi.encodeWithSelector(SignatureRegistryDispatcher.InvalidRegistry.selector, address(0))
        );
        dispatcher.registerScheme(BLS_SCHEME_ID, ISignatureRegistry(address(0)));
    }

    function test_registerScheme_permissionless() public {
        // Anyone can register a scheme (first-come-first-served)
        vm.prank(alice);
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);

        assertTrue(dispatcher.isSchemeRegistered(BLS_SCHEME_ID));

        // But same scheme can't be registered twice
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignatureRegistryDispatcher.SchemeAlreadyRegistered.selector, BLS_SCHEME_ID
            )
        );
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);
    }

    function test_registerScheme_multiple() public {
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);
        dispatcher.registerScheme(ECDSA_SCHEME_ID, ecdsaRegistry);

        assertEq(dispatcher.schemeCount(), 2);

        uint8[] memory schemes = dispatcher.getRegisteredSchemes();
        assertEq(schemes.length, 2);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SCHEME IMMUTABILITY TEST
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_schemeImmutable() public {
        // Once registered, schemes cannot be removed
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);
        assertTrue(dispatcher.isSchemeRegistered(BLS_SCHEME_ID));

        // No removeScheme function exists - this is by design
        // Schemes are immutable once registered (credible neutrality)
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERY TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_getRegistry_success() public {
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);

        ISignatureRegistry registry = dispatcher.getRegistry(BLS_SCHEME_ID);
        assertEq(address(registry), address(blsRegistry));
    }

    function test_getRegistry_notRegistered() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                SignatureRegistryDispatcher.SchemeNotRegistered.selector, BLS_SCHEME_ID
            )
        );
        dispatcher.getRegistry(BLS_SCHEME_ID);
    }

    function test_schemeCount() public {
        assertEq(dispatcher.schemeCount(), 0);

        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);
        assertEq(dispatcher.schemeCount(), 1);

        dispatcher.registerScheme(ECDSA_SCHEME_ID, ecdsaRegistry);
        assertEq(dispatcher.schemeCount(), 2);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFICATION ROUTING TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_verify_routing() public {
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);

        bool valid =
            dispatcher.verify(BLS_SCHEME_ID, hex"000102030405", bytes32(0), hex"000102030405");

        assertTrue(valid);
    }

    function test_verify_schemeNotRegistered() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                SignatureRegistryDispatcher.SchemeNotRegistered.selector, BLS_SCHEME_ID
            )
        );
        dispatcher.verify(BLS_SCHEME_ID, hex"00", bytes32(0), hex"00");
    }

    function test_supportsAggregation_routing() public {
        dispatcher.registerScheme(BLS_SCHEME_ID, blsRegistry);
        dispatcher.registerScheme(ECDSA_SCHEME_ID, ecdsaRegistry);

        assertTrue(dispatcher.supportsAggregation(BLS_SCHEME_ID));
        assertFalse(dispatcher.supportsAggregation(ECDSA_SCHEME_ID));
    }
}
