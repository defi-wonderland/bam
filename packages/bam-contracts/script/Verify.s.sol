// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { SocialBlobsCore } from "../src/core/SocialBlobsCore.sol";
import { BLSRegistry } from "../src/core/BLSRegistry.sol";
import { BLSExposer } from "../src/exposers/BLSExposer.sol";
import { SimpleBoolVerifier } from "../src/verifiers/SimpleBoolVerifier.sol";
import { ISocialBlobsCore } from "../src/interfaces/ISocialBlobsCore.sol";
import { IBLSRegistry } from "../src/interfaces/IBLSRegistry.sol";
import { IRegistrationVerifier } from "../src/interfaces/IRegistrationVerifier.sol";

/// @title VerifyDeployment
/// @notice Post-deployment verification script following Wonderland patterns
/// @dev Run after deployment to verify contracts are functioning correctly
contract VerifyDeployment is Script {
    // Contract addresses to verify (set via environment or constructor)
    address public coreAddress;
    address public blsRegistryAddress;
    address public blsExposerAddress;

    // Verification results
    uint256 public totalChecks;
    uint256 public passedChecks;
    string[] public failedChecks;

    /// @notice Main verification entry point
    /// @dev Reads contract addresses from environment variables
    function run() external {
        // Load addresses from environment
        coreAddress = vm.envAddress("SOCIAL_BLOBS_CORE");
        blsRegistryAddress = vm.envAddress("BLS_REGISTRY");
        blsExposerAddress = vm.envAddress("BLS_EXPOSER");

        console2.log("=== Social-Blobs Deployment Verification ===");
        console2.log("Network:", _getNetworkName());
        console2.log("Block:", block.number);
        console2.log("");

        // Run all verification checks
        _verifyCore();
        _verifyBLSRegistry();
        _verifyBLSExposer();
        _verifyIntegration();

        // Print summary
        _printSummary();
    }

    /// @notice Verify with explicit addresses (for scripting)
    function verify(address _core, address _blsRegistry, address _blsExposer) external {
        coreAddress = _core;
        blsRegistryAddress = _blsRegistry;
        blsExposerAddress = _blsExposer;

        console2.log("=== Social-Blobs Deployment Verification ===");
        console2.log("Network:", _getNetworkName());
        console2.log("");

        _verifyCore();
        _verifyBLSRegistry();
        _verifyBLSExposer();
        _verifyIntegration();

        _printSummary();
    }

    // =========================================================================
    // Verification Functions
    // =========================================================================

    function _verifyCore() internal {
        console2.log("--- Verifying SocialBlobsCore ---");

        // Check contract exists
        _check("Core: Contract deployed", coreAddress.code.length > 0);

        // Verify no owner (permissionless)
        (bool success,) = coreAddress.staticcall(abi.encodeWithSignature("owner()"));
        _check("Core: Permissionless (no owner)", !success);

        // Verify stateless: no totalBlobs or getBlob functions
        (bool hasTotalBlobs,) = coreAddress.staticcall(abi.encodeWithSignature("totalBlobs()"));
        _check("Core: Stateless (no totalBlobs)", !hasTotalBlobs);

        console2.log("");
    }

    function _verifyBLSRegistry() internal {
        console2.log("--- Verifying BLSRegistry ---");

        // Check contract exists
        _check("BLSRegistry: Contract deployed", blsRegistryAddress.code.length > 0);

        // Check known functions
        try BLSRegistry(blsRegistryAddress).totalRegistered() returns (uint256 count) {
            _check("BLSRegistry: totalRegistered() callable", true);
            console2.log("  Registered keys:", count);
        } catch {
            _check("BLSRegistry: totalRegistered() callable", false);
        }

        // Verify permissionless
        (bool success,) = blsRegistryAddress.staticcall(abi.encodeWithSignature("owner()"));
        _check("BLSRegistry: Permissionless (no owner)", !success);

        console2.log("");
    }

    function _verifyBLSExposer() internal {
        console2.log("--- Verifying BLSExposer ---");

        // Check contract exists
        _check("BLSExposer: Contract deployed", blsExposerAddress.code.length > 0);

        BLSExposer exposer = BLSExposer(blsExposerAddress);

        // Verify core reference
        try exposer.core() returns (ISocialBlobsCore core) {
            _check("BLSExposer: core() returns correct address", address(core) == coreAddress);
            console2.log("  Core address:", address(core));
        } catch {
            _check("BLSExposer: core() callable", false);
        }

        // Verify BLS registry reference
        try exposer.blsRegistry() returns (IBLSRegistry registry) {
            _check(
                "BLSExposer: blsRegistry() returns correct address",
                address(registry) == blsRegistryAddress
            );
            console2.log("  BLS Registry:", address(registry));
        } catch {
            _check("BLSExposer: blsRegistry() callable", false);
        }

        // Verify registration verifier reference
        try exposer.registrationVerifier() returns (IRegistrationVerifier verifier) {
            _check("BLSExposer: registrationVerifier() set", address(verifier) != address(0));
            console2.log("  Registration Verifier:", address(verifier));
        } catch {
            _check("BLSExposer: registrationVerifier() callable", false);
        }

        console2.log("");
    }

    function _verifyIntegration() internal {
        console2.log("--- Verifying Integration ---");

        // Test that BLSExposer references correct Core
        try BLSExposer(blsExposerAddress).core() returns (ISocialBlobsCore core) {
            _check("Integration: Exposer -> Core connection", address(core) == coreAddress);
        } catch {
            _check("Integration: Exposer -> Core connection", false);
        }

        console2.log("");
    }

    // =========================================================================
    // Helper Functions
    // =========================================================================

    function _check(string memory name, bool passed) internal {
        totalChecks++;
        if (passed) {
            passedChecks++;
            console2.log(unicode"  ✓", name);
        } else {
            failedChecks.push(name);
            console2.log(unicode"  ✗", name);
        }
    }

    function _printSummary() internal view {
        console2.log("=== Verification Summary ===");
        console2.log("Total checks:", totalChecks);
        console2.log("Passed:", passedChecks);
        console2.log("Failed:", totalChecks - passedChecks);
        console2.log("");

        if (passedChecks == totalChecks) {
            console2.log(unicode"✓ ALL CHECKS PASSED - Deployment verified!");
        } else {
            console2.log(unicode"✗ VERIFICATION FAILED");
            console2.log("Failed checks:");
            for (uint256 i = 0; i < failedChecks.length; i++) {
                console2.log("  -", failedChecks[i]);
            }
        }
    }

    function _getNetworkName() internal view returns (string memory) {
        if (block.chainid == 11_155_111) return "Sepolia";
        if (block.chainid == 17_000) return "Holesky";
        if (block.chainid == 1) return "Mainnet";
        if (block.chainid == 31_337) return "Anvil (local)";
        return "Unknown";
    }
}

/// @title HealthCheck
/// @notice Lightweight health check for monitoring
/// @dev Can be called periodically to verify system health
contract HealthCheck is Script {
    function run() external view {
        address coreAddress = vm.envAddress("SOCIAL_BLOBS_CORE");

        console2.log("=== Health Check ===");
        console2.log("Network:", block.chainid);
        console2.log("Block:", block.number);

        // Check Core is deployed and has code
        bool healthy = coreAddress.code.length > 0;

        if (healthy) {
            console2.log("Core contract deployed at:", coreAddress);
            console2.log(unicode"Status: ✓ HEALTHY");
        } else {
            console2.log("ERROR: Core not deployed");
            console2.log(unicode"Status: ✗ UNHEALTHY");
            revert("Health check failed");
        }
    }
}
