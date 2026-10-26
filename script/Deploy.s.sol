// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/ExitGuard.sol";

/// @notice Deploys ExitGuard only. The guarded position is a real mainnet asset
/// (WMON), so no mock token is deployed.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        ExitGuard g = new ExitGuard();
        vm.stopBroadcast();

        console.log("ExitGuard:", address(g));

        string memory obj = "deployments";
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory json = vm.serializeAddress(obj, "exitGuard", address(g));
        // Preserve the historical verified deployment and its asset/wallet metadata.
        // Promote this candidate in application config only after a real broadcast
        // receipt and verification; a dry run must not replace the active address.
        vm.writeJson(json, "./deployments.json", ".latestDeploymentCandidate");

        console.log("Wrote latestDeploymentCandidate (chainId %s); verify before activating", block.chainid);
    }
}
