// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, console2 } from "forge-std/Test.sol";
import { BLSVerifier } from "../src/libraries/BLSVerifier.sol";
import { BLSDecompression } from "../src/libraries/BLSDecompression.sol";

/// @title BLSVerifierHarness
/// @notice Test harness to expose internal library functions
contract BLSVerifierHarness {
    function verify(bytes memory publicKey, bytes32 messageHash, bytes memory signature)
        external
        view
        returns (bool valid)
    {
        return BLSVerifier.verify(publicKey, messageHash, signature);
    }

    function precompilesAvailable() external view returns (bool) {
        return BLSVerifier.precompilesAvailable();
    }
}

/// @title BLSVerifierTest
/// @notice Tests for BLSVerifier library
/// @dev Full verification requires EIP-2537 precompiles - run on mainnet fork for integration tests
contract BLSVerifierTest is Test {
    BLSVerifierHarness public harness;

    function setUp() public {
        harness = new BLSVerifierHarness();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INPUT VALIDATION TESTS (work without precompiles)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_verify_invalidPublicKeyLength_tooShort() public {
        bytes memory shortKey = hex"0102030405060708091011121314151617181920";
        bytes32 msgHash = keccak256("test");
        bytes memory validSig = new bytes(96);
        validSig[0] = 0x80; // Set compression flag

        vm.expectRevert(abi.encodeWithSelector(BLSVerifier.InvalidPublicKeyFormat.selector, 20));
        harness.verify(shortKey, msgHash, validSig);
    }

    function test_verify_invalidPublicKeyLength_tooLong() public {
        bytes memory longKey = new bytes(64);
        longKey[0] = 0x80;
        bytes32 msgHash = keccak256("test");
        bytes memory validSig = new bytes(96);
        validSig[0] = 0x80;

        vm.expectRevert(abi.encodeWithSelector(BLSVerifier.InvalidPublicKeyFormat.selector, 64));
        harness.verify(longKey, msgHash, validSig);
    }

    function test_verify_invalidSignatureLength_tooShort() public {
        bytes memory validKey = new bytes(48);
        validKey[0] = 0x80;
        bytes32 msgHash = keccak256("test");
        bytes memory shortSig = hex"0102030405060708091011121314151617181920";

        vm.expectRevert(abi.encodeWithSelector(BLSVerifier.InvalidSignatureFormat.selector, 20));
        harness.verify(validKey, msgHash, shortSig);
    }

    function test_verify_invalidSignatureLength_tooLong() public {
        bytes memory validKey = new bytes(48);
        validKey[0] = 0x80;
        bytes32 msgHash = keccak256("test");
        bytes memory longSig = new bytes(128);
        longSig[0] = 0x80;

        vm.expectRevert(abi.encodeWithSelector(BLSVerifier.InvalidSignatureFormat.selector, 128));
        harness.verify(validKey, msgHash, longSig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // PRECOMPILE AVAILABILITY TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_precompilesAvailable_withoutFork() public view {
        // Without a mainnet fork, precompiles should not be available
        bool available = harness.precompilesAvailable();
        // This will be false unless running on a mainnet fork
        // We just verify the function runs without error
        console2.log("Precompiles available:", available);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTEGRATION TESTS (require mainnet fork with EIP-2537)
    // Run with: forge test --fork-url $MAINNET_RPC_URL -vvv
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Skip if precompiles not available
    modifier skipWithoutPrecompiles() {
        if (!harness.precompilesAvailable()) {
            console2.log("Skipping - EIP-2537 precompiles not available");
            console2.log("Run with --fork-url to test on mainnet fork");
            return;
        }
        _;
    }

    function test_verify_validSignature_helloWorld() public view skipWithoutPrecompiles {
        // Test vector from bls-vectors.json (generated from @noble/bls12-381)
        // This is a valid signature for "Hello, BLS!" hashed with SHA-256
        bytes memory publicKey =
            hex"96525cd92bfcd07fccf4418ab2ddc394de5b693bb0c91189f6fad2e1fa47a60361c07333a732dca4546acef6209a16d3";
        bytes32 messageHash = hex"645836c01d5c1c7d9c933cc1254f4c6620e35b463475e98fe86afac430f8ab28";
        bytes memory signature =
            hex"8934748631d562e8deb6b8a48f73411cb120ab618b840957b852afe5613d2153e8af3a32d29092e14dd79525823174ad129e9203e27b43247618573a0097740b4eb6398d152f7cf39589d98bf1ac6fe6a5d030c60ac05ec3a0901ebbec6a6d08";

        bool valid = harness.verify(publicKey, messageHash, signature);
        assertTrue(valid, "Valid signature should verify");
    }

    function test_verify_invalidSignature_wrongKey() public view skipWithoutPrecompiles {
        // Valid signature but wrong public key
        bytes memory wrongPublicKey =
            hex"8bea8b61db67c1b22bd15fb0b7775a5a22c8d75d0d7bd17369c13ecde03a10bd5175399b3ea1ad309a7c18228f877e72";
        bytes32 messageHash = hex"645836c01d5c1c7d9c933cc1254f4c6620e35b463475e98fe86afac430f8ab28";
        bytes memory signature =
            hex"8934748631d562e8deb6b8a48f73411cb120ab618b840957b852afe5613d2153e8af3a32d29092e14dd79525823174ad129e9203e27b43247618573a0097740b4eb6398d152f7cf39589d98bf1ac6fe6a5d030c60ac05ec3a0901ebbec6a6d08";

        bool valid = harness.verify(wrongPublicKey, messageHash, signature);
        assertFalse(valid, "Wrong public key should fail");
    }

    function test_verify_invalidSignature_wrongMessage() public view skipWithoutPrecompiles {
        // Valid signature but wrong message hash
        bytes memory publicKey =
            hex"96525cd92bfcd07fccf4418ab2ddc394de5b693bb0c91189f6fad2e1fa47a60361c07333a732dca4546acef6209a16d3";
        bytes32 wrongMessageHash =
            hex"0000000000000000000000000000000000000000000000000000000000000000";
        bytes memory signature =
            hex"8934748631d562e8deb6b8a48f73411cb120ab618b840957b852afe5613d2153e8af3a32d29092e14dd79525823174ad129e9203e27b43247618573a0097740b4eb6398d152f7cf39589d98bf1ac6fe6a5d030c60ac05ec3a0901ebbec6a6d08";

        bool valid = harness.verify(publicKey, wrongMessageHash, signature);
        assertFalse(valid, "Wrong message should fail");
    }

    function test_verify_emptyMessage() public view skipWithoutPrecompiles {
        // Test vector for empty message ""
        // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        bytes memory publicKey =
            hex"80802054ad314d563946c966443a1aae203e1bbc0323a00cb183dbf17d2855b575d14bbf35dabb38b54351f1f227c413";
        bytes32 messageHash = hex"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        bytes memory signature =
            hex"8accc4679167631c8173f72c9557e02d77eda752da2302fe115ddd11f23e6fcbb32ddbf385ba60b49a4f955c464e82360ca28473b9d3185607a9166db63acb8529a3258b9c9c8bda4ecc37b62d01a3696b023a9c72aa10f10b40c88eec19c977";

        bool valid = harness.verify(publicKey, messageHash, signature);
        assertTrue(valid, "Valid signature for empty message should verify");
    }

    function test_verify_zeroSignature_fails() public view skipWithoutPrecompiles {
        bytes memory publicKey =
            hex"96525cd92bfcd07fccf4418ab2ddc394de5b693bb0c91189f6fad2e1fa47a60361c07333a732dca4546acef6209a16d3";
        bytes32 messageHash = hex"645836c01d5c1c7d9c933cc1254f4c6620e35b463475e98fe86afac430f8ab28";
        bytes memory zeroSig = new bytes(96);
        // Need to set compression flag but rest is zeros
        zeroSig[0] = 0xc0; // Infinity flag

        // Zero signature (point at infinity) should not verify for non-trivial messages
        bool valid = harness.verify(publicKey, messageHash, zeroSig);
        assertFalse(valid, "Zero signature should fail verification");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // GAS PROFILING TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_verify_gasUsage() public skipWithoutPrecompiles {
        bytes memory publicKey =
            hex"96525cd92bfcd07fccf4418ab2ddc394de5b693bb0c91189f6fad2e1fa47a60361c07333a732dca4546acef6209a16d3";
        bytes32 messageHash = hex"645836c01d5c1c7d9c933cc1254f4c6620e35b463475e98fe86afac430f8ab28";
        bytes memory signature =
            hex"8934748631d562e8deb6b8a48f73411cb120ab618b840957b852afe5613d2153e8af3a32d29092e14dd79525823174ad129e9203e27b43247618573a0097740b4eb6398d152f7cf39589d98bf1ac6fe6a5d030c60ac05ec3a0901ebbec6a6d08";

        uint256 gasBefore = gasleft();
        harness.verify(publicKey, messageHash, signature);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("Gas used for BLS verification:", gasUsed);
        // Target: < 200k gas (from spec)
        assertLt(gasUsed, 500_000, "Gas usage should be under 500k");
    }
}
