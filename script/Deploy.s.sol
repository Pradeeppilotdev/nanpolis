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
        vm.writeJson(json, "./deployments.json");

        console.log("Wrote deployments.json (chainId %s)", block.chainid);
    }
}
